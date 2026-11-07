/* CQA — голос оператора в звонке: замер по записи, БЕЗ ИИ. Звук никуда не отправляется.

   Одни и те же слова можно сказать спокойно или раздражённо — по тексту это не видно.
   Поэтому для каждой реплики оператора меряем физику звука и сравниваем с ОБЫЧНЫМ для этого
   оператора в этом же звонке (медиана по его репликам):
     - громкость (дБ) — «повысил голос»;
     - темп речи (слов в секунду звучания) — «тараторит» / «очень медленно»;
     - высота голоса (основной тон, Гц) — голос выше обычного часто бывает при напряжении;
     - пауза перед ответом после клиента (кроме удержания).
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

  var LOUD_DB = 5;            // на сколько дБ громче обычного — «громче»
  var FAST = 1.4, SLOW = 0.6; // темп относительно обычного
  var HIGH = 1.18;            // высота голоса относительно обычной
  var PAUSE_SEC = 7;          // пауза перед ответом
  var MIN_VOICED = 0.8;       // реплика короче (по звучанию) в сравнении не участвует
  var MIN_WORDS = 3;
  var RATE_MIN = 1.0, RATE_MAX = 6.0;   // вне этого — реплика неточно легла на запись, темп не считаем
  var F0_RATIO_MAX = 1.8;     // больше — почти всегда ошибка на октаву, а не голос
  var MIN_F0_FRAMES = 5;
  var MASKED = /\[[^\]]*скрыт[^\]]*\]/i;   // «[Имя скрыто]», «[Персональные данные скрыты]» — слов в тексте меньше, чем сказано

  function median(xs) {
    if (!xs.length) return null;
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

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

  /** Признаки одного отрезка записи [start, end]. */
  function measure(x, sr, fr, start, end) {
    var i0 = Math.max(0, Math.floor(start / HOP)), i1 = Math.min(fr.db.length, Math.ceil(end / HOP));
    var voiced = 0, dbs = [], f0s = [], first = null, last = null;
    for (var i = i0; i < i1; i++) {
      if (fr.db[i] <= fr.thr) continue;
      voiced++;
      dbs.push(fr.db[i]);
      if (first === null) first = i * HOP;
      last = i * HOP + FRAME;
      if (i % 2 === 0) { var f = pitchAt(x, sr, i * fr.hop, fr.len); if (f) f0s.push(f); }   // каждый второй кадр — достаточно
    }
    return { voiced: voiced * HOP, db: median(dbs), f0: f0s.length >= MIN_F0_FRAMES ? median(f0s) : null, first: first, last: last };
  }

  /**
   * @param samples   Float32Array — запись (один канал)
   * @param sampleRate частота
   * @param transcript реплики [{speaker, text}]
   * @param spans     [{start, end} | null] — где реплика в записи (TL.buildAudioMap после сверки)
   * @param opts.holds [[start, end]] — удержание (пауза там нормальна)
   * @returns {{ baseline, turns: { [i]: {...} }, flagged: [i], summary }}
   */
  function analyze(samples, sampleRate, transcript, spans, opts) {
    var holds = (opts && opts.holds) || [];
    var ds = downsample(samples, sampleRate);
    var fr = frames(ds.x, ds.sr);
    var turns = {};
    var lastOther = null;   // конец речи клиента перед текущей репликой оператора
    (transcript || []).forEach(function (t, i) {
      // бот (автоответчик) или системное событие между клиентом и оператором — это ожидание соединения, а не пауза оператора
      if (t.speaker === 'bot' || t.speaker === 'system') { lastOther = null; return; }
      var s = spans && spans[i];
      if (!s) return;
      if (t.speaker === 'client') {
        var mc = measure(ds.x, ds.sr, fr, s.start, s.end);
        if (mc.last !== null) lastOther = mc.last;
        return;
      }
      if (t.speaker !== 'operator') return;
      var m = measure(ds.x, ds.sr, fr, s.start, s.end);
      var words = wordsIn(t.text);
      var rate = m.voiced >= MIN_VOICED && words >= MIN_WORDS && !MASKED.test(t.text) ? words / m.voiced : null;
      if (rate !== null && (rate < RATE_MIN || rate > RATE_MAX)) rate = null;
      // реплика во время удержания — оператор говорит с коллегами, клиент её не слышит: не сравниваем
      var onHold = holds.some(function (h) { return s.start >= h[0] && s.end <= h[1]; });
      var row = {
        i: i, words: words, voiced: Math.round(m.voiced * 10) / 10,
        db: m.db === null ? null : Math.round(m.db * 10) / 10,
        f0: m.f0 === null ? null : Math.round(m.f0),
        rate: rate === null ? null : Math.round(rate * 100) / 100,
        gap: null, flags: [], on_hold: onHold,
      };
      if (lastOther !== null && m.first !== null && m.first > lastOther) {
        var g = m.first - lastOther;
        var inHold = holds.some(function (h) { return lastOther < h[1] && m.first > h[0]; });
        if (!inHold) row.gap = Math.round(g * 10) / 10;
      }
      lastOther = null;
      turns[i] = row;
    });

    var rows = Object.keys(turns).map(function (k) { return turns[k]; });
    var usable = rows.filter(function (r) { return !r.on_hold && r.voiced >= MIN_VOICED && r.words >= MIN_WORDS; });
    var baseline = {
      db: median(usable.map(function (r) { return r.db; }).filter(function (v) { return v !== null; })),
      rate: median(usable.map(function (r) { return r.rate; }).filter(function (v) { return v !== null; })),
      f0: median(usable.map(function (r) { return r.f0; }).filter(function (v) { return v !== null; })),
      turns: usable.length,
    };
    var enough = usable.length >= 3;

    rows.forEach(function (r) {
      if (r.on_hold) return;
      var ok = r.voiced >= MIN_VOICED && r.words >= MIN_WORDS;
      if (enough && ok && r.db !== null && baseline.db !== null && r.db - baseline.db >= LOUD_DB) {
        r.flags.push({ type: 'loud', level: 'warn', text: 'громче обычного', detail: '+' + Math.round(r.db - baseline.db) + ' дБ' });
      }
      if (enough && ok && r.rate !== null && baseline.rate) {
        if (r.rate >= baseline.rate * FAST) r.flags.push({ type: 'fast', level: 'info', text: 'быстрее обычного', detail: r.rate.toFixed(1).replace('.', ',') + ' сл/с' });
        else if (r.rate <= baseline.rate * SLOW) r.flags.push({ type: 'slow', level: 'info', text: 'медленнее обычного', detail: r.rate.toFixed(1).replace('.', ',') + ' сл/с' });
      }
      if (enough && ok && r.f0 !== null && baseline.f0 && r.f0 >= baseline.f0 * HIGH && r.f0 <= baseline.f0 * F0_RATIO_MAX) {
        r.flags.push({ type: 'high', level: 'warn', text: 'голос выше обычного', detail: '+' + Math.round((r.f0 / baseline.f0 - 1) * 100) + '%' });
      }
      if (r.gap !== null && r.gap >= PAUSE_SEC) {
        r.flags.push({ type: 'pause', level: 'info', text: 'пауза перед ответом', detail: Math.round(r.gap) + ' с' });
      }
      // громче И выше одновременно — самый заметный признак напряжения в голосе
      if (r.flags.some(function (f) { return f.type === 'loud'; }) && r.flags.some(function (f) { return f.type === 'high'; })) r.tense = true;
    });

    var flagged = rows.filter(function (r) { return r.flags.length; }).map(function (r) { return r.i; });
    return {
      baseline: baseline,
      enough: enough,
      turns: turns,
      flagged: flagged,
      summary: {
        operator_turns: rows.length,
        loud: rows.filter(function (r) { return r.flags.some(function (f) { return f.type === 'loud'; }); }).length,
        tense: rows.filter(function (r) { return r.tense; }).length,
        fast: rows.filter(function (r) { return r.flags.some(function (f) { return f.type === 'fast'; }); }).length,
        pauses: rows.filter(function (r) { return r.flags.some(function (f) { return f.type === 'pause'; }); }).length,
      },
    };
  }

  return { analyze: analyze, wordsIn: wordsIn, median: median, _pitchAt: pitchAt, _downsample: downsample, LIMITS: { LOUD_DB: LOUD_DB, FAST: FAST, SLOW: SLOW, HIGH: HIGH, PAUSE_SEC: PAUSE_SEC } };
}));
