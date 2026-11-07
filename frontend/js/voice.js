/* CQA — голос оператора в звонке: замер по записи, БЕЗ ИИ. Звук никуда не отправляется.
   На оценку по чек-листу и results.json не влияет — подсказка для того, кто слушает звонок.

   Одни и те же слова можно сказать спокойно или резко — по тексту это не видно.
   Громкость мало что говорит (зависит от микрофона и линии), тон слышен в ИНТОНАЦИИ —
   в том, как движется высота голоса внутри фразы. Для каждой реплики оператора меряем
   и сравниваем с ОБЫЧНОЙ манерой этого оператора в этом же звонке:
     - мелодию фразы в полутонах (не зависит от того, низкий голос или высокий):
         размах мелодии и её живость → «монотонно» / «интонация скачет»;
         куда идёт голос в конце фразы → «резкое окончание» (голос резко падает и звук обрывается);
     - высоту голоса → «голос выше обычного»;
     - громкость — только вместе со скачками или высотой → «напряжённо»;
     - темп речи (слов в секунду звучания) и паузу перед ответом после клиента.
   Это не «эмоции», а измеримые признаки: где они резко отличаются, стоит послушать запись.
   Запись моно: если клиент говорит одновременно с оператором, замер может ошибиться.

   Чистые функции без DOM: работают в браузере (window.CQA.voice) и в тестах Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.CQA = root.CQA || {}; root.CQA.voice = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FRAME = 0.04;           // окно анализа, с
  var HOP = 0.02;             // шаг, с
  var TARGET_SR = 8000;       // для поиска высоты голоса (телефонный звук и так 8 кГц)
  var F0_MIN = 75, F0_MAX = 400;

  var LOUD_DB = 5;            // громче обычного (только в сочетании с интонацией)
  var FAST = 1.4, SLOW = 0.6; // темп относительно обычного
  var HIGH = 1.18;            // высота голоса относительно обычной
  var PAUSE_SEC = 7;          // пауза перед ответом
  var MIN_VOICED = 0.8;       // реплика короче (по звучанию) в сравнении не участвует
  var MIN_WORDS = 3;
  var RATE_MIN = 1.0, RATE_MAX = 6.0;   // вне этого — реплика неточно легла на запись, темп не считаем
  var F0_RATIO_MAX = 1.8;     // больше — почти всегда ошибка на октаву, а не голос
  var MIN_F0_FRAMES = 5;
  var MASKED = /\[[^\]]*скрыт[^\]]*\]/i;   // «[Имя скрыто]», «[Персональные данные скрыты]» — слов в тексте меньше, чем сказано

  // интонация
  var MIN_CONTOUR = 12;       // точек мелодии в реплике (~0,25 с тонального звука), иначе не судим
  var MONO_VOICED = 1.5;      // «монотонно» — только для фраз подлиннее (короткие и так ровные)
  var MONO_RATIO = 0.5;       // размах меньше половины обычного
  var MONO_MIN_USUAL = 2.5;   // если оператор и так говорит ровно — «монотонно» не ставим
  var JUMPY_RATIO = 1.8;      // размах или живость почти вдвое больше обычного
  var END_WINDOW = 0.5;       // окончание фразы — последние 0,5 с звучания
  var END_FALL = -14;         // полутонов в секунду: голос резко падает…
  var END_DROP_DB = 15;       // …и звук обрывается (громкость падает за 40 мс)
  var END_RISE = 12;          // подъём в конце утверждения

  function median(xs) {
    if (!xs.length) return null;
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function quantile(xs, q) {
    if (!xs.length) return null;
    var s = xs.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  }
  function semitones(f, base) { return 12 * Math.log(f / base) / Math.LN2; }
  function round1(x) { return x === null || x === undefined ? null : Math.round(x * 10) / 10; }

  function wordsIn(text) {
    var m = String(text || '').match(/[\p{L}\p{N}]+/gu);
    return m ? m.length : 0;
  }

  /** Понижаем частоту усреднением (достаточно для речи в телефонном качестве). */
  function downsample(samples, sr) {
    var k = Math.max(1, Math.round(sr / TARGET_SR));
    var n = Math.floor(samples.length / k);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var s = 0;
      for (var j = 0; j < k; j++) s += samples[i * k + j];
      out[i] = s / k;
    }
    return { x: out, sr: sr / k };
  }

  /** Громкость по кадрам (дБ) и порог «есть речь» — как при сверке текста со звуком. */
  function frames(x, sr) {
    var len = Math.round(FRAME * sr), hop = Math.round(HOP * sr);
    var n = Math.max(0, Math.floor((x.length - len) / hop) + 1);
    var db = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = i * hop, s = 0;
      for (var j = 0; j < len; j++) s += x[a + j] * x[a + j];
      db[i] = 10 * Math.log10(s / len + 1e-10);
    }
    var sorted = Array.prototype.slice.call(db).sort(function (p, q) { return p - q; });
    var p20 = sorted[Math.floor(n * 0.2)] || -100, p95 = sorted[Math.floor(n * 0.95)] || -100;
    return { db: db, thr: p20 + Math.max(10, (p95 - p20) * 0.35), len: len, hop: hop };
  }

  /** Основной тон кадра автокорреляцией; null — если голос не тональный (шум, согласные). */
  function pitchAt(x, sr, a, len) {
    var minLag = Math.floor(sr / F0_MAX), maxLag = Math.min(len - 1, Math.ceil(sr / F0_MIN));
    var mean = 0;
    for (var i = 0; i < len; i++) mean += x[a + i];
    mean /= len;
    var e0 = 0;
    for (i = 0; i < len; i++) { var v = x[a + i] - mean; e0 += v * v; }
    if (e0 <= 1e-9) return null;
    var rs = [];
    var best = 0;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var s = 0, e1 = 0, e2 = 0;
      for (i = 0; i + lag < len; i++) {
        var p = x[a + i] - mean, q = x[a + i + lag] - mean;
        s += p * q; e1 += p * p; e2 += q * q;
      }
      var r = s / Math.sqrt(e1 * e2 + 1e-12);
      rs.push(r);
      if (r > best) best = r;
    }
    if (best <= 0.5) return null;
    // Двойной период коррелирует так же сильно, как сам период, — берём самый короткий
    // из почти лучших (локальный максимум), иначе голос «падает» на октаву вниз.
    for (var k = 0; k < rs.length; k++) {
      var isPeak = (k === 0 || rs[k] >= rs[k - 1]) && (k === rs.length - 1 || rs[k] >= rs[k + 1]);
      if (isPeak && rs[k] >= best * 0.9) return sr / (minLag + k);
    }
    return null;
  }

  /** Признаки одного отрезка записи [start, end]; withPitch — мелодия по каждому кадру. */
  function measure(x, sr, fr, start, end, withPitch) {
    var i0 = Math.max(0, Math.floor(start / HOP)), i1 = Math.min(fr.db.length, Math.ceil(end / HOP));
    var voiced = 0, dbs = [], track = [], first = null, last = null, lastIdx = -1;
    for (var i = i0; i < i1; i++) {
      if (fr.db[i] <= fr.thr) continue;
      voiced++;
      dbs.push(fr.db[i]);
      if (first === null) first = i * HOP;
      last = i * HOP + FRAME;
      lastIdx = i;
      if (withPitch) { var f = pitchAt(x, sr, i * fr.hop, fr.len); if (f) track.push({ t: i * HOP, f: f }); }
    }
    // как обрывается звук в конце: насколько падает громкость за 40 мс после последнего звучащего кадра
    var drop = null;
    if (lastIdx >= 0 && lastIdx + 2 < fr.db.length) drop = fr.db[lastIdx] - fr.db[lastIdx + 2];
    var f0s = track.map(function (p) { return p.f; });
    return { voiced: voiced * HOP, db: median(dbs), f0: f0s.length >= MIN_F0_FRAMES ? median(f0s) : null, track: track, first: first, last: last, drop: drop };
  }

  /**
   * Мелодия фразы в полутонах от обычной высоты оператора: убираем выбросы (ошибки на октаву,
   * чужой голос), сглаживаем медианой по 3 точкам.
   */
  function contourOf(track, base) {
    if (!track.length || !base) return [];
    var st = track.map(function (p) { return { t: p.t, s: semitones(p.f, base) }; });
    var med = median(st.map(function (p) { return p.s; }));
    st = st.filter(function (p) { return Math.abs(p.s - med) <= 7; });
    return st.map(function (p, k) {
      var w = [st[k - 1], p, st[k + 1]].filter(Boolean).map(function (q) { return q.s; });
      return { t: p.t, s: median(w) };
    });
  }

  /** Размах (полутона, 10–90%), живость (полутона в секунду) и наклон в конце фразы. */
  function intonation(contour) {
    if (contour.length < MIN_CONTOUR) return null;
    var ss = contour.map(function (p) { return p.s; });
    var range = quantile(ss, 0.9) - quantile(ss, 0.1);
    var moves = [];
    for (var k = 1; k < contour.length; k++) {
      var dt = contour[k].t - contour[k - 1].t;
      var ds = Math.abs(contour[k].s - contour[k - 1].s);
      if (dt > 0 && dt <= 0.061 && ds < 4) moves.push(ds / dt);
    }
    var tEnd = contour[contour.length - 1].t;
    var tail = contour.filter(function (p) { return p.t >= tEnd - END_WINDOW; });
    var slope = null;
    if (tail.length >= 6) {
      var mt = 0, ms = 0;
      tail.forEach(function (p) { mt += p.t; ms += p.s; });
      mt /= tail.length; ms /= tail.length;
      var num = 0, den = 0;
      tail.forEach(function (p) { num += (p.t - mt) * (p.s - ms); den += (p.t - mt) * (p.t - mt); });
      slope = den > 0 ? num / den : null;
    }
    return { range: range, speed: median(moves), slope: slope };
  }

  /** Мелодия для мини-графика: не больше 60 точек. */
  function sparkOf(contour) {
    if (!contour.length) return [];
    var step = Math.max(1, Math.ceil(contour.length / 60));
    var out = [];
    for (var k = 0; k < contour.length; k += step) out.push(round1(contour[k].s));
    return out;
  }

  function flag(type, level, text, detail) { return { type: type, level: level, text: text, detail: detail }; }
  function num1(x) { return Number(x).toFixed(1).replace('.', ','); }

  /**
   * @param samples   Float32Array — запись (один канал)
   * @param sampleRate частота
   * @param transcript реплики [{speaker, text}]
   * @param spans     [{start, end} | null] — где реплика в записи (TL.buildAudioMap после сверки)
   * @param opts.holds [[start, end]] — удержание (пауза там нормальна)
   * @returns {{ baseline, enough, turns: { [i]: {...} }, flagged: [i], summary }}
   */
  function analyze(samples, sampleRate, transcript, spans, opts) {
    var holds = (opts && opts.holds) || [];
    var ds = downsample(samples, sampleRate);
    var fr = frames(ds.x, ds.sr);
    var turns = {};
    var raw = {};
    var lastOther = null;   // конец речи клиента перед текущей репликой оператора
    (transcript || []).forEach(function (t, i) {
      // бот (автоответчик) или системное событие между клиентом и оператором — это ожидание соединения, а не пауза оператора
      if (t.speaker === 'bot' || t.speaker === 'system') { lastOther = null; return; }
      var s = spans && spans[i];
      if (!s) return;
      if (t.speaker === 'client') {
        var mc = measure(ds.x, ds.sr, fr, s.start, s.end, false);
        if (mc.last !== null) lastOther = mc.last;
        return;
      }
      if (t.speaker !== 'operator') return;
      var m = measure(ds.x, ds.sr, fr, s.start, s.end, true);
      var words = wordsIn(t.text);
      var rate = m.voiced >= MIN_VOICED && words >= MIN_WORDS && !MASKED.test(t.text) ? words / m.voiced : null;
      if (rate !== null && (rate < RATE_MIN || rate > RATE_MAX)) rate = null;
      // реплика во время удержания — оператор говорит с коллегами, клиент её не слышит: не сравниваем
      var onHold = holds.some(function (h) { return s.start >= h[0] && s.end <= h[1]; });
      var row = {
        i: i, words: words, voiced: round1(m.voiced),
        db: round1(m.db), f0: m.f0 === null ? null : Math.round(m.f0),
        rate: rate === null ? null : Math.round(rate * 100) / 100,
        gap: null, flags: [], on_hold: onHold,
        question: /\?\s*$/.test(String(t.text || '').trim()),
        range: null, speed: null, end_slope: null, end_drop: round1(m.drop), spark: [],
      };
      if (lastOther !== null && m.first !== null && m.first > lastOther) {
        var g = m.first - lastOther;
        var inHold = holds.some(function (h) { return lastOther < h[1] && m.first > h[0]; });
        if (!inHold) row.gap = round1(g);
      }
      lastOther = null;
      turns[i] = row;
      raw[i] = m;
    });

    var rows = Object.keys(turns).map(function (k) { return turns[k]; });
    var usable = rows.filter(function (r) { return !r.on_hold && r.voiced >= MIN_VOICED && r.words >= MIN_WORDS; });
    var baseF0 = median(usable.map(function (r) { return r.f0; }).filter(function (v) { return v !== null; }));

    // интонация каждой реплики — в полутонах от обычной высоты оператора
    rows.forEach(function (r) {
      var c = contourOf(raw[r.i].track, baseF0);
      var it = intonation(c);
      if (it) { r.range = round1(it.range); r.speed = round1(it.speed); r.end_slope = round1(it.slope); }
      r.spark = sparkOf(c);
    });
    var withInt = usable.filter(function (r) { return r.range !== null; });

    var baseline = {
      db: median(usable.map(function (r) { return r.db; }).filter(function (v) { return v !== null; })),
      rate: median(usable.map(function (r) { return r.rate; }).filter(function (v) { return v !== null; })),
      f0: baseF0,
      range: round1(median(withInt.map(function (r) { return r.range; }))),
      speed: round1(median(withInt.map(function (r) { return r.speed; }).filter(function (v) { return v !== null; }))),
      turns: usable.length,
    };
    var enough = usable.length >= 3;
    var enoughInt = withInt.length >= 3;

    rows.forEach(function (r) {
      if (r.on_hold) return;
      var ok = r.voiced >= MIN_VOICED && r.words >= MIN_WORDS;
      var hasInt = enoughInt && ok && r.range !== null;
      var loud = enough && ok && r.db !== null && baseline.db !== null && r.db - baseline.db >= LOUD_DB;
      var jumpy = hasInt && baseline.range > 0 && (r.range >= baseline.range * JUMPY_RATIO ||
        (r.speed !== null && baseline.speed > 0 && r.speed >= baseline.speed * JUMPY_RATIO));
      var high = enough && ok && r.f0 !== null && baseline.f0 && r.f0 >= baseline.f0 * HIGH && r.f0 <= baseline.f0 * F0_RATIO_MAX;

      if (hasInt && r.voiced >= MONO_VOICED && baseline.range >= MONO_MIN_USUAL && r.range <= baseline.range * MONO_RATIO) {
        r.flags.push(flag('mono', 'info', 'монотонно', 'размах ' + num1(r.range) + ' пт, обычно ' + num1(baseline.range)));
      }
      if (jumpy) r.flags.push(flag('jumpy', 'warn', 'интонация скачет', 'размах ' + num1(r.range) + ' пт, обычно ' + num1(baseline.range)));
      if (high) r.flags.push(flag('high', 'warn', 'голос выше обычного', '+' + Math.round((r.f0 / baseline.f0 - 1) * 100) + '%'));
      if (hasInt && r.end_slope !== null && r.end_slope <= END_FALL && r.end_drop !== null && r.end_drop >= END_DROP_DB) {
        r.flags.push(flag('cut', 'warn', 'резкое окончание', 'голос падает ' + Math.round(-r.end_slope) + ' пт/с и обрывается'));
      }
      // «Подъём в конце» не отмечаем: на записях DEV он почти всегда в обычных просьбах и перечислениях
      // («подскажите, пожалуйста…») — в русской речи это норма. Наклон окончания остаётся в данных (end_slope).
      if (enough && ok && r.rate !== null && baseline.rate) {
        if (r.rate >= baseline.rate * FAST) r.flags.push(flag('fast', 'info', 'быстрее обычного', num1(r.rate) + ' сл/с'));
        else if (r.rate <= baseline.rate * SLOW) r.flags.push(flag('slow', 'info', 'медленнее обычного', num1(r.rate) + ' сл/с'));
      }
      if (r.gap !== null && r.gap >= PAUSE_SEC) r.flags.push(flag('pause', 'info', 'пауза перед ответом', Math.round(r.gap) + ' с'));
      // громкость сама по себе не показатель тона — только вместе со скачками интонации или высотой
      if (loud && (jumpy || high)) {
        r.tense = true;
        r.flags.push(flag('loud', 'warn', 'громче обычного', '+' + Math.round(r.db - baseline.db) + ' дБ'));
      }
    });

    var count = function (type) { return rows.filter(function (r) { return r.flags.some(function (f) { return f.type === type; }); }).length; };
    var flagged = rows.filter(function (r) { return r.flags.length; }).map(function (r) { return r.i; });
    return {
      baseline: baseline,
      enough: enough,
      enough_intonation: enoughInt,
      turns: turns,
      flagged: flagged,
      summary: {
        operator_turns: rows.length,
        mono: count('mono'), jumpy: count('jumpy'), cut: count('cut'), rise: count('rise'), high: count('high'),
        tense: rows.filter(function (r) { return r.tense; }).length,
        fast: count('fast'), slow: count('slow'), pauses: count('pause'),
      },
    };
  }

  return {
    analyze: analyze, wordsIn: wordsIn, median: median, semitones: semitones,
    _pitchAt: pitchAt, _downsample: downsample, _intonation: intonation, _contourOf: contourOf,
    LIMITS: { LOUD_DB: LOUD_DB, FAST: FAST, SLOW: SLOW, HIGH: HIGH, PAUSE_SEC: PAUSE_SEC, MONO_RATIO: MONO_RATIO, JUMPY_RATIO: JUMPY_RATIO, END_FALL: END_FALL, END_RISE: END_RISE },
  };
}));
