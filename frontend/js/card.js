/* CQA — карточка диалога: переписка, системные события, ссылки на реплики, плеер звонка с дорожками.
   Адрес: #dialog/<ключ>[/m-<номер реплики>]. Номера реплик начинаются с 1. */
(function () {
  'use strict';

  var CQA = window.CQA;
  var TL = CQA.timeline;
  var $ = CQA.$;
  var $$ = CQA.$$;
  var esc = CQA.esc;

  var LANG_NAMES = { RU: 'Русский', KZ: 'Казахский', EN: 'Английский' };
  var ROLE_NAMES = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
  var BOT_CLAMP_CHARS = 160;

  var card = {
    key: null,
    record: null,
    isCall: false,
    map: null,
    audio: null,
    follow: true,
    playingIdx: -1,
    loadToken: 0,
    raf: 0
  };

  function icon(id, cls) { return '<svg class="i ' + (cls || 'i-sm') + '"><use href="#' + id + '"/></svg>'; }
  function keyHref(key, n) { return '#dialog/' + encodeURIComponent(key) + (n ? '/m-' + n : ''); }

  /* ---------- маршрут ---------- */

  document.addEventListener('cqa:route', function (e) {
    var d = e.detail;
    // окно «Оспорить» относится к конкретному диалогу — при любом переходе закрываем
    CQA.closeModal('modal-appeal');
    if (d.page !== 'dialog') {
      // Ушли из карточки: останавливаем звук и забываем диалог, чтобы при возврате всё открылось заново.
      stopAudio();
      card.key = null;
      card.record = null;
      card.loadToken++;
      return;
    }
    var key = '';
    try { key = decodeURIComponent(d.parts[1] || ''); } catch (_) { key = ''; }
    var target = /^m-(\d+)$/.exec(d.parts[2] || '');
    var n = target ? Number(target[1]) : null;

    if (key && key === card.key && card.record) {
      if (n) jumpTo(n, { flash: true });
      return;
    }
    open(key, n);
  });

  function open(key, n) {
    stopAudio();
    card.key = key;
    card.record = null;
    card.playingIdx = -1;
    card.userMoved = false;
    card.voice = null;
    renderVoice();
    var token = ++card.loadToken;

    setState('loading');
    renderNav();
    if (!key) { setState('error', 'Не указан диалог.'); return; }

    var evalReq = CQA.api.get('/api/dialogs/' + encodeURIComponent(key) + '/evaluation').catch(function (err) {
      return (err.status === 404) ? null : { error: err.message };
    });
    Promise.all([CQA.api.get('/api/dialogs/' + encodeURIComponent(key)), evalReq, CQA.aiReady]).then(function (res) {
      var rec = res[0];
      if (token !== card.loadToken) return;
      card.record = rec;
      setEvaluation(res[1]);
      card.isCall = rec.channel === 'voice call';
      card.map = card.isCall ? TL.buildAudioMap(rec.transcript) : null;
      render();
      setState('ready');
      if (n) jumpTo(n, { flash: true, instant: true });
      if (card.isCall) initAudio(token);
    }).catch(function (err) {
      if (token !== card.loadToken) return;
      setState('error', err.status === 404 ? 'Такого диалога нет. Возможно, набор загрузили заново под другим кодом.' : err.message);
    });
  }

  function setState(kind, text) {
    var st = $('#cd-state');
    var grid = $('#cd-grid');
    var player = $('#cd-player');
    if (kind === 'ready') {
      st.hidden = true;
      grid.hidden = false;
      player.hidden = !card.isCall;
      return;
    }
    grid.hidden = true;
    player.hidden = true;
    st.hidden = false;
    if (kind === 'loading') {
      $('#cd-title').textContent = 'Загружаю диалог…';
      $('#cd-meta').innerHTML = '';
      st.innerHTML = '<div class="cqa-empty"><span class="cqa-spin" aria-hidden="true"></span><p>Загружаю переписку…</p></div>';
    } else {
      $('#cd-title').textContent = 'Диалог не открылся';
      $('#cd-meta').innerHTML = '';
      st.innerHTML = '<div class="cqa-empty is-error"><span class="cqa-empty-icon">' + icon('i-alert', '') + '</span>' +
        '<b>Не удалось открыть диалог</b><p>' + esc(text) + '</p>' +
        '<a class="cqa-btn cqa-btn-ghost" href="#dialogs">' + icon('i-left') + 'К списку диалогов</a></div>';
    }
  }

  /* ---------- соседние диалоги ---------- */

  function neighbors() {
    var keys = (CQA.dialogs && CQA.dialogs.orderedKeys) ? CQA.dialogs.orderedKeys() : [];
    var i = keys.indexOf(card.key);
    return { keys: keys, i: i, prev: i > 0 ? keys[i - 1] : null, next: i >= 0 && i < keys.length - 1 ? keys[i + 1] : null };
  }

  function renderNav() {
    var nb = neighbors();
    var prev = $('#cd-prev'), next = $('#cd-next'), pos = $('#cd-pos');
    prev.disabled = !nb.prev;
    next.disabled = !nb.next;
    prev.dataset.key = nb.prev || '';
    next.dataset.key = nb.next || '';
    pos.textContent = nb.i >= 0 ? (nb.i + 1) + ' из ' + nb.keys.length : '';
  }
  document.addEventListener('cqa:dialogs-loaded', function () { if (card.key) renderNav(); });

  function go(dir) {
    var b = dir < 0 ? $('#cd-prev') : $('#cd-next');
    if (!b.disabled && b.dataset.key) location.hash = keyHref(b.dataset.key);
  }

  /* ---------- отрисовка ---------- */

  function render() {
    var r = card.record;
    var durSec = 0;
    r.transcript.forEach(function (t) { if (typeof t.offset_sec === 'number') durSec = Math.max(durSec, t.offset_sec); });

    $('#cd-title').textContent = (card.isCall ? 'Звонок ' : 'Чат ') + r.conversation_id;
    $('#cd-meta').innerHTML = [
      '<span class="cqa-chip cqa-chip-outline">' + icon(card.isCall ? 'i-phone' : 'i-chat') + (card.isCall ? 'Телефонный звонок' : 'Чат') + '</span>',
      '<span class="cqa-chip cqa-chip-outline">' + esc(LANG_NAMES[r.language] || r.language) + '</span>',
      '<span class="cqa-chip cqa-chip-outline">' + icon('i-clock') + TL.formatClock(durSec) + '</span>',
      '<span class="cqa-chip cqa-chip-outline">' + r.transcript.length + ' реплик</span>',
      '<span class="cqa-chip cqa-chip-outline">Набор ' + esc(r.group_id) + '</span>',
      '<span id="cd-status">' + statusChipHtml() + '</span>'
    ].join('');
    $('#cd-tx-title').textContent = card.isCall ? 'Расшифровка звонка' : 'Переписка';

    renderTranscript();
    renderSide();
    renderNav();
    if (card.isCall) renderPlayer();
  }

  function timeLabel(t, i) {
    if (card.isCall) {
      var span = card.map.spans[i];
      var point = card.map.points[i];
      var shown = span ? span.start : point; // для реплики — момент, с которого она звучит
      if (shown === null || shown === undefined || shown < 0) return { text: 'до записи', title: 'Исходная метка: ' + t.timestamp };
      return { text: TL.formatClock(shown), title: 'Время в записи. Исходная метка: ' + t.timestamp };
    }
    return { text: t.timestamp || '', title: '' };
  }

  function renderTranscript() {
    var key = card.key;
    var html = card.record.transcript.map(function (t, i) {
      var n = i + 1;
      var tl = timeLabel(t, i);
      var numLink = '<a class="cqa-msg-num" href="' + esc(keyHref(key, n)) + '" data-copy="' + n + '" title="Ссылка на реплику №' + n + '">№' + n + '</a>';

      if (t.speaker === 'system') {
        var ev = TL.classifySystem(t.text);
        if (ev) {
          return '<div class="cqa-event tone-' + ev.tone + '" id="m-' + n + '" data-i="' + i + '">' +
            '<span class="cqa-event-icon">' + icon(eventIcon(ev.type)) + '</span>' +
            '<span class="cqa-event-body"><b>' + esc(ev.label) + '</b><span class="cqa-event-orig">' + esc(t.text) + '</span></span>' +
            '<span class="cqa-event-time" title="' + esc(tl.title) + '">' + esc(tl.text) + '</span>' + numLink + '</div>';
        }
        return '<div class="cqa-msg is-context is-system" id="m-' + n + '" data-i="' + i + '">' +
          '<div class="cqa-msg-bubble"><span title="' + esc(tl.title) + '">' + esc(tl.text) + '</span> — ' + esc(t.text) + ' ' + numLink + '</div></div>';
      }

      var role = t.speaker;
      var cls = role === 'client' ? 'is-client' : role === 'operator' ? 'is-operator' : 'is-context is-bot';
      var timeHtml = card.isCall && card.map.spans[i]
        ? '<button class="cqa-msg-time" type="button" data-play="' + i + '" title="' + esc(tl.title) + '. Слушать с этого места">' + icon('i-play', 'i-xs i-fill') + esc(tl.text) + '</button>'
        : '<span class="cqa-msg-ts" title="' + esc(tl.title) + '">' + esc(tl.text) + '</span>';
      var who = '<span class="cqa-msg-who">' + ROLE_NAMES[role] + '</span>';
      var ctx = role === 'bot' ? '<span class="cqa-msg-ctx">контекст, не оценивается</span>' : '';
      var meta = role === 'operator' ? numLink + timeHtml + who : who + timeHtml + ctx + numLink;
      var long = role === 'bot' && t.text.length > BOT_CLAMP_CHARS;
      return '<div class="cqa-msg ' + cls + '" id="m-' + n + '" data-i="' + i + '">' +
        '<div class="cqa-msg-meta">' + meta + '</div>' +
        '<div class="cqa-msg-bubble"><span class="cqa-msg-text' + (long ? ' is-clamped' : '') + '">' + esc(t.text) + '</span></div>' +
        (long ? '<button class="cqa-btn-link cqa-msg-more" type="button" data-more>Показать полностью</button>' : '') +
        '</div>';
    }).join('');
    var body = $('#cd-tx');
    body.innerHTML = html;
    body.scrollTop = 0;
    decorateTranscript();
    injectVoiceChips();
  }

  /* ---------- голос оператора (звонки) ---------- */

  var VOICE_ICON = { mono: '—', jumpy: '〰', cut: '↘', high: '↑', loud: '▲', fast: '»', slow: '«', pause: '⏸' };

  function voiceNum(x, d) { return x === null || x === undefined ? '—' : Number(x).toFixed(d || 0).replace('.', ','); }

  /** Мини-график мелодии фразы (полутона от обычной высоты) и серая полоса обычного размаха оператора. */
  function voiceSpark(r, base) {
    var pts = r.spark || [];
    if (pts.length < 4) return '<span class="cqa-voice-spark is-empty" aria-hidden="true"></span>';
    var W = 120, H = 30, LIM = 9;
    var y = function (s) { var c = Math.max(-LIM, Math.min(LIM, s)); return (H / 2 - (c / LIM) * (H / 2 - 2)).toFixed(1); };
    var half = Math.min(LIM, (base.range || 0) / 2);
    var line = pts.map(function (s, k) { return (k * (W / (pts.length - 1))).toFixed(1) + ',' + y(s); }).join(' ');
    var label = 'Мелодия фразы: размах ' + voiceNum(r.range, 1) + ' полутона (обычно ' + voiceNum(base.range, 1) + '). Серая полоса — обычный размах оператора.';
    return '<svg class="cqa-voice-spark" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(label) + '"><title>' + esc(label) + '</title>' +
      '<rect x="0" y="' + y(half) + '" width="' + W + '" height="' + Math.max(1, y(-half) - y(half)).toFixed(1) + '" class="band"/>' +
      '<line x1="0" x2="' + W + '" y1="' + y(0) + '" y2="' + y(0) + '" class="mid"/>' +
      '<polyline points="' + line + '" class="line"/></svg>';
  }

  /** Метки у реплик оператора: «громче обычного +7 дБ» и т. п. */
  function injectVoiceChips() {
    var body = $('#cd-tx');
    if (!body) return;
    body.querySelectorAll('[data-voice]').forEach(function (el) { el.remove(); });
    var v = card.voice;
    if (!v || v.error || !v.flagged) return;
    v.flagged.forEach(function (i) {
      var r = v.turns[i];
      var meta = document.querySelector('#m-' + (i + 1) + ' .cqa-msg-meta');
      if (!meta || !r) return;
      r.flags.forEach(function (f) {
        var chip = document.createElement('span');
        chip.className = "cqa-voice-chip is-" + f.level + (r.tense && (f.type === "loud" || f.type === "high" || f.type === "jumpy") ? " is-tense" : "");
        chip.setAttribute('data-voice', '');
        chip.title = 'Голос оператора (замер по записи): ' + f.text + ', ' + f.detail + '. Сравнение с обычным для этого оператора в этом звонке.';
        chip.textContent = (VOICE_ICON[f.type] || '') + ' ' + f.text + ' ' + f.detail;
        meta.appendChild(chip);
      });
    });
  }

  /** Панель под плеером: обычные значения голоса оператора и реплики, где он заметно отличается. */
  function renderVoice() {
    var box = $('#cd-voice');
    if (!box) return;
    var v = card.voice;
    if (!card.isCall || !v) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    if (v.error) { box.innerHTML = '<div class="cqa-panel-body cqa-muted">Голос оператора: не удалось проанализировать запись.</div>'; return; }
    var b = v.baseline || {};
    var s = v.summary || {};
    var items = (v.flagged || []).map(function (i) {
      var r = v.turns[i];
      var t = card.record.transcript[i];
      return '<li><button type="button" class="cqa-voice-item" data-voice-jump="' + (i + 1) + '">' +
        '<span class="cqa-voice-n">№' + (i + 1) + '</span>' + voiceSpark(r, b) +
        '<span class="cqa-voice-flags">' + r.flags.map(function (f) {
          return '<span class="cqa-voice-chip is-' + f.level + (r.tense && (f.type === 'loud' || f.type === 'high' || f.type === 'jumpy') ? ' is-tense' : '') + '">' + (VOICE_ICON[f.type] || '') + ' ' + esc(f.text) + ' ' + esc(f.detail) + '</span>';
        }).join('') + (r.tense ? '<b class="cqa-voice-tense">напряжённо</b>' : '') + '</span>' +
        '<span class="cqa-voice-text">' + esc(String(t.text || '').slice(0, 120)) + '</span></button></li>';
    }).join('');
    var parts = [];
    if (s.mono) parts.push('монотонно — ' + s.mono);
    if (s.jumpy) parts.push('интонация скачет — ' + s.jumpy);
    if (s.cut) parts.push('резкое окончание — ' + s.cut);
    if (s.high) parts.push('голос выше обычного — ' + s.high);
    if (s.tense) parts.push('напряжённо — ' + s.tense);
    if (s.fast || s.slow) parts.push('темп — ' + ((s.fast || 0) + (s.slow || 0)));
    if (s.pauses) parts.push('паузы — ' + s.pauses);
    var headline = !v.enough
      ? 'Мало реплик оператора для сравнения — отмечены только паузы.'
      : (v.flagged.length
        ? 'Манера отличается от обычной в ' + v.flagged.length + ' ' + (v.flagged.length === 1 ? 'реплике' : 'репликах') + ': ' + parts.join(', ') + '.'
        : 'Интонация ровная: без заметных отличий от обычной манеры.');
    box.innerHTML =
      '<div class="cqa-panel-head"><div><h2 class="cqa-voice-title">Голос и интонация оператора <span class="cqa-chip cqa-chip-outline">замер по записи, без ИИ · на оценку не влияет</span></h2>' +
        '<p class="cqa-voice-sub">Обычно в этом звонке: размах мелодии ' + voiceNum(b.range, 1) + ' полутона · высота ≈ ' + voiceNum(b.f0) + ' Гц · темп ' + voiceNum(b.rate, 1) + ' слова/с · по ' + (b.turns || 0) + ' репликам. ' + esc(headline) + '</p></div></div>' +
      (items ? '<div class="cqa-panel-body"><ul class="cqa-voice-list">' + items + '</ul>' : '<div class="cqa-panel-body">') +
      '<p class="cqa-voice-note">Одни и те же слова можно сказать спокойно или резко, а громкость больше зависит от микрофона, чем от настроения. Поэтому смотрим на интонацию — как движется высота голоса внутри фразы — ' +
      'и сравниваем с обычной манерой этого оператора: <b>монотонно</b> — мелодия плоская; <b>интонация скачет</b> — размах или живость почти вдвое больше обычного; <b>резкое окончание</b> — голос резко падает и звук обрывается; ' +
      '<b>напряжённо</b> — громче обычного вместе со скачками или высоким голосом. График — мелодия фразы, серая полоса — обычный размах. ' +
      'Это подсказка, где послушать запись, а не оценка эмоций. Запись моно: если клиент говорит одновременно, замер может ошибиться. Реплики во время удержания не сравниваются.</p></div>';
  }

  function eventIcon(type) {
    if (type === 'identity') return 'i-shield';
    if (type === 'hold' || type === 'unhold') return 'i-clock';
    if (type === 'close' || type === 'client-left' || type === 'disconnect' || type === 'leave') return 'i-x';
    if (type.indexOf('record') === 0 || type === 'language') return 'i-spark';
    return 'i-chat';
  }

  function renderSide() {
    var r = card.record;
    var counts = { client: 0, operator: 0, bot: 0, system: 0 };
    r.transcript.forEach(function (t) { counts[t.speaker] = (counts[t.speaker] || 0) + 1; });
    var total = r.transcript.length || 1;

    var events = [];
    var firstClient = -1, firstOperator = -1;
    r.transcript.forEach(function (t, i) {
      if (t.speaker === 'client' && firstClient < 0) firstClient = i;
      if (t.speaker === 'operator' && firstOperator < 0) firstOperator = i;
      if (t.speaker === 'system') {
        var ev = TL.classifySystem(t.text);
        if (ev && ev.type !== 'language' && ev.type !== 'record-start' && ev.type !== 'record-resume') events.push({ i: i, label: ev.label, tone: ev.tone });
      }
    });
    if (firstClient >= 0) events.push({ i: firstClient, label: 'Первая реплика клиента', tone: 'neutral' });
    if (firstOperator >= 0) events.push({ i: firstOperator, label: 'Первая реплика оператора', tone: 'neutral' });
    else events.push({ i: -1, label: 'Оператор так и не ответил', tone: 'red' });
    events.sort(function (a, b) { return a.i - b.i; });

    var evHtml = events.map(function (ev) {
      if (ev.i < 0) return '<li class="cqa-kev tone-' + ev.tone + '"><span class="cqa-kev-dot"></span><span>' + esc(ev.label) + '</span></li>';
      var tl = timeLabel(r.transcript[ev.i], ev.i);
      return '<li><button class="cqa-kev tone-' + ev.tone + '" type="button" data-jump-n="' + (ev.i + 1) + '">' +
        '<span class="cqa-kev-dot"></span><span class="cqa-kev-label">' + esc(ev.label) + '</span>' +
        '<span class="cqa-kev-time">' + esc(tl.text) + ' · №' + (ev.i + 1) + '</span></button></li>';
    }).join('');

    var roleRows = ['client', 'operator', 'bot', 'system'].map(function (role) {
      var c = counts[role] || 0;
      return '<div class="cqa-mix-row"><span class="cqa-mix-name"><i class="cqa-mix-sw role-' + role + '"></i>' + ROLE_NAMES[role] + '</span>' +
        '<span class="cqa-mix-bar"><i class="role-' + role + '" style="width:' + Math.round(c / total * 100) + '%"></i></span>' +
        '<span class="cqa-mix-n">' + c + '</span></div>';
    }).join('');

    $('#cd-side').innerHTML = (card.evaluation ? resultHtml() : noEvalHtml()) +
      '<div class="cqa-panel"><div class="cqa-panel-head"><h3>Ключевые события</h3></div>' +
        '<div class="cqa-panel-body"><ul class="cqa-kev-list">' + evHtml + '</ul></div></div>' +
      '<div class="cqa-panel"><div class="cqa-panel-head"><h3>Кто сколько писал</h3><span class="cqa-muted" style="font-size:13px">реплик</span></div>' +
        '<div class="cqa-panel-body cqa-mix">' + roleRows + '</div></div>';
    markPending();
  }

  /* Идущие оценки по ключу диалога: если вернуться в карточку, пока ИИ ещё думает,
     кнопки остаются выключенными — чтобы не отправить второй (платный) запрос. */
  var pending = {};
  function markPending() {
    var mode = card.key && pending[card.key];
    if (!mode) return;
    var btns = $$('#cd-side [data-evaluate]');
    btns.forEach(function (b) { b.disabled = true; });
    var main = btns.filter(function (b) { return b.dataset.evaluate === mode; })[0] || btns[0];
    var label = main && main.querySelector('span');
    if (label) label.textContent = mode === 'ai' ? 'ИИ оценивает…' : 'Оцениваю…';
  }

  /* ==========================================================================
     Оценка: загрузка, пересчёт баллов, панель результата, метки в переписке
     ========================================================================== */

  function setEvaluation(payload) {
    card.evaluation = null; card.evalChecklist = null; card.result = null; card.aiResult = null; card.evalHistory = []; card.evalError = null;
    card.appeals = []; card.overrides = {};
    if (!payload) return;
    if (payload.error) { card.evalError = payload.error; return; }
    card.evaluation = payload.evaluation;
    card.evalChecklist = payload.checklist;
    card.evalHistory = payload.history || [];
    card.appeals = payload.appeals || [];
    card.appeals.forEach(function (a) { if (a.status === 'changed') card.overrides[a.criterion_key] = a.decision.new_value; });
    // Баллы всегда считает scoring.js по той версии чек-листа, по которой шла оценка.
    // aiResult — как оценил ИИ; result — финальный итог с учётом решений по апелляциям.
    card.aiResult = CQA.scoring.score(payload.checklist, aiValues());
    card.result = hasOverrides() ? CQA.scoring.score(payload.checklist, aiValues(card.overrides)) : card.aiResult;
  }

  function aiValues(extra) {
    var values = {};
    var ans = (card.evaluation && card.evaluation.answers) || {};
    Object.keys(ans).forEach(function (k) { values[k] = ans[k].answer; });
    Object.keys(extra || {}).forEach(function (k) { values[k] = extra[k]; });
    return values;
  }
  function hasOverrides() { return Object.keys(card.overrides || {}).length > 0; }
  /** Апелляция по критерию текущей оценки: открытая или решённая (закрытые из-за новой оценки сюда не попадают). */
  function appealFor(key) {
    var list = (card.appeals || []).filter(function (a) { return a.criterion_key === key && a.status !== 'stale'; });
    return list.filter(function (a) { return a.status === 'open'; })[0] || list[list.length - 1] || null;
  }

  function F(x) { return CQA.scoring.formatPoints(x); }
  function money(x) { return CQA.money(x); }
  function critNum(i) { return (i < 9 ? '0' : '') + (i + 1); }
  function shortName(name) {
    var n = String(name || '');
    if (n.length <= 26) return n;
    var cut = n.slice(0, 26);
    return cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : 26) + '…';
  }
  function gradeOf(total) {
    if (total >= 85) return { cls: 'is-good', text: 'Хорошо' };
    if (total >= 70) return { cls: 'is-mid', text: 'Есть замечания' };
    return { cls: 'is-low', text: 'Требует внимания' };
  }

  function statusChipHtml() {
    var ev = card.evaluation;
    if (!ev) return '<span class="cqa-chip"><span class="cqa-dot"></span>Не оценён</span>';
    var r = card.result;
    var txt = r && r.computable ? 'Оценён: ' + F(r.total) : 'Оценён: итог не рассчитан';
    var openAp = (card.appeals || []).filter(function (a) { return a.status === 'open'; }).length;
    if (openAp) return '<span class="cqa-chip cqa-chip-amber"><span class="cqa-dot"></span>' + esc(txt) + ' · на апелляции</span>';
    if ((card.appeals || []).some(function (a) { return a.status === 'kept' || a.status === 'changed'; })) {
      return '<span class="cqa-chip cqa-chip-green"><span class="cqa-dot"></span>' + esc(txt) + ' · пересмотрен</span>';
    }
    if (ev.result && ev.result.needs_review) return '<span class="cqa-chip cqa-chip-amber"><span class="cqa-dot"></span>' + esc(txt) + ' · нужна проверка</span>';
    return '<span class="cqa-chip cqa-chip-green"><span class="cqa-dot"></span>' + esc(txt) + '</span>';
  }

  function noEvalHtml() {
    return '<div class="cqa-panel cqa-noeval"><div class="cqa-panel-body">' +
      '<span class="cqa-noeval-icon">' + icon('i-spark', '') + '</span>' +
      '<h2>Диалог ещё не оценён</h2>' +
      (card.evalError ? '<p class="cqa-field-err">Не удалось загрузить оценку: ' + esc(card.evalError) + '</p>' : '') +
      (CQA.ai.available
        ? '<p>ИИ (' + esc(CQA.shortModel(CQA.ai.model)) + ') прочитает диалог и ответит по каждому критерию с репликами-доказательствами. Обычно это занимает 10–40 секунд.</p>' +
          '<div class="cqa-noeval-actions"><button class="cqa-btn cqa-btn-primary" type="button" data-evaluate="ai">' + icon('i-spark') + '<span>Оценить ИИ</span></button>' +
          '<button class="cqa-btn cqa-btn-ghost" type="button" data-evaluate="mock"><span>Подставная оценка</span></button>' + CQA.appealsToggleHtml() + '</div>'
        : '<p>ИИ не подключён: добавьте <code>OPENROUTER_API_KEY</code> в файл <code>.env</code> и перезапустите сервер. Пока можно сделать <b>подставную оценку</b> по простым правилам — чтобы проверить экран результата.</p>' +
          '<button class="cqa-btn cqa-btn-primary" type="button" data-evaluate="mock">' + icon('i-spark') + '<span>Подставная оценка</span></button>') +
    '</div></div>';
  }

  /** Подпись ответа и класс значка. */
  function answerBadge(c, a, row) {
    var v = a ? a.answer : null;
    if (c.type === 'flag') {
      return v === 'yes'
        ? '<span class="cqa-ans cqa-ans-no">' + icon('i-alert') + 'Да — нарушение</span>'
        : '<span class="cqa-ans cqa-ans-yes">Нет</span>';
    }
    if (v === 'yes') return '<span class="cqa-ans cqa-ans-yes">' + icon('i-check') + 'Да</span>';
    if (v === 'no') return '<span class="cqa-ans cqa-ans-no">' + icon('i-x') + 'Нет</span>';
    if (v === 'na') return '<span class="cqa-ans cqa-ans-na">N/A</span>';
    if (typeof v === 'number') {
      var top = Math.max.apply(null, c.scale.map(function (st) { return Number(st.points); }));
      return '<span class="cqa-ans cqa-ans-scale' + (v === top ? ' is-full' : '') + '">' + v + ' из ' + top + '</span>';
    }
    return '<span class="cqa-ans cqa-ans-na">—</span>';
  }

  function tagLabel(c, a) {
    var v = a.answer;
    if (c.type === 'flag') return v === 'yes' ? 'нарушение' : 'нет';
    if (v === 'yes') return 'Да';
    if (v === 'no') return 'Нет';
    if (v === 'na') return 'N/A';
    var top = Math.max.apply(null, c.scale.map(function (st) { return Number(st.points); }));
    return v + ' из ' + top;
  }
  function tagClass(c, a) {
    if (c.type === 'flag') return a.answer === 'yes' ? ' is-no' : '';
    if (a.answer === 'no') return ' is-no';
    if (a.answer === 'na') return ' is-na';
    if (typeof a.answer === 'number') {
      var top = Math.max.apply(null, c.scale.map(function (st) { return Number(st.points); }));
      return a.answer === top ? '' : ' is-part';
    }
    return '';
  }

  function quoteHtml(e) {
    var t = card.record.transcript[e.turn - 1];
    if (!t) return '';
    var tl = timeLabel(t, e.turn - 1);
    // Цитата — часть реплики: показываем «…» там, где текст реплики продолжается.
    var full = String(t.text || '').replace(/\s+/g, ' ').trim();
    var q = String(e.quote || '').replace(/\s+/g, ' ').trim() || full;
    var at = full.toLowerCase().indexOf(q.toLowerCase());
    var pre = at > 0 ? '…' : '', post = at >= 0 && at + q.length < full.length ? '…' : '';
    return '<button class="cqa-quote cqa-quote-btn" type="button" data-jump-n="' + e.turn + '" title="Показать в переписке">' +
      '<span class="cqa-quote-meta">' + esc(ROLE_NAMES[t.speaker] || t.speaker) + ', №' + e.turn + (tl.text ? ' · ' + esc(tl.text) : '') + '</span>' +
      '<span class="cqa-quote-text">«' + pre + esc(q) + post + '»</span></button>';
  }

  /** Плашка апелляции внутри критерия: ждёт решения / изменено / оставлено. */
  function appealNoteHtml(c, a, ap) {
    var when = function (iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); };
    var link = '<a class="cqa-btn-link" href="#appeals/' + esc(ap.id) + '">Апелляция №' + ap.no + '</a>';
    if (ap.status === 'open') {
      return '<div class="cqa-ap-note is-open">' + icon('i-scale', 'i') + '<div><b>На апелляции — ждёт решения проверяющего.</b>' +
        '<p>Комментарий аналитика: «' + esc(ap.comment) + '»' + (ap.requested_value !== null ? ' Предлагает: ' + esc(CQA.answerText(c, ap.requested_value)) + '.' : '') + '</p>' + link + '</div></div>';
    }
    var d = ap.decision || {};
    if (ap.status === 'changed') {
      return '<div class="cqa-ap-note is-changed">' + icon('i-check', 'i') + '<div><b>Изменено проверяющим: <s>' + esc(CQA.answerText(c, a.answer)) + '</s> → ' + esc(CQA.answerText(c, d.new_value)) + '</b>' +
        '<p>Причина: «' + esc(d.reason || '') + '» · ' + esc(when(d.decided_at)) + '</p>' + link + '</div></div>';
    }
    return '<div class="cqa-ap-note is-kept">' + icon('i-shield', 'i') + '<div><b>Апелляция рассмотрена: оценка ИИ оставлена.</b>' +
      '<p>Причина: «' + esc(d.reason || '') + '» · ' + esc(when(d.decided_at)) + '</p>' + link + '</div></div>';
  }

  /** Кнопка в подвале критерия: «Оспорить» (аналитик) или ссылка на уже поданную апелляцию. */
  function appealButtonHtml(c, ap) {
    if (ap) return '<a class="cqa-btn cqa-btn-ghost cqa-btn-sm" href="#appeals/' + esc(ap.id) + '">' + icon('i-scale') + 'Апелляция №' + ap.no + '</a>';
    if (CQA.role !== 'analyst') {
      return '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm" type="button" disabled title="Апелляцию подаёт аналитик — переключите роль внизу меню">' + icon('i-scale') + 'Оспорить</button>';
    }
    return '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm" type="button" data-appeal="' + esc(c.key) + '">' + icon('i-scale') + 'Оспорить</button>';
  }

  /** История в карточке: исходная оценка ИИ → апелляции и решения → финальный итог. */
  function appealsHistoryHtml(idx) {
    var list = (card.appeals || []).filter(function (a) { return a.status !== 'stale'; });
    if (!list.length) return '';
    var cl = card.evalChecklist;
    var byKey = {};
    cl.criteria.forEach(function (c) { byKey[c.key] = c; });
    var when = function (iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); };
    var ai = card.aiResult, fin = card.result;
    var items = '<li><span class="cqa-history-dot">' + icon('i-spark') + '</span><div><b>Исходная оценка ' + (card.evaluation.source === 'mock' ? '(подставная)' : 'ИИ') + ': ' + (ai.computable ? F(ai.total) : '—') + '</b>' +
      '<p>' + esc(when(card.evaluation.created_at)) + ', чек-лист v' + card.evaluation.checklist.version + '</p></div></li>';
    list.forEach(function (a) {
      var c = byKey[a.criterion_key] || { name: a.criterion_snapshot.name, type: a.criterion_snapshot.type, scale: a.criterion_snapshot.scale };
      var num = idx[a.criterion_key] !== undefined ? critNum(idx[a.criterion_key]) + ' ' : '';
      items += '<li><span class="cqa-history-dot is-wait">' + icon('i-scale') + '</span><div><b><a class="cqa-btn-link" href="#appeals/' + esc(a.id) + '">Апелляция №' + a.no + '</a>: ' + esc(num + c.name) + ' — ' + esc(CQA.answerText(c, a.original.answer)) + '</b>' +
        '<p>Аналитик, ' + esc(when(a.created_at)) + ': «' + esc(a.comment) + '»</p></div></li>';
      if (a.status === 'open') {
        items += '<li><span class="cqa-history-dot is-todo">' + icon('i-clock') + '</span><div><b>Ждёт решения проверяющего</b></div></li>';
      } else {
        var d = a.decision;
        items += '<li><span class="cqa-history-dot">' + icon('i-check') + '</span><div><b>Решение: ' + (a.status === 'changed'
          ? 'изменено, ' + esc(CQA.answerText(c, a.original.answer)) + ' → ' + esc(CQA.answerText(c, d.new_value))
          : 'оставлено') + '</b><p>Проверяющий, ' + esc(when(d.decided_at)) + ': «' + esc(d.reason) + '»</p></div></li>';
      }
    });
    var delta = ai.computable && fin.computable ? Math.round((fin.total - ai.total) * 100) / 100 : null;
    items += '<li><span class="cqa-history-dot">' + icon('i-target') + '</span><div><b>Финальный итог: ' + (fin.computable ? F(fin.total) : '—') +
      (delta ? ' (' + (delta > 0 ? '+' : '') + F(delta) + ')' : '') + '</b>' +
      (fin.gross.flagged !== ai.gross.flagged ? '<p>Грубая ошибка: ' + (ai.gross.flagged ? 'Да' : 'Нет') + ' → ' + (fin.gross.flagged ? 'Да' : 'Нет') + '</p>' : '') + '</div></li>';
    return '<div class="cqa-panel"><div class="cqa-panel-head"><h3>Апелляции и решения</h3></div><div class="cqa-panel-body"><ol class="cqa-history">' + items + '</ol></div></div>';
  }

  /* ---------- окно «Оспорить» ---------- */

  function pointsLine(c, row) {
    if (c.type === 'flag') return 'флаг, в баллы не входит';
    if (!row || !row.applicable) return 'не учитывается';
    return F(row.points) + ' из ' + F(row.max_points) + ' баллов';
  }

  /** Превью: как изменится итог, если согласятся на ответ v. */
  function previewText(c, v) {
    var before = card.result;
    var o = Object.assign({}, card.overrides);
    o[c.key] = v;
    var after = CQA.scoring.score(card.evalChecklist, aiValues(o));
    if (c.type === 'flag') {
      return 'Итог не меняется · Грубая ошибка: ' + (before.gross.flagged ? 'Да' : 'Нет') + ' → ' + (after.gross.flagged ? 'Да' : 'Нет');
    }
    return 'Если согласятся: итог ' + (before.computable ? F(before.total) : '—') + ' → ' + (after.computable ? F(after.total) : '—');
  }

  var modalSeq = 0;
  function openAppealModal(key) {
    if (!card.evaluation || CQA.role !== 'analyst') return;
    var cl = card.evalChecklist;
    var i = cl.criteria.findIndex(function (x) { return x.key === key; });
    var c = cl.criteria[i];
    if (!c) return;
    var a = card.evaluation.answers[key] || {};
    var row = card.result.criteria.filter(function (r) { return r.key === key; })[0];
    var opts = CQA.answerOptions(c).filter(function (v) { return !CQA.sameAnswer(v, a.answer); });
    var ev0 = (a.evidence || [])[0];
    var form = $('#ma-form');
    form.innerHTML =
      '<div class="cqa-dialog-head"><div><h2 id="ma-title">Оспорить: ' + critNum(i) + ' ' + esc(c.name) + '</h2>' +
        '<p>Проверяющий увидит ответ ИИ, ваш комментарий и фрагмент диалога.</p></div>' +
        '<button class="cqa-icon-btn" type="button" aria-label="Закрыть" data-close>' + icon('i-x', 'i') + '</button></div>' +
      '<div class="cqa-dialog-body">' +
        '<div class="cqa-box"><span class="cqa-box-label">Сейчас</span>' +
          '<span class="cqa-box-big">' + answerBadge(c, a, row) + '<span style="font-size:15px;font-weight:600">' + esc(pointsLine(c, row)) + '</span></span>' +
          '<p style="font-size:14px;color:var(--ink-2)">' + esc(a.explanation || '') + '</p>' +
          (ev0 && card.record.transcript[ev0.turn - 1] ? '<p class="cqa-muted" style="font-size:13px">№' + ev0.turn + ': «' + esc(ev0.quote) + '»</p>' : '') +
          (a.answer === 'no' && a.checked_range ? '<p class="cqa-muted" style="font-size:13px">Проверенный участок: №' + a.checked_range.from + '–№' + a.checked_range.to + '</p>' : '') +
        '</div>' +
        '<label class="cqa-field"><span class="cqa-label">Почему вы не согласны</span>' +
          '<textarea class="cqa-textarea" id="ma-comment" maxlength="2000" required placeholder="Например: оператор попрощался в реплике №12 — «Хорошего вечера!»"></textarea>' +
          '<span class="cqa-field-err" id="ma-comment-err" hidden></span>' +
          '<span class="cqa-help">Чем конкретнее, тем быстрее решение. Можно сослаться на номер реплики.</span></label>' +
        '<label class="cqa-field"><span class="cqa-label">Какой ответ верный (необязательно)</span>' +
          '<select class="cqa-select" id="ma-value"><option value="">Не знаю — пусть решит проверяющий</option>' +
            opts.map(function (v) { return '<option value="' + esc(String(v)) + '">' + esc(CQA.answerText(c, v)) + '</option>'; }).join('') +
          '</select></label>' +
        '<div class="cqa-ma-preview" id="ma-preview" hidden></div>' +
      '</div>' +
      '<div class="cqa-dialog-foot"><button class="cqa-btn cqa-btn-ghost" type="button" data-close>Отмена</button>' +
        '<button class="cqa-btn cqa-btn-dark" type="submit" id="ma-submit">' + icon('i-scale', 'i') + '<span>Отправить апелляцию</span></button></div>';
    form.dataset.key = key;
    // запоминаем диалог и оценку в момент открытия окна, а не отправки
    var dialogKey = card.key, evalId = card.evaluation.id;
    var token = String(++modalSeq);
    form.dataset.token = token;
    var sel = $('#ma-value');
    var parseVal = function (s) { return s === '' ? null : (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s); };
    $('#ma-comment').addEventListener('input', function () { $('#ma-comment-err').hidden = true; });
    sel.addEventListener('change', function () {
      var v = parseVal(sel.value);
      var p = $('#ma-preview');
      p.hidden = v === null;
      if (v !== null) p.textContent = previewText(c, v);
    });
    form.onsubmit = function (e) {
      e.preventDefault();
      var comment = $('#ma-comment').value.trim();
      var err = $('#ma-comment-err');
      if (comment.length < 5) { err.textContent = 'Напишите, почему вы не согласны (хотя бы пару слов).'; err.hidden = false; $('#ma-comment').focus(); return; }
      err.hidden = true;
      var btn = $('#ma-submit');
      btn.disabled = true;
      // пока окно было открыто, могли перейти к другому диалогу (кнопка «Назад») — тогда не отправляем
      if (card.key !== dialogKey || !card.evaluation || card.evaluation.id !== evalId) {
        btn.disabled = false;
        err.textContent = 'Открыт другой диалог. Закройте окно и оспорьте критерий заново.'; err.hidden = false;
        return;
      }
      CQA.api.post('/api/dialogs/' + encodeURIComponent(dialogKey) + '/appeals', {
        evaluation_id: evalId, criterion_key: key, comment: comment, requested_value: parseVal(sel.value), role: 'analyst'
      }).then(function (res) {
        if (form.dataset.token === token) CQA.closeModal($('#modal-appeal'));
        CQA.toast('Апелляция №' + res.appeal.no + ' отправлена проверяющему', {
          label: 'Открыть как проверяющий',
          run: function () { CQA.setRole('reviewer'); location.hash = '#appeals/' + res.appeal.id; }
        });
        document.dispatchEvent(new CustomEvent('cqa:appeals-changed'));   // карточка перечитает оценку сама
      }).catch(function (e2) {
        btn.disabled = false;
        err.textContent = e2.message; err.hidden = false;
      });
    };
    CQA.openModal('modal-appeal');
    setTimeout(function () { var t = $('#ma-comment'); if (t) t.focus(); }, 50);
  }

  /** Перечитать оценку и апелляции текущего диалога (после подачи или решения). */
  function reloadEvaluation() {
    if (!card.key || !card.record) return;
    var key = card.key, token = card.loadToken;
    CQA.api.get('/api/dialogs/' + encodeURIComponent(key) + '/evaluation').then(function (payload) {
      if (token !== card.loadToken) return;
      var openKeys = $$('#cd-side details.cqa-crit[open]').map(function (d) { return d.id; });
      setEvaluation(payload);
      refreshEvaluationUi();
      openKeys.forEach(function (id) { var d = document.getElementById(id); if (d) d.open = true; });
    }, function () { /* оценки нет — оставляем как есть */ });
  }
  document.addEventListener('cqa:appeals-changed', reloadEvaluation);
  document.addEventListener('cqa:role', function () {
    if (!card.evaluation || !card.record) return;
    var openKeys = $$('#cd-side details.cqa-crit[open]').map(function (d) { return d.id; });
    refreshEvaluationUi();
    openKeys.forEach(function (id) { var d = document.getElementById(id); if (d) d.open = true; });
  });

  function criterionHtml(c, i, row) {
    var a = card.evaluation.answers[c.key] || {};
    var ap = appealFor(c.key);
    var changed = ap && ap.status === 'changed';
    var eff = changed ? Object.assign({}, a, { answer: ap.decision.new_value }) : a;   // финальный ответ
    var issues = a.issues || [];
    var partial = typeof eff.answer === 'number' && row && row.points !== null && row.points < row.max_points;
    var open = Boolean(ap) || issues.length > 0 || eff.answer === 'no' || eff.answer === 'na' || partial || (c.type === 'flag' && eff.answer === 'yes');
    var pts = c.type === 'flag' ? '<small>флаг</small>'
      : (row && row.applicable ? F(row.points) + ' <small>/ ' + F(row.max_points) + '</small>' : '<small>не учитывается</small>');

    var body = (ap ? appealNoteHtml(c, a, ap) : '') +
      '<p class="cqa-crit-why">' + (changed ? '<b>ИИ:</b> ' : '') + esc(a.explanation || '') + '</p>';
    (a.evidence || []).forEach(function (e) { body += quoteHtml(e); });
    if (a.answer === 'no' && a.checked_range) {
      body += '<button class="cqa-quote cqa-quote-btn is-miss" type="button" data-range="' + a.checked_range.from + '-' + a.checked_range.to + '">' +
        '<span class="cqa-quote-meta">Проверенный участок: №' + a.checked_range.from + (a.checked_range.to !== a.checked_range.from ? '–№' + a.checked_range.to : '') + '</span>' +
        '<span class="cqa-quote-text">Здесь ожидалось действие — не найдено. Нажмите, чтобы подсветить участок.</span></button>';
    }
    if (a.answer === 'na') {
      body += '<div class="cqa-quote is-na"><span class="cqa-quote-meta">Условие N/A выполнено</span>' +
        '<span class="cqa-quote-text">' + esc(c.na_condition || a.na_reason || '') + (a.na_reason && a.na_reason !== c.na_condition ? ' — ' + esc(a.na_reason) : '') + '</span></div>';
    }
    if (issues.length) {
      body += '<div class="cqa-appeal-note">' + icon('i-alert', 'i') + '<p><b>Нужна проверка человеком:</b> ' + esc(issues.join('; ')) + '</p></div>';
    } else if (a.confidence === 'low') {
      body += '<div class="cqa-appeal-note">' + icon('i-alert', 'i') + '<p><b>Низкая уверенность.</b> Проверьте ответ вручную.</p></div>';
    }
    var foot;
    if (c.type === 'flag') foot = 'Флаг: в баллы не входит, отмечается отдельно';
    else if (typeof eff.answer === 'number') {
      var step = (c.scale || []).filter(function (st) { return Number(st.points) === eff.answer; })[0];
      foot = 'Ступень ' + eff.answer + (step ? ': «' + esc(step.text) + '»' : '') + ' · Вес ' + c.weight +
        (row && row.applicable && Math.abs(row.max_points - row.weight) > 1e-9 ? ', после перераспределения N/A — ' + F(row.max_points) : '');
    } else if (row && row.applicable && Math.abs(row.max_points - row.weight) > 1e-9) foot = 'Вес ' + row.weight + ', после перераспределения N/A — ' + F(row.max_points);
    else if (eff.answer === 'na') foot = 'Вес ' + c.weight + ' разделён между применимыми критериями';
    else foot = 'Вес ' + c.weight;

    var firstEv = (a.evidence || [])[0];
    var showBtn = firstEv ? '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm" type="button" data-jump-n="' + firstEv.turn + '">' + icon('i-target') + 'Показать в переписке</button>'
      : (a.checked_range ? '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm" type="button" data-range="' + a.checked_range.from + '-' + a.checked_range.to + '">' + icon('i-target') + 'Показать участок</button>' : '');

    return '<details class="cqa-crit' + (issues.length ? ' has-issues' : '') + '" id="cr-' + esc(c.key) + '"' + (open ? ' open' : '') + '>' +
      '<summary><span class="cqa-crit-no">' + critNum(i) + '</span><span class="cqa-crit-name">' + esc(c.name) + '</span>' +
        (changed ? '<s class="cqa-ans-was" title="Ответ ИИ до апелляции">' + esc(CQA.answerText(c, a.answer)) + '</s>' : '') +
        answerBadge(c, eff, row) + (ap && ap.status === 'open' ? '<span class="cqa-chip cqa-chip-amber cqa-chip-xs">апелляция</span>' : '') +
        '<span class="cqa-crit-pts">' + pts + '</span>' + icon('i-chev', 'i-sm cqa-crit-chev') + '</summary>' +
      '<div class="cqa-crit-body">' + body +
        '<div class="cqa-crit-foot"><span>' + foot + '</span><div class="cqa-crit-actions">' + showBtn + appealButtonHtml(c, ap) +
        '</div></div>' +
      '</div></details>';
  }

  function resultHtml() {
    var ev = card.evaluation, cl = card.evalChecklist, r = card.result;
    var rows = {};
    r.criteria.forEach(function (row) { rows[row.key] = row; });
    var idx = {};
    cl.criteria.forEach(function (c, i) { idx[c.key] = i; });

    // итог
    var head;
    if (r.computable) {
      var g = gradeOf(r.total);
      var lost = cl.criteria.filter(function (c) { var row = rows[c.key]; return row && row.applicable && row.points < row.max_points - 1e-9; })
        .map(function (c) { return critNum(idx[c.key]) + ' ' + shortName(c.name); });
      head = '<div class="cqa-total-num ' + g.cls + '"><b>' + F(r.total) + '</b><span>из 100</span></div>' +
        '<div class="cqa-total-grade">' + g.text + (lost.length ? '. Снижено: ' + esc(lost.join(', ')) + (/…$/.test(lost[lost.length - 1]) ? '' : '.') : '. Все применимые критерии выполнены.') + '</div>' +
        (hasOverrides() ? '<div class="cqa-total-ai">' + icon('i-scale') + 'Итог после апелляции. ИИ ставил ' + (card.aiResult.computable ? F(card.aiResult.total) : '—') + '</div>' : '');
    } else {
      head = '<div class="cqa-total-num is-none"><b>—</b><span>итог не рассчитан</span></div><div class="cqa-total-grade">' + esc(r.reason) + '</div>';
    }
    var src = ev.source === 'mock'
      ? '<span class="cqa-chip cqa-chip-amber" title="Сделана простыми правилами по ключевым словам, не ИИ">Подставная оценка</span>'
      : '<span class="cqa-chip cqa-chip-outline cqa-chip-wrap" title="' + esc(aiTitle(ev)) + '">ИИ: ' + esc(CQA.shortModel(ev.model)) + '</span>' +
        (ev.usage && ev.usage.cost_usd > 0 ? '<span class="cqa-chip cqa-chip-outline" title="Стоимость этой оценки по данным OpenRouter">' + money(ev.usage.cost_usd) + '</span>' : '') +
        appealExamplesChip(ev, cl);
    var when = new Date(ev.created_at);
    var whenTxt = isNaN(when) ? '' : when.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

    // полоса вклада критериев
    var bar = '';
    var naNames = [];
    if (r.computable) {
      bar = cl.criteria.map(function (c) {
        var row = rows[c.key];
        if (!row || !row.applicable) { if (row && row.answer === 'na') naNames.push(critNum(idx[c.key])); return ''; }
        var fill = row.max_points > 0 ? Math.round(row.points / row.max_points * 100) : 0;
        return '<button type="button" class="cqa-contrib-seg' + (fill === 0 ? ' is-zero' : fill < 100 ? ' is-partial' : '') + '" style="flex:' + row.max_points.toFixed(3) + '" data-crit-key="' + esc(c.key) + '" title="' + esc(critNum(idx[c.key]) + ' ' + c.name + ': ' + F(row.points) + ' из ' + F(row.max_points)) + '">' +
          '<i style="width:' + fill + '%"></i><span>' + critNum(idx[c.key]) + '</span></button>';
      }).join('');
    }
    var naNote = naNames.length
      ? '<div class="cqa-contrib-na"><span class="cqa-contrib-na-sw" aria-hidden="true"></span>Не применимы (N/A): ' + naNames.join(', ') + '. Их вес разделён между остальными — максимум остался 100.</div>' : '';

    var html = '<div class="cqa-total">' +
      '<div class="cqa-total-top"><div><div class="cqa-total-label">Итоговый балл</div>' + head + '</div>' +
        '<div class="cqa-total-side">' + src +
          (whenTxt ? '<span class="cqa-chip cqa-chip-outline">' + esc(whenTxt) + '</span>' : '') +
          '<span class="cqa-chip cqa-chip-outline cqa-chip-wrap">Чек-лист: ' + esc(ev.checklist.name || cl.name) + ', версия ' + ev.checklist.version + (cl.deleted ? ' (удалён)' : '') + '</span>' +
        '</div></div>' +
      (bar ? '<div class="cqa-contrib" aria-label="Вклад критериев в итог"><div class="cqa-contrib-bar">' + bar + '</div>' +
        '<div class="cqa-contrib-legend"><span><i class="cqa-sw" style="background:var(--leaf);border-color:var(--leaf)"></i>Получено</span>' +
        '<span><i class="cqa-sw" style="background:#DCE7E0"></i>Потеряно</span><span><i class="cqa-sw" style="background:var(--red-soft);border-color:#EBC3BA"></i>Ноль баллов</span></div>' + naNote + '</div>' : '') +
      '<details class="cqa-how"><summary>' + icon('i-help') + 'Как считается итог</summary><ul>' +
        '<li>«Да» даёт полный вес критерия, «Нет» — ноль.</li>' +
        '<li>Шкала пересчитывается пропорционально: 15 из 20 — это 75% веса.</li>' +
        '<li>N/A не учитывается, его вес делится между остальными критериями.</li>' +
        '<li>Итог округляется до двух знаков. Грубые ошибки отмечаются отдельно и в баллы не входят.</li></ul></details>' +
      '<div class="cqa-total-actions">' +
        (CQA.ai.available ? CQA.appealsToggleHtml() : '') +
        (ev.source !== 'ai' && CQA.ai.available ? '<button class="cqa-btn cqa-btn-primary cqa-btn-sm" type="button" data-evaluate="ai">' + icon('i-spark') + '<span>Оценить ИИ</span></button>' : '') +
        '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm" type="button" data-evaluate="' + (ev.source === 'ai' ? 'ai' : 'mock') + '" data-force="1">' + icon('i-refresh') + '<span>Оценить заново</span></button></div>' +
    '</div>';

    if (ev.source === 'mock') {
      html += '<div class="cqa-mock-note">' + icon('i-alert', 'i') + '<p><b>Это подставная оценка.</b> Её сделали простые правила по ключевым словам, а не ИИ — чтобы проверить экран и переходы к репликам. ' + (CQA.ai.available ? 'Для настоящей оценки нажмите «Оценить ИИ».' : 'Чтобы оценивал ИИ, добавьте OPENROUTER_API_KEY в .env и перезапустите сервер.') + '</p></div>';
    }

    // грубые ошибки
    var grossRows = cl.criteria.filter(function (c) { return c.type === 'flag'; });
    if (grossRows.length) {
      var flagged = r.gross.flagged;
      // доказательства только тех флагов, что «Да» в финальном итоге (снятый проверяющим флаг не показываем)
      var gEv = grossRows.filter(function (c) {
        var fin = card.overrides && card.overrides[c.key] !== undefined ? card.overrides[c.key] : (card.evaluation.answers[c.key] || {}).answer;
        return fin === 'yes';
      }).map(function (c) { return (card.evaluation.answers[c.key] || {}).evidence || []; }).reduce(function (a, b) { return a.concat(b); }, []);
      html += '<div class="cqa-gross' + (flagged ? ' is-bad' : '') + '" role="status"><span class="cqa-gross-icon">' + icon(flagged ? 'i-alert' : 'i-shield', 'i') + '</span>' +
        '<div><b>' + (flagged ? 'Найдена грубая ошибка' : 'Грубых ошибок нет') + '</b>' +
        '<p>' + (flagged ? 'Отмечается отдельно и итог не меняет. Проверьте вручную.' : 'Проверено: оскорбления клиента, услуги в обход компании, раскрытие конфиденциальных данных.') + '</p>' +
        (flagged && gEv[0] ? '<button class="cqa-btn-link" type="button" data-jump-n="' + gEv[0].turn + '">Показать реплику №' + gEv[0].turn + '</button>' : '') +
        '</div></div>';
    }

    // нужна проверка
    var needs = cl.criteria.filter(function (c) { var a = card.evaluation.answers[c.key] || {}; return (a.issues && a.issues.length) || a.confidence === 'low'; });
    if (needs.length) {
      html += '<div class="cqa-review-note">' + icon('i-alert', 'i') + '<p><b>Нужна проверка человеком:</b> ' +
        needs.map(function (c) { return '<button class="cqa-btn-link" type="button" data-crit-key="' + esc(c.key) + '">' + critNum(idx[c.key]) + ' ' + esc(shortName(c.name)) + '</button>'; }).join(', ') + '</p></div>';
    }

    // разделы
    r.sections.forEach(function (sec) {
      var items = cl.criteria.filter(function (c) { return c.section === sec.key; });
      if (!items.length) return;
      html += '<div class="cqa-section"><div class="cqa-section-head"><span class="cqa-section-name">' + esc(sec.name) + '</span>' +
        '<span class="cqa-section-score">' + (sec.scored ? (sec.points !== null ? F(sec.points) + ' <small>из ' + F(sec.max) + '</small>' : '<small>не учитывается (N/A)</small>') : '<small>без баллов</small>') + '</span></div>' +
        items.map(function (c) { return criterionHtml(c, idx[c.key], rows[c.key]); }).join('') + '</div>';
    });

    html += appealsHistoryHtml(idx);

    if (card.evalHistory.length > 1) {
      html += '<div class="cqa-panel"><div class="cqa-panel-head"><h3>История оценок</h3></div><div class="cqa-panel-body"><ol class="cqa-history">' +
        card.evalHistory.slice().reverse().map(function (h, k) {
          var d = new Date(h.created_at);
          return '<li><span class="cqa-history-dot' + (k ? ' is-todo' : '') + '">' + icon(k ? 'i-clock' : 'i-check') + '</span><div><b>' + (k === 0 && hasOverrides()
            ? (card.result.computable ? F(card.result.total) : 'Итог не рассчитан') + ' — текущая, после апелляции (ИИ: ' + (h.total === null ? '—' : F(h.total)) + ')'
            : (h.total === null ? 'Итог не рассчитан' : F(h.total)) + (k ? '' : ' — текущая')) + '</b>' +
            '<p>' + esc(isNaN(d) ? '' : d.toLocaleString('ru-RU')) + ', ' + (h.source === 'mock' ? 'подставная' : 'ИИ') + ', чек-лист v' + h.checklist.version + '</p></div></li>';
        }).join('') + '</ol></div></div>';
    }
    return html;
  }

  /** Метки в переписке: у реплик-доказательств — «03 Идентификация: Да», в месте пропуска — плашка. */
  function decorateTranscript() {
    var body = $('#cd-tx');
    if (!body) return;
    body.querySelectorAll('[data-gen]').forEach(function (el) { el.remove(); });
    body.querySelectorAll('.is-evidence, .is-range').forEach(function (el) { el.classList.remove('is-evidence', 'is-range'); });
    if (!card.evaluation || !card.evalChecklist) return;
    var cl = card.evalChecklist;
    cl.criteria.forEach(function (c, i) {
      var raw = card.evaluation.answers[c.key];
      if (!raw) return;
      // метки показывают финальный ответ (после решения по апелляции), доказательства — от ИИ
      var a = card.overrides && card.overrides[c.key] !== undefined ? Object.assign({}, raw, { answer: card.overrides[c.key] }) : raw;
      var label = critNum(i) + ' ' + shortName(c.name) + ': ' + tagLabel(c, a) + (a !== raw ? ' (после апелляции)' : '');
      (a.evidence || []).forEach(function (e) {
        var el = document.getElementById('m-' + e.turn);
        if (!el) return;
        el.classList.add('is-evidence');
        var host = el.classList.contains('cqa-event') ? null : el;
        var tags = host ? host.querySelector('.cqa-ev-tags[data-gen]') : (el.nextElementSibling && el.nextElementSibling.matches('.cqa-ev-tags[data-gen]') ? el.nextElementSibling : null);
        if (!tags) {
          tags = document.createElement('div');
          tags.className = 'cqa-ev-tags' + (host ? '' : ' is-standalone');
          tags.setAttribute('data-gen', '');
          if (host) {
            var more = host.querySelector('.cqa-msg-more');
            host.insertBefore(tags, more || null);
          } else el.parentNode.insertBefore(tags, el.nextSibling);
        }
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'cqa-ev-tag' + tagClass(c, a);
        b.setAttribute('data-crit-key', c.key);
        b.textContent = label;
        tags.appendChild(b);
      });
      if (a.answer === 'no' && a.checked_range && c.type !== 'flag') {
        var end = document.getElementById('m-' + a.checked_range.to);
        if (!end) return;
        var anchor = end.nextElementSibling && end.nextElementSibling.matches('.cqa-ev-tags[data-gen]') ? end.nextElementSibling : end;
        // несколько плашек после одной реплики — в порядке критериев (01, 05, 07…)
        while (anchor.nextElementSibling && anchor.nextElementSibling.matches('.cqa-miss[data-gen]')) anchor = anchor.nextElementSibling;
        var miss = document.createElement('div');
        miss.className = 'cqa-miss';
        miss.setAttribute('data-gen', '');
        miss.id = 'miss-' + c.key;
        miss.innerHTML = icon('i-target', 'i') + '<div><strong>' + esc(critNum(i) + ' ' + c.name) + ': здесь ожидалось действие</strong>' +
          '<p>Проверен участок №' + a.checked_range.from + (a.checked_range.to !== a.checked_range.from ? '–№' + a.checked_range.to : '') + '. ' + esc(a.explanation || '') + '</p>' +
          '<button class="cqa-btn-link" type="button" data-crit-key="' + esc(c.key) + '">Открыть критерий</button></div>';
        anchor.parentNode.insertBefore(miss, anchor.nextSibling);
      }
    });
  }

  /** Раскрыть критерий в панели результата и прокрутить к нему. */
  function openCriterion(key) {
    var d = document.getElementById('cr-' + key);
    if (!d) return;
    d.open = true;
    d.scrollIntoView({ block: 'center', behavior: 'smooth' });
    d.classList.remove('is-flash'); void d.offsetWidth; d.classList.add('is-flash');
  }

  function refreshEvaluationUi() {
    renderSide();
    decorateTranscript();
    var stEl = $('#cd-status');
    if (stEl) stEl.innerHTML = statusChipHtml();
  }

  /** Чип «Учтены апелляции»: какие решения проверяющего ушли в запрос к ИИ как примеры. */
  function appealExamplesChip(ev, cl) {
    var ex = ev && ev.usage && ev.usage.appeal_examples;
    if (!ex || !Object.keys(ex).length) return '';
    var names = {};
    ((cl && cl.criteria) || []).forEach(function (c) { names[c.key] = c.name; });
    var nos = [];
    var lines = Object.keys(ex).map(function (k) {
      ex[k].forEach(function (n) { if (nos.indexOf(n) === -1) nos.push(n); });
      return (names[k] || k) + ': апелляции №' + ex[k].join(', №');
    });
    return '<span class="cqa-chip cqa-chip-blue cqa-chip-wrap" title="' + esc('ИИ получил как примеры решения проверяющего по прошлым апелляциям (другие диалоги):\n' + lines.join('\n')) + '">' +
      icon('i-scale') + 'Учтены апелляции: №' + nos.join(', №') + '</span>';
  }

  /** Подсказка к чипу модели: провайдер, токены, что взято из прошлой оценки. */
  function aiTitle(ev) {
    var u = ev.usage || {};
    var parts = ['Модель: ' + (ev.model || '')];
    if (u.provider) parts.push('провайдер: ' + u.provider);
    if (u.calls) parts.push('запросов: ' + u.calls);
    if (u.input_tokens || u.output_tokens) parts.push('токенов: ' + (u.input_tokens || 0) + ' на входе, ' + (u.output_tokens || 0) + ' на выходе');
    if (u.reused && u.reused.length) parts.push('без изменений взято из прошлой оценки: ' + u.reused.length + ' крит.');
    if (u.retried && u.retried.length) parts.push('переспрошено: ' + u.retried.length + ' крит.');
    return parts.join('; ');
  }

  /** Оценить диалог: mode "ai" (OpenRouter) или "mock" (подставная по правилам). */
  function evaluateNow(btn) {
    if (!card.key || btn.disabled || pending[card.key]) return;
    var key = card.key;
    var token = card.loadToken;
    var mode = btn.dataset.evaluate === 'ai' ? 'ai' : 'mock';
    pending[key] = mode;
    var force = btn.dataset.force === '1';
    var group = btn.closest('.cqa-total-actions, .cqa-noeval-actions') || btn.parentNode;
    var siblings = group ? Array.prototype.slice.call(group.querySelectorAll('[data-evaluate]')) : [btn];
    siblings.forEach(function (b) { b.disabled = true; });
    var label = btn.querySelector('span');
    if (label) label.textContent = mode === 'ai' ? 'ИИ оценивает…' : 'Оцениваю…';
    var closedAppeals = 0;
    var useAppeals = mode === 'ai' && CQA.useAppeals;
    CQA.api.post('/api/dialogs/' + encodeURIComponent(key) + '/evaluate', { mode: mode, force: force, use_appeals: useAppeals }).then(function (res) {
      closedAppeals = (res && res.appeals_closed) || 0;
      return CQA.api.get('/api/dialogs/' + encodeURIComponent(key) + '/evaluation');
    }).then(function (payload) {
      delete pending[key];
      var here = token === card.loadToken;
      var ev = payload && payload.evaluation;
      var u = ev && ev.usage;
      var total = ev && ev.result && ev.result.computable ? F(ev.result.total) : 'итог не рассчитан';
      if (here) { setEvaluation(payload); refreshEvaluationUi(); }
      // тост и обновление списка — даже если карточку уже закрыли (оценка оплачена, её нельзя терять)
      CQA.toast('Готово: ' + (mode === 'ai' ? 'оценка ИИ' : 'подставная оценка') + (here ? '' : ' диалога ' + key.split(':').pop()) + ' — ' + total +
        (u && u.cost_usd > 0 ? ' · ' + money(u.cost_usd) : '') +
        (u && u.reused && u.reused.length && !(u.asked && u.asked.length) ? ' (ничего не изменилось — взято из прошлой оценки)' : '') +
        (useAppeals ? (u && u.appeal_examples ? ' · учтены апелляции: ' + Object.keys(u.appeal_examples).length + ' крит.' : ' · подходящих решений по апелляциям нет') : '') +
        (closedAppeals ? '. Открытые апелляции закрыты: ' + closedAppeals + ' (оценка обновилась)' : ''));
      if (closedAppeals) document.dispatchEvent(new CustomEvent('cqa:appeals-changed'));
      document.dispatchEvent(new CustomEvent('cqa:evaluations-changed'));
    }).catch(function (err) {
      delete pending[key];
      CQA.toast(err.message);
      if (token !== card.loadToken) return;
      $$('#cd-side [data-evaluate]').forEach(function (b) { b.disabled = false; });
      if (label && label.isConnected) label.textContent = 'Попробовать ещё раз';
    });
  }

  /* ---------- переход к реплике ---------- */

  function flashEl(el) {
    el.classList.remove('is-flash');
    void el.offsetWidth;
    el.classList.add('is-flash');
  }

  /** Прокручивает переписку к реплике; withPage — ещё и страницу, если реплика вне экрана. */
  function scrollIntoBody(el, instant, withPage) {
    var body = $('#cd-tx');
    var target = el.offsetTop - body.offsetTop - body.clientHeight / 2 + el.offsetHeight / 2;
    body.scrollTo({ top: Math.max(0, target), behavior: instant ? 'auto' : 'smooth' });
    if (!withPage) return;
    // Если блок переписки целиком на экране (компьютер) — хватит внутренней прокрутки.
    // Иначе (телефон, узкое окно) просим браузер показать реплику по центру экрана.
    var b = body.getBoundingClientRect();
    if (b.top >= 0 && b.bottom <= window.innerHeight) return;
    var player = $('#cd-player');
    var sticky = player && !player.hidden && getComputedStyle(player).position === 'sticky';
    if (sticky) {
      // Закреплённый плеер закрывает верх экрана: ставим реплику сразу под ним (через scroll-margin-top).
      document.documentElement.style.setProperty('--cqa-player-h', Math.round(player.getBoundingClientRect().bottom) + 'px');
      el.scrollIntoView({ block: 'start', behavior: instant ? 'auto' : 'smooth' });
    } else {
      el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
    }
  }

  /** Перейти к реплике №n: прокрутить, подсветить, у звонка — перемотать запись. */
  function jumpTo(n, opts) {
    opts = opts || {};
    var el = document.getElementById('m-' + n);
    if (!el || !card.record) return false;
    if (!opts.keepRange) clearRange();
    scrollIntoBody(el, opts.instant, true);
    if (opts.flash !== false) flashEl(el);
    if (card.isCall && card.audio) {
      var span = card.map.spans[n - 1];
      var point = card.map.points[n - 1];
      var at = span ? span.start : point;
      if (typeof at === 'number' && at >= 0) seek(at, opts.play);
    }
    return true;
  }

  /** Подсветить участок реплик from..to (например, «здесь ожидалось действие»). */
  function clearRange() {
    document.querySelectorAll('#cd-tx .is-range').forEach(function (x) { x.classList.remove('is-range'); });
  }

  function jumpToRange(from, to) {
    clearRange();
    for (var n = from; n <= to; n++) {
      var el = document.getElementById('m-' + n);
      if (el) el.classList.add('is-range');
    }
    return jumpTo(from, { flash: false, keepRange: true });
  }

  CQA.card = { jumpTo: jumpTo, jumpToRange: jumpToRange };

  // Клик по реплике в панели «Голос оператора» — переход к ней (и к месту записи).
  var voiceBox = document.getElementById('cd-voice');
  if (voiceBox) voiceBox.addEventListener('click', function (e) {
    var b = e.target.closest('[data-voice-jump]');
    if (!b) return;
    card.userMoved = true;
    jumpTo(Number(b.dataset.voiceJump), { flash: true });
  });

  /* ---------- плеер ---------- */

  function stopAudio() {
    if (card.audio) {
      card.audio.pause();
      card.audio.removeAttribute('src');
      card.audio.load();
      card.audio = null;
    }
    cancelAnimationFrame(card.raf);
  }

  function totalDuration() {
    var d = card.map ? card.map.duration : 0;
    if (card.audio && isFinite(card.audio.duration)) d = Math.max(d, card.audio.duration);
    return Math.max(d, 1);
  }

  function pct(sec) { return Math.max(0, Math.min(100, sec / totalDuration() * 100)); }

  function renderPlayer() {
    var map = card.map;
    var lanes = { client: [], operator: [], bot: [] };
    card.record.transcript.forEach(function (t, i) {
      var s = map.spans[i];
      if (!s || !lanes[t.speaker]) return;
      lanes[t.speaker].push('<i data-i="' + i + '" style="left:' + pct(s.start).toFixed(3) + '%;width:' + Math.max(0.25, pct(s.end) - pct(s.start)).toFixed(3) + '%" title="№' + (i + 1) + ' ' + ROLE_NAMES[t.speaker] + ', ' + TL.formatClock(s.start) + '–' + TL.formatClock(s.end) + '"></i>');
    });
    var zones = map.zones().map(function (z) {
      return '<span class="cqa-zone is-' + z.type + '" style="left:' + pct(z.start).toFixed(3) + '%;width:' + Math.max(0.3, pct(z.end) - pct(z.start)).toFixed(3) + '%" title="' +
        (z.type === 'hold' ? 'Клиент на удержании' : 'Пауза записи') + '"><em>' + (z.type === 'hold' ? 'Удержание' : 'Пауза') + '</em></span>';
    }).join('');

    var total = totalDuration();
    // Шаг подписей шкалы — по ширине дорожки, чтобы подписи не слипались (минимум ~64 px на подпись).
    var width = Math.max(200, ($('#cd-player').clientWidth || 900) - 110);
    var steps = [10, 15, 30, 60, 120, 300, 600, 1200];
    var step = steps[steps.length - 1];
    for (var si = 0; si < steps.length; si++) { if (width * steps[si] / total >= 64) { step = steps[si]; break; } }
    var ticks = '';
    for (var t = 0; t <= total; t += step) ticks += '<span style="left:' + pct(t).toFixed(3) + '%">' + TL.formatClock(t) + '</span>';

    $('#cd-player').innerHTML =
      '<div class="cqa-lanes">' +
        '<div class="cqa-lane-labels"><span>Клиент</span><span>Оператор</span><span>Бот</span></div>' +
        '<div class="cqa-lane-area" id="cd-area" title="Нажмите, чтобы перемотать">' +
          '<div class="cqa-lane-track is-client">' + lanes.client.join('') + '</div>' +
          '<div class="cqa-lane-track is-operator">' + lanes.operator.join('') + '</div>' +
          '<div class="cqa-lane-track is-bot">' + lanes.bot.join('') + '</div>' +
          zones +
          '<span class="cqa-playhead" id="cd-head" style="left:0%"></span>' +
        '</div>' +
        '<div class="cqa-lane-ticks">' + ticks + '</div>' +
      '</div>' +
      '<div class="cqa-pl-row">' +
        '<button class="cqa-play-btn" type="button" id="cd-play" aria-label="Слушать запись" disabled>' + icon('i-play', 'i-fill') + '</button>' +
        '<span class="cqa-time" id="cd-time">00:00 / ' + TL.formatClock(total) + '</span>' +
        '<input class="cqa-pl-seek" id="cd-seek" type="range" min="0" max="' + Math.ceil(total) + '" step="0.1" value="0" aria-label="Позиция в записи" disabled>' +
        '<label class="cqa-pl-speed"><span class="sr-only">Скорость</span><select class="cqa-select" id="cd-speed">' +
          '<option value="1">1×</option><option value="1.25">1,25×</option><option value="1.5">1,5×</option><option value="2">2×</option></select></label>' +
        '<label class="cqa-toggle cqa-pl-follow"><input type="checkbox" id="cd-follow"' + (card.follow ? ' checked' : '') + '><span class="cqa-toggle-track"></span>Следить за текстом</label>' +
      '</div>' +
      '<div class="cqa-pl-status" id="cd-audio-status" role="status" aria-live="polite"><span class="cqa-spin" aria-hidden="true"></span> Готовлю запись…</div>' +
      '<p class="cqa-pl-note"><span>Нажмите на реплику или отрезок дорожки — запись перемотается к этому месту.</span> <span id="cd-sync-note"></span></p>';
  }

  function audioStatus(html, kind) {
    var el = $('#cd-audio-status');
    if (!el) return;
    el.className = 'cqa-pl-status' + (kind ? ' is-' + kind : '');
    el.innerHTML = html;
    el.hidden = !html;
  }

  function fallbackHtml(reason) {
    var url = card.record && card.record.audio_url;
    return icon('i-alert') + '<span>' + esc(reason) + '</span>' +
      (url ? ' <a class="cqa-btn cqa-btn-ghost cqa-btn-sm" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + icon('i-link') + 'Открыть запись у организаторов</a>' : '');
  }

  function initAudio(token) {
    if (!card.record.audio_url) {
      audioStatus(icon('i-alert') + '<span>У этого звонка нет ссылки на запись. Дорожки построены по расшифровке.</span>', 'warn');
      return;
    }
    var base = '/api/dialogs/' + encodeURIComponent(card.key) + '/audio';
    CQA.api.get(base + '/status').then(function (st) {
      if (token !== card.loadToken) return null;
      if (st.state === 'ready') return st;
      audioStatus('<span class="cqa-spin" aria-hidden="true"></span> Скачиваю запись у организаторов… это займёт несколько секунд.');
      return CQA.api.post(base + '/fetch', {});
    }).then(function (st) {
      if (!st || token !== card.loadToken) return;
      if (st.state !== 'ready') {
        audioStatus(fallbackHtml('Не удалось скачать запись: ' + (st.error || 'неизвестная ошибка') + '.'), 'error');
        return;
      }
      attachAudio(base, token);
    }).catch(function (err) {
      if (token !== card.loadToken) return;
      audioStatus(fallbackHtml(err.message), 'error');
    });
  }

  function attachAudio(src, token) {
    var a = new Audio();
    a.preload = 'auto';
    a.src = (window.CQA_CONFIG && window.CQA_CONFIG.apiBase || '').replace(/\/$/, '') + src;
    card.audio = a;
    a.playbackRate = Number($('#cd-speed').value) || 1;

    a.addEventListener('loadedmetadata', function () {
      if (token !== card.loadToken) return;
      var seekEl = $('#cd-seek');
      seekEl.max = Math.ceil(totalDuration());
      seekEl.disabled = false;
      $('#cd-play').disabled = false;
      audioStatus('');
      renderPlayerSegmentsOnly();
      updateClock();
      // Если карточку открыли ссылкой на реплику (или событие) — встаём на неё тем же правилом, что и jumpTo.
      var target = /\/m-(\d+)$/.exec(location.hash);
      if (target) jumpTo(Number(target[1]), { flash: false, instant: true, keepRange: true });
      calibrate(a.src, token);
    });
    a.addEventListener('play', function () { setPlayIcon(true); tick(); });
    a.addEventListener('pause', function () { setPlayIcon(false); cancelAnimationFrame(card.raf); updateClock(); });
    a.addEventListener('ended', function () { setPlayIcon(false); });
    a.addEventListener('timeupdate', updateClock);
    a.addEventListener('error', function () {
      if (token !== card.loadToken) return;
      audioStatus(fallbackHtml('Браузер не смог проиграть файл записи.'), 'error');
    });
  }

  /*
   * Автоподстройка: задержка меток немного отличается от звонка к звонку (0–1,2 с).
   * Браузер анализирует громкость записи, находит концы фраз и подбирает сдвиг,
   * при котором реплики лучше всего совпадают с речью. Если что-то пошло не так —
   * остаётся базовое правило, плеер работает как прежде.
   */
  function calibrate(src, token) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !window.fetch) return;
    fetch(src).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      var ctx = new Ctx();
      return new Promise(function (resolve, reject) { ctx.decodeAudioData(buf, resolve, reject); })
        .then(function (decoded) { if (ctx.close) ctx.close(); return decoded; });
    }).then(function (decoded) {
      if (token !== card.loadToken) return;
      var segs = TL.detectSpeechSegments(decoded.getChannelData(0), decoded.sampleRate);
      var ends = segs.map(function (s) { return s[1]; });
      var onsets = segs.map(function (s) { return s[0]; });
      var res = TL.bestShift(card.record.transcript, ends);
      card.calibration = res;

      // Новое соответствие: поправка + начала реплик привязаны к началу речи в записи.
      var prev = card.map;
      var next = TL.buildAudioMap(card.record.transcript, { shift: res.shift, onsets: onsets });
      var sameShape = prev.spans.every(function (s, i) { return Boolean(s) === Boolean(next.spans[i]); });
      card.map = next;
      if (sameShape) {
        updateTimeLabels();            // разметку не трогаем: раскрытые сообщения, подсветки и прокрутка остаются
      } else {
        var body = $('#cd-tx');
        var top = body.scrollTop;
        renderTranscript();
        body.scrollTop = top;
      }
      renderPlayerSegmentsOnly();
      card.playingIdx = -1;
      // Голос оператора: замер по уже декодированной записи (без ИИ, звук никуда не уходит).
      try {
        if (window.CQA.voice) {
          var holds = next.zones().filter(function (z) { return z.type === 'hold'; }).map(function (z) { return [z.start, z.end]; });
          card.voice = window.CQA.voice.analyze(decoded.getChannelData(0), decoded.sampleRate, card.record.transcript, next.spans, { holds: holds });
        }
      } catch (e) { card.voice = { error: true }; }
      renderVoice();
      injectVoiceChips();
      // Ссылку на реплику применяем заново, только если пользователь ещё ничего не трогал.
      var target = /\/m-(\d+)$/.exec(location.hash);
      if (target && !card.userMoved) jumpTo(Number(target[1]), { flash: false, instant: true, keepRange: true });
      updateClock();
      var note = $('#cd-sync-note');
      if (note) {
        note.textContent = 'Текст сверен со звуком: совпадение фраз ' + Math.round(res.after * 100) + '%' +
          (res.shift ? ' (поправка ' + (res.shift > 0 ? '+' : '') + String(res.shift).replace('.', ',') + ' с)' : '') + '.';
      }
    }).catch(function () { /* без подстройки — работает базовое правило */ });
  }

  /** Обновляет подписи времени у реплик без перерисовки переписки. */
  function updateTimeLabels() {
    card.record.transcript.forEach(function (t, i) {
      var el = document.getElementById('m-' + (i + 1));
      if (!el) return;
      var tl = timeLabel(t, i);
      var btn = el.querySelector('.cqa-msg-time');
      if (btn) { btn.innerHTML = icon('i-play', 'i-xs i-fill') + esc(tl.text); btn.title = tl.title + '. Слушать с этого места'; return; }
      var lbl = el.querySelector('.cqa-msg-ts, .cqa-event-time, .cqa-msg-bubble > span[title]');
      if (lbl) { lbl.textContent = tl.text; lbl.title = tl.title; }
    });
  }

  // После загрузки длительности пересчитываем положение отрезков (шкала могла измениться).
  function renderPlayerSegmentsOnly() {
    var keepFollow = card.follow;
    var speed = $('#cd-speed').value;
    var sync = $('#cd-sync-note') ? $('#cd-sync-note').textContent : '';
    renderPlayer();
    $('#cd-speed').value = speed;
    $('#cd-follow').checked = keepFollow;
    $('#cd-play').disabled = false;
    $('#cd-seek').disabled = false;
    $('#cd-sync-note').textContent = sync;
    audioStatus('');
    setPlayIcon(Boolean(card.audio && !card.audio.paused));
    card.playingIdx = -1;
  }

  function setPlayIcon(playing) {
    var b = $('#cd-play');
    if (!b) return;
    b.innerHTML = playing
      ? '<svg class="i i-fill" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : icon('i-play', 'i-fill');
    b.setAttribute('aria-label', playing ? 'Пауза' : 'Слушать запись');
  }

  function tick() {
    updateClock();
    if (card.audio && !card.audio.paused) card.raf = requestAnimationFrame(tick);
  }

  function updateClock() {
    var a = card.audio;
    if (!a) return;
    var t = a.currentTime || 0;
    var head = $('#cd-head');
    if (head) head.style.left = pct(t).toFixed(3) + '%';
    var time = $('#cd-time');
    if (time) time.textContent = TL.formatClock(t) + ' / ' + TL.formatClock(totalDuration());
    var seekEl = $('#cd-seek');
    if (seekEl && document.activeElement !== seekEl) seekEl.value = t;
    highlightPlaying(TL.findTurnAt(card.map.spans, t));
  }

  function highlightPlaying(idx) {
    if (idx === card.playingIdx) return;
    var prev = document.querySelectorAll('#cd-tx .is-playing, #cd-area .is-playing');
    prev.forEach(function (x) { x.classList.remove('is-playing'); });
    card.playingIdx = idx;
    if (idx < 0) return;
    var el = document.getElementById('m-' + (idx + 1));
    var seg = document.querySelector('#cd-area i[data-i="' + idx + '"]');
    if (seg) seg.classList.add('is-playing');
    if (el) {
      el.classList.add('is-playing');
      if (card.follow && card.audio && !card.audio.paused) scrollIntoBody(el, false);
    }
  }

  function seek(sec, play, byUser) {
    var a = card.audio;
    if (!a) return;
    if (byUser) card.userMoved = true;
    a.currentTime = Math.max(0, sec);
    updateClock();
    if (play) { var p = a.play(); if (p && p.catch) p.catch(function () {}); }
  }

  /* ---------- события ---------- */

  function bind() {
    $('#cd-prev').addEventListener('click', function () { go(-1); });
    $('#cd-next').addEventListener('click', function () { go(1); });

    var page = document.querySelector('[data-page="dialog"]');
    // Любое действие пользователя в карточке: после этого автоподстройка не двигает запись сама.
    ['pointerdown', 'keydown', 'input'].forEach(function (type) {
      page.addEventListener(type, function () { card.userMoved = true; }, true);
    });
    page.addEventListener('click', function (e) {
      var t = e.target;
      var play = t.closest('[data-play]');
      if (play) { var s = card.map.spans[Number(play.dataset.play)]; if (s && card.audio) seek(s.start - 0.15, true); return; }

      var more = t.closest('[data-more]');
      if (more) {
        var textEl = more.previousElementSibling.querySelector('.cqa-msg-text');
        var open = textEl.classList.toggle('is-clamped');
        more.textContent = open ? 'Показать полностью' : 'Свернуть';
        return;
      }

      var copy = t.closest('[data-copy]');
      if (copy) {
        var url = location.origin + location.pathname + copy.getAttribute('href');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () { CQA.toast('Ссылка на реплику №' + copy.dataset.copy + ' скопирована'); }, function () {});
        }
        return; // переход по ссылке обработает маршрут
      }

      var evalBtn = t.closest('[data-evaluate]');
      if (evalBtn) { evaluateNow(evalBtn); return; }

      var appealBtn = t.closest('[data-appeal]');
      if (appealBtn) { openAppealModal(appealBtn.dataset.appeal); return; }

      var rangeBtn = t.closest('[data-range]');
      if (rangeBtn) { var rg = rangeBtn.dataset.range.split('-'); jumpToRange(Number(rg[0]), Number(rg[1])); return; }

      var tagBtn = t.closest('[data-crit-key]');
      if (tagBtn) { openCriterion(tagBtn.dataset.critKey); return; }

      var jumpBtn = t.closest('[data-jump-n]');
      if (jumpBtn) { jumpTo(Number(jumpBtn.dataset.jumpN), { flash: true }); return; }

      if (t.id === 'cd-play' || t.closest('#cd-play')) {
        if (!card.audio) return;
        if (card.audio.paused) { var p = card.audio.play(); if (p && p.catch) p.catch(function () {}); } else card.audio.pause();
        return;
      }

      var seg = t.closest('#cd-area i[data-i]');
      if (seg) { var sp = card.map.spans[Number(seg.dataset.i)]; if (sp) { seek(sp.start, true); jumpTo(Number(seg.dataset.i) + 1, { flash: true, play: false }); } return; }

      var area = t.closest('#cd-area');
      if (area && card.audio) {
        var rect = area.getBoundingClientRect();
        seek((e.clientX - rect.left) / rect.width * totalDuration(), false);
      }
    });

    page.addEventListener('input', function (e) {
      if (e.target.id === 'cd-seek' && card.audio) { card.audio.currentTime = Number(e.target.value); updateClock(); }
    });
    page.addEventListener('change', function (e) {
      if (e.target.id === 'cd-speed' && card.audio) card.audio.playbackRate = Number(e.target.value) || 1;
      if (e.target.id === 'cd-follow') card.follow = e.target.checked;
    });

    // Клавиатура: ← → — соседний диалог, пробел — пауза/воспроизведение.
    document.addEventListener('keydown', function (e) {
      if (!page.classList.contains('is-active')) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|SELECT|TEXTAREA/.test(tag) || document.querySelector('.cqa-modal.is-open')) return;
      if (e.key === 'ArrowLeft') { go(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { go(1); e.preventDefault(); }
      // Пробел на кнопке, ссылке, строке критерия (summary) и т. п. работает как обычно — плеер его не перехватывает.
      else if (e.key === ' ' && card.audio && !(document.activeElement && document.activeElement.closest &&
        document.activeElement.closest('button, a, summary, [role="button"], [tabindex]:not([tabindex="-1"]):not(.cqa-seek), [contenteditable="true"]'))) {
        e.preventDefault();
        if (card.audio.paused) { var p = card.audio.play(); if (p && p.catch) p.catch(function () {}); } else card.audio.pause();
      }
    });
  }

  bind();
})();
