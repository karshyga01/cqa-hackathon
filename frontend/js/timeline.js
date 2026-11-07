/* CQA — время в разговоре: системные события и соответствие «реплика ↔ позиция в записи».
   Чистые функции без DOM: работают и в браузере (window.CQA.timeline), и в тестах Node (require).

   Как устроены записи звонков организаторов (замерено на 5 звонках DEV):
   - метка времени реплики стоит в КОНЦЕ фразы, примерно на 0,7 с позже окончания речи;
   - ноль записи — системное событие «Запись и транскрибирование запущены»;
   - «Запись приостановлена → возобновлена»: в mp3 от паузы остаётся ровно ~5 с тишины,
     остальное вырезано, поэтому после паузы позиция сдвигается на (длина паузы − 5 с);
   - удержание клиента («на удержании») из записи НЕ вырезается.
   С этими правилами ошибка перемотки — в среднем 0,3–0,5 с. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.CQA = root.CQA || {}; root.CQA.timeline = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEPT_PAUSE_SEC = 5.0;     // сколько секунд паузы остаётся в mp3
  var END_LAG_SEC = 0.7;        // насколько метка позже конца фразы
  var CHARS_PER_SEC = 13;       // темп речи для оценки длины фразы
  var MIN_UTTER_SEC = 0.6;
  var MAX_UTTER_SEC = 40;       // длинные монологи оператора бывают по 20–30 с

  // Порядок важен: более точные фразы раньше общих (например, «снят с удержания» раньше «на удержании»).
  var SYSTEM_EVENTS = [
    { type: 'identity', tone: 'green', label: 'Личность клиента подтверждена', re: /личность клиента подтверждена|клиенттің жеке басы расталды|customer identity verified/i },
    { type: 'close', tone: 'slate', label: 'Оператор закрыл чат', re: /оператор закрыл чат|оператор чатты жапты|agent closed the chat/i },
    { type: 'client-left', tone: 'slate', label: 'Клиент завершил разговор', re: /клиент покинул чат|клиент завершил разговор|клиент чаттан шықты|customer left the chat|customer ended/i },
    { type: 'disconnect', tone: 'red', label: 'Связь с клиентом прервалась', re: /соединение с клиентом прервано|клиентпен байланыс үзілді|connection to customer lost/i },
    { type: 'escalation', tone: 'blue', label: 'Чат передан оператору', re: /эскалация на оператора|чат операторға жіберілді|chat transferred to an agent/i },
    { type: 'transfer', tone: 'blue', label: 'Звонок переведён на оператора', re: /переведен от агента на представителя|transferred to a representative|өкіліне ауыстырылды|агенттен.*ауыстырылды/i },
    { type: 'join', tone: 'blue', label: 'Оператор подключился', re: /агент присоединился|agent joined|агент.*қосылды/i },
    { type: 'leave', tone: 'slate', label: 'Оператор вышел из разговора', re: /агент вышел из разговора|agent left|агент.*(шықты|ажырады)/i },
    { type: 'consult', tone: 'blue', label: 'Консультация с коллегой', re: /консультаци[яи] с агентом|consultation|агентпен кеңес/i },
    { type: 'unhold', tone: 'amber', label: 'Клиент снят с удержания', re: /больше не находится на удержании|no longer on hold|(ұстаудан|күтуден) (шығарылды|алынды)/i },
    { type: 'hold', tone: 'amber', label: 'Клиент на удержании', re: /находится на удержании|placed on hold|is on hold|(ұстауға|күтуге) қойылды|ұстауда тұр/i },
    { type: 'record-pause', tone: 'slate', label: 'Запись на паузе', re: /транскрибирование приостановлены|recording (and transcription )?(has been |have been )?paused|жазу.*тоқтатыл/i },
    { type: 'record-resume', tone: 'slate', label: 'Запись возобновлена', re: /транскрибирование возобновлены|recording (and transcription )?(has been |have been )?resumed|жазу.*(жалғастырыл|қайта басталды)/i },
    { type: 'record-start', tone: 'slate', label: 'Запись началась', re: /транскрибирование запущены|жазу және транскрипция басталды|recording (and transcription )?(has )?started/i },
    { type: 'language', tone: 'slate', label: 'Сменился язык распознавания', re: /languages have been updated|язык.*изменен/i }
  ];

  function classifySystem(text) {
    var s = String(text || '');
    for (var i = 0; i < SYSTEM_EVENTS.length; i++) {
      if (SYSTEM_EVENTS[i].re.test(s)) return SYSTEM_EVENTS[i];
    }
    return null;
  }

  function isSpeech(turn) { return turn && turn.speaker !== 'system'; }

  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  function parseIsoMs(ts) {
    if (!ISO_RE.test(String(ts || ''))) return NaN;
    return Date.parse(String(ts).replace(/(\.\d{3})\d+/, '$1'));
  }

  /**
   * Секунды от начала разговора с долями секунды. У звонков считаем из исходной ISO-метки
   * (сервер для показа хранит округлённое offset_sec), у чатов берём offset_sec.
   */
  function exactOffsets(list) {
    var base = NaN;
    for (var i = 0; i < list.length; i++) { var ms = parseIsoMs(list[i].timestamp); if (!isNaN(ms)) { base = ms; break; } }
    return list.map(function (t) {
      var ms = parseIsoMs(t.timestamp);
      if (!isNaN(base) && !isNaN(ms)) return Math.max(0, (ms - base) / 1000);
      return typeof t.offset_sec === 'number' ? t.offset_sec : null;
    });
  }

  function estimateDuration(text) {
    var d = String(text || '').length / CHARS_PER_SEC;
    return Math.min(MAX_UTTER_SEC, Math.max(MIN_UTTER_SEC, d));
  }

  /**
   * Строит соответствие для звонка.
   * @param turns реплики с полями speaker, text, offset_sec (секунды от первой реплики)
   * @returns {{ t0, pauses, holds, toAudio(t), spans: Array<{start,end}|null>, points: Array<number|null>, duration }}
   */
  function buildAudioMap(turns, opts) {
    var list = turns || [];
    var shift = (opts && typeof opts.shift === 'number') ? opts.shift : 0; // поправка для конкретного звонка
    var onsets = (opts && opts.onsets) || null;                               // начала речи из записи (если есть)
    var offs = exactOffsets(list);
    var t0 = 0;
    var pauses = [];
    var holds = [];
    var openPause = null;
    var openHold = null;

    list.forEach(function (t, i) {
      var o = offs[i];
      if (t.speaker !== 'system' || typeof o !== 'number') return;
      var ev = classifySystem(t.text);
      if (!ev) return;
      if (ev.type === 'record-start' && t0 === 0) t0 = o;
      if (ev.type === 'record-pause' && openPause === null) openPause = o;
      if (ev.type === 'record-resume' && openPause !== null) { pauses.push([openPause, o]); openPause = null; }
      if (ev.type === 'hold' && openHold === null) openHold = o;
      if (ev.type === 'unhold' && openHold !== null) { holds.push([openHold, o]); openHold = null; }
    });
    if (openHold !== null) {
      var last = offs.length ? offs[offs.length - 1] : openHold;
      holds.push([openHold, typeof last === 'number' ? last : openHold]);
    }

    function toAudio(t) {
      var a = t - t0 + shift;
      for (var i = 0; i < pauses.length; i++) {
        var ps = pauses[i][0], pe = pauses[i][1];
        var cut = Math.max(0, (pe - ps) - KEPT_PAUSE_SEC);
        if (t >= pe) a -= cut;
        else if (t > ps) a -= Math.max(0, (t - ps) - KEPT_PAUSE_SEC); // внутри паузы: время «стоит» после первых 5 с
      }
      return a;
    }

    var spans = [];
    var points = [];
    var prevEndBySpeaker = {};   // реплики разных людей могут перекрываться, ограничиваем только своей же прошлой репликой
    var duration = 0;
    list.forEach(function (t, i) {
      var o = offs[i];
      if (typeof o !== 'number') { spans.push(null); points.push(null); return; }
      var at = toAudio(o);
      points.push(at);
      if (!isSpeech(t)) { spans.push(null); return; }
      var end = at - END_LAG_SEC;
      if (end <= 0) { spans.push(null); return; } // фраза до начала записи
      var start = Math.max(prevEndBySpeaker[t.speaker] || 0, end - estimateDuration(t.text), 0);
      if (onsets) start = snapToOnset(start, end, onsets);
      if (start > end - 0.2) start = Math.max(0, end - 0.2);
      spans.push({ start: start, end: end });
      prevEndBySpeaker[t.speaker] = end;
      duration = Math.max(duration, end);
    });

    return {
      t0: t0,
      shift: shift,
      pauses: pauses,
      holds: holds,
      toAudio: toAudio,
      spans: spans,
      points: points,
      duration: duration,
      /** Зоны на дорожке записи: пауза (оставшиеся 5 с тишины) и удержание. */
      zones: function () {
        var z = [];
        pauses.forEach(function (p) {
          var a = toAudio(p[0]);
          z.push({ type: 'pause', start: a, end: a + Math.min(KEPT_PAUSE_SEC, p[1] - p[0]) });
        });
        holds.forEach(function (h) { z.push({ type: 'hold', start: toAudio(h[0]), end: toAudio(h[1]) }); });
        return z.filter(function (x) { return x.end > 0; });
      }
    };
  }

  /** Ближайшее к оценке начало речи в окне ±1,5 с (но не позже конца фразы). */
  function snapToOnset(start, end, onsets) {
    var best = start, bestD = 1.5;
    for (var i = 0; i < onsets.length; i++) {
      var o = onsets[i];
      if (o > end - 0.3) break;
      var d = Math.abs(o - start);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** Номер реплики (индекс), которая звучит в момент sec, или -1. При перекрытии — начавшаяся позже. */
  function findTurnAt(spans, sec) {
    var best = -1, bestStart = -Infinity;
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (!s) continue;
      if (sec >= s.start - 0.05 && sec <= s.end + 0.35 && s.start >= bestStart) { best = i; bestStart = s.start; }
    }
    return best;
  }

  /**
   * Концы участков речи в записи (секунды) по громкости — для автоподстройки.
   * samples — Float32Array одного канала, sampleRate — частота.
   */
  function detectSpeechEnds(samples, sampleRate) {
    return detectSpeechSegments(samples, sampleRate).map(function (seg) { return seg[1]; });
  }

  /** Участки речи [начало, конец] в секундах. */
  function detectSpeechSegments(samples, sampleRate) {
    var FR = 0.05;
    var n = Math.floor(samples.length / (FR * sampleRate));
    if (n < 20) return [];
    var db = new Array(n);
    for (var i = 0; i < n; i++) {
      var a = Math.floor(i * FR * sampleRate), b = Math.floor((i + 1) * FR * sampleRate), s = 0;
      for (var j = a; j < b; j++) s += samples[j] * samples[j];
      db[i] = 10 * Math.log10(s / (b - a) + 1e-10);
    }
    var sorted = db.slice().sort(function (x, y) { return x - y; });
    var p20 = sorted[Math.floor(n * 0.2)], p95 = sorted[Math.floor(n * 0.95)];
    var thr = p20 + Math.max(10, (p95 - p20) * 0.35);
    var sp = db.map(function (v) { return v > thr ? 1 : 0; });
    // склеиваем паузы короче 0,3 с и выкидываем щелчки короче 0,15 с
    function runs(arr) { var r = [], st = 0; for (var k = 1; k <= arr.length; k++) if (k === arr.length || arr[k] !== arr[st]) { r.push([arr[st], st, k]); st = k; } return r; }
    runs(sp).forEach(function (r) { if (r[0] === 0 && (r[2] - r[1]) * FR < 0.3 && r[1] > 0) for (var k = r[1]; k < r[2]; k++) sp[k] = 1; });
    runs(sp).forEach(function (r) { if (r[0] === 1 && (r[2] - r[1]) * FR < 0.15) for (var k = r[1]; k < r[2]; k++) sp[k] = 0; });
    return runs(sp).filter(function (r) { return r[0] === 1; }).map(function (r) { return [r[1] * FR, r[2] * FR]; });
  }

  /**
   * Подбирает поправку (секунды), при которой концы реплик лучше всего совпадают с концами речи.
   * Возвращает { shift, before, after } — доля совпадений до и после; shift = 0, если улучшения нет.
   */
  function bestShift(turns, speechEnds, range) {
    var R = range || 2.5;
    if (!speechEnds || speechEnds.length < 5) return { shift: 0, before: 0, after: 0 };
    // Оценка сдвига: доля реплик, чей конец в пределах 0,75 с от конца речи,
    // и среднее расстояние для совпавших (меньше — точнее).
    function score(sh) {
      var spans = buildAudioMap(turns, { shift: sh }).spans.filter(Boolean);
      if (!spans.length) return { hit: 0, dist: Infinity };
      var hit = 0, sum = 0, j = 0;
      for (var i = 0; i < spans.length; i++) {
        var e = spans[i].end;
        while (j < speechEnds.length - 1 && speechEnds[j + 1] <= e) j++;
        var d = Math.min(Math.abs(speechEnds[j] - e), j + 1 < speechEnds.length ? Math.abs(speechEnds[j + 1] - e) : Infinity);
        if (d <= 0.75) { hit++; sum += d; }
      }
      return { hit: hit / spans.length, dist: hit ? sum / hit : Infinity };
    }
    var base = score(0);
    var best = { s: base, sh: 0 };
    for (var k = -Math.round(R * 10); k <= Math.round(R * 10); k++) {
      var sh = k / 10;
      var v = score(sh);
      var better = v.hit > best.s.hit + 1e-9 || (Math.abs(v.hit - best.s.hit) < 1e-9 && v.dist < best.s.dist - 1e-9);
      if (better) best = { s: v, sh: sh };
    }
    // Поправку применяем, только если она заметно лучше базового правила.
    var worth = best.s.hit > base.hit + 0.02 || (best.s.hit >= base.hit && best.s.dist < base.dist - 0.15);
    if (!worth) best = { s: base, sh: 0 };
    return { shift: best.sh, before: base.hit, after: best.s.hit };
  }

  function formatClock(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return '';
    var v = Math.max(0, Math.round(sec));
    var h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), s = v % 60;
    var pad = function (x) { return (x < 10 ? '0' : '') + x; };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  return {
    KEPT_PAUSE_SEC: KEPT_PAUSE_SEC,
    END_LAG_SEC: END_LAG_SEC,
    SYSTEM_EVENTS: SYSTEM_EVENTS,
    classifySystem: classifySystem,
    buildAudioMap: buildAudioMap,
    findTurnAt: findTurnAt,
    estimateDuration: estimateDuration,
    detectSpeechEnds: detectSpeechEnds,
    detectSpeechSegments: detectSpeechSegments,
    exactOffsets: exactOffsets,
    bestShift: bestShift,
    formatClock: formatClock
  };
}));
