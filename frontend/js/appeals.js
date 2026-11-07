/* CQA — страница «Апелляции» (шаг 7).
   Адрес: #appeals или #appeals/<id>. Аналитик видит апелляции только для чтения,
   проверяющий выносит решение: «Оставить» или «Изменить» (с причиной), итог пересчитывается. */
(function () {
  'use strict';

  var CQA = window.CQA;
  var $ = CQA.$;
  var $$ = CQA.$$;
  var esc = CQA.esc;
  var ROLE_NAMES = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
  var REASONS = [
    'ИИ неверно прочитал диалог',
    'Критерий применён неверно',
    'Оценка ИИ верна, доказательство в реплике',
  ];

  var state = { tab: 'open', items: [], counts: { open: 0, decided: 0, all: 0 }, selected: null, detail: null, token: 0, active: false };

  function icon(id, cls) { return '<svg class="i ' + (cls || 'i-sm') + '"><use href="#' + id + '"/></svg>'; }
  function F(x) { return CQA.scoring.formatPoints(x); }
  function when(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); }
  function critLabel(a) { return a.criterion_snapshot ? a.criterion_snapshot.name : a.criterion_key; }
  function critLike(a, checklist) {
    var c = checklist && checklist.criteria.filter(function (x) { return x.key === a.criterion_key; })[0];
    return c || { key: a.criterion_key, name: a.criterion_snapshot.name, type: a.criterion_snapshot.type, scale: a.criterion_snapshot.scale || [], na_allowed: a.criterion_snapshot.na_allowed, weight: a.criterion_snapshot.weight };
  }
  function critNo(a, checklist) {
    var i = checklist ? checklist.criteria.findIndex(function (x) { return x.key === a.criterion_key; }) : -1;
    return i >= 0 ? (i < 9 ? '0' : '') + (i + 1) + ' ' : '';
  }
  function dialogId(a) { return a.dialog ? a.dialog.conversation_id : String(a.dialog_key).split(':').pop(); }
  function dialogHref(a, n) { return '#dialog/' + encodeURIComponent(a.dialog_key) + (n ? '/m-' + n : ''); }
  function channelWord(a) { return a.dialog && a.dialog.channel === 'voice call' ? 'Звонок' : 'Чат'; }

  function statusChip(a) {
    if (a.status === 'open') return '<span class="cqa-chip cqa-chip-amber">Ждёт решения</span>';
    if (a.status === 'changed') return '<span class="cqa-chip cqa-chip-forest">Изменено</span>';
    if (a.status === 'kept') return '<span class="cqa-chip cqa-chip-slate">Оставлено</span>';
    return '<span class="cqa-chip">Закрыта</span>';
  }

  /* ---------- маршрут ---------- */

  document.addEventListener('cqa:route', function (e) {
    var d = e.detail;
    state.active = d.page === 'appeals';
    if (!state.active) return;
    state.selected = d.parts[1] || null;
    state.fromRoute = Boolean(state.selected);
    load();
  });
  document.addEventListener('cqa:role', function () { if (state.active) renderDetail(); });
  document.addEventListener('cqa:appeals-changed', function () { if (state.active) load(); });

  document.addEventListener('click', function (e) {
    if (!state.active) return;
    var tab = e.target.closest('[data-ap-tab]');
    if (tab) {
      // выбор вкладки сбрасывает выбранную апелляцию, иначе вкладка «перепрыгнет» на «Все»
      state.tab = tab.dataset.apTab;
      state.selected = null;
      state.fromRoute = false;
      if (location.hash !== '#appeals') history.replaceState(null, '', '#appeals');
      load();
      return;
    }
    var sw = e.target.closest('[data-ap-switch]');
    if (sw) { CQA.setRole('reviewer'); return; }
    var chip = e.target.closest('[data-ap-reason]');
    if (chip) {
      var ta = $('#ap-reason');
      if (ta) { ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + chip.dataset.apReason + '. '; ta.focus(); }
    }
  });

  /* ---------- загрузка ---------- */

  function load() {
    var token = ++state.token;
    CQA.api.get('/api/appeals?status=' + state.tab).then(function (res) {
      if (token !== state.token) return;
      state.items = res.items || [];
      state.counts = res.counts || state.counts;
      // открыли ссылкой на апелляцию (или её только что решили), а во вкладке её нет — переключаемся на «Все»
      if (state.selected && !state.items.some(function (a) { return a.id === state.selected; })) {
        if (state.fromRoute && state.tab !== 'all') { state.tab = 'all'; load(); return; }
        state.selected = null;
      }
      if (!state.selected && state.items.length && window.matchMedia('(min-width: 1025px)').matches) state.selected = state.items[0].id;
      renderTabs();
      renderList();
      loadDetail();
    }).catch(function (err) {
      $('#ap-list').innerHTML = '<div class="cqa-panel"><div class="cqa-panel-body"><p class="cqa-field-err">Не удалось загрузить апелляции: ' + esc(err.message) + '</p></div></div>';
    });
  }

  function loadDetail() {
    var box = $('#ap-detail');
    if (!state.selected) { state.detail = null; renderDetail(); return; }
    var id = state.selected;
    var token = state.token;
    box.innerHTML = '<div class="cqa-panel-body"><p class="cqa-muted">Загружаю апелляцию…</p></div>';
    CQA.api.get('/api/appeals/' + encodeURIComponent(id)).then(function (res) {
      if (token !== state.token || id !== state.selected) return;
      state.detail = res;
      renderDetail();
      // на узком экране список и деталь идут друг под другом — показываем выбранную апелляцию
      if (state.fromRoute && window.matchMedia('(max-width: 1024px)').matches) box.scrollIntoView({ block: 'start' });
    }).catch(function (err) {
      if (token !== state.token) return;
      box.innerHTML = '<div class="cqa-panel-body"><p class="cqa-field-err">' + esc(err.message) + '</p></div>';
    });
  }

  /* ---------- список ---------- */

  function renderTabs() {
    $$('[data-ap-tab]').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.apTab === state.tab)); });
    ['open', 'decided', 'all'].forEach(function (k) { var el = $('[data-ap-count="' + k + '"]'); if (el) el.textContent = state.counts[k] || 0; });
  }

  function renderList() {
    var list = $('#ap-list');
    if (!state.items.length) {
      list.innerHTML = '<div class="cqa-panel"><div class="cqa-panel-body cqa-ap-empty">' + icon('i-scale', 'i') +
        '<p>' + (state.tab === 'open' ? 'Нет апелляций, которые ждут решения.' : 'Апелляций пока нет.') + '</p>' +
        '<p class="cqa-muted">Чтобы оспорить оценку: откройте диалог, раскройте критерий и нажмите «Оспорить» (роль «Аналитик»).</p></div></div>';
      return;
    }
    list.innerHTML = state.items.map(function (a) {
      var crit = critLabel(a);
      var line = a.status === 'changed' && a.decision
        ? 'Итог: ' + F(a.decision.total_before) + ' → ' + F(a.decision.total_after) + '. ' + a.decision.reason
        : a.status === 'kept' && a.decision ? 'Оставлено. ' + a.decision.reason
        : a.status === 'stale' ? (a.closed_reason || 'Закрыта без решения') : a.comment;
      var actor = a.status === 'open' ? 'Аналитик' : a.status === 'stale' ? 'Система' : 'Проверяющий';
      return '<a class="cqa-ap-item" href="#appeals/' + esc(a.id) + '"' + (a.id === state.selected ? ' aria-current="true"' : '') + '>' +
        '<span class="cqa-ap-item-top"><span class="cqa-ap-item-id">№' + a.no + ' · ' + esc(dialogId(a)) + '</span>' + statusChip(a) + '</span>' +
        '<span class="cqa-ap-item-crit">' + esc(crit) + '</span>' +
        '<span class="cqa-ap-item-text">' + esc(line) + '</span>' +
        '<span class="cqa-ap-item-foot"><span>' + actor + '</span><span>' + esc(when(a.status === 'open' ? a.created_at : (a.closed_at || a.created_at))) + '</span></span>' +
      '</a>';
    }).join('');
  }

  /* ---------- деталь ---------- */

  function fragmentHtml(a) {
    var f = a.fragment || { turns: [] };
    var r = a.original.checked_range;
    var html = f.turns.map(function (t) {
      var role = t.speaker;
      var cls = role === 'client' ? 'is-client' : role === 'operator' ? 'is-operator' : role === 'bot' ? 'is-context is-bot' : 'is-context is-system';
      var num = '<a class="cqa-msg-num" href="' + esc(dialogHref(a, t.n)) + '" title="Открыть реплику в диалоге">№' + t.n + '</a>';
      var msg;
      if (role === 'system') {
        msg = '<div class="cqa-msg ' + cls + (t.evidence ? ' is-evidence' : '') + '"><div class="cqa-msg-bubble">' + esc(t.timestamp) + ' — ' + esc(t.text) + ' ' + num + '</div></div>';
      } else {
        var meta = '<span class="cqa-msg-who">' + (ROLE_NAMES[role] || esc(role)) + '</span><span class="cqa-msg-ts">' + esc(t.timestamp) + '</span>' + num;
        msg = '<div class="cqa-msg ' + cls + (t.evidence ? ' is-evidence' : '') + '"><div class="cqa-msg-meta">' + meta + '</div><div class="cqa-msg-bubble">' + esc(t.text) + '</div></div>';
      }
      if (a.original.answer === 'no' && r && t.n === Math.min(r.to, f.to_turn)) {
        msg += '<div class="cqa-miss">' + icon('i-target', 'i') + '<div><strong>Здесь ожидалось действие — ИИ его не нашёл</strong><span class="cqa-muted"> (проверенный участок №' + r.from + '–№' + r.to + ')</span></div></div>';
      }
      return msg;
    }).join('');
    var range = f.turns.length ? 'реплики №' + f.from_turn + '–№' + f.to_turn : '';
    return '<div class="cqa-frag"><div class="cqa-frag-head"><b>Спорный фрагмент' + (range ? ', ' + range : '') + '</b>' +
      '<a class="cqa-btn-link" style="font-size:13.5px" href="' + esc(dialogHref(a, f.from_turn)) + '">Перейти в переписку</a></div>' +
      '<div class="cqa-frag-body">' + (html || '<p class="cqa-muted">Фрагмента нет.</p>') + '</div></div>';
  }

  function scoreWith(res, overrides) {
    if (!res.checklist || !res.evaluation) return null;
    var values = {};
    Object.keys(res.evaluation.answers).forEach(function (k) { values[k] = res.evaluation.answers[k].answer; });
    Object.keys(overrides || {}).forEach(function (k) { values[k] = overrides[k]; });
    return CQA.scoring.score(res.checklist, values);
  }

  function renderDetail() {
    var box = $('#ap-detail');
    var res = state.detail;
    if (!res) {
      box.innerHTML = state.items.length ? '<div class="cqa-panel-body"><p class="cqa-muted">Выберите апелляцию в списке.</p></div>' : '';
      box.hidden = !state.items.length;
      return;
    }
    box.hidden = false;
    var a = res.appeal;
    var c = critLike(a, res.checklist);
    // баллы ответа ИИ с учётом других решённых апелляций этой оценки
    var others = Object.assign({}, res.overrides || {});
    delete others[a.criterion_key];
    var base = scoreWith(res, others);
    var row = base && base.criteria.filter(function (r) { return r.key === a.criterion_key; })[0];
    var pts = c.type === 'flag' ? 'флаг, в баллы не входит' : row && row.applicable ? F(row.points) + ' из ' + F(row.max_points) + ' баллов' : 'не учитывается';
    var quotes = (a.original.evidence || []).map(function (e) {
      return '<a class="cqa-quote cqa-quote-btn" href="' + esc(dialogHref(a, e.turn)) + '"><span class="cqa-quote-meta">№' + e.turn + '</span><span class="cqa-quote-text">«' + esc(e.quote) + '»</span></a>';
    }).join('');

    var html = '<div class="cqa-panel-body cqa-ap-panel">' +
      '<div class="cqa-ap-title"><div><h2>' + channelWord(a) + ' ' + esc(dialogId(a)) + ', критерий ' + esc(critNo(a, res.checklist) + '«' + c.name + '»') + '</h2>' +
        '<p class="cqa-muted" style="margin-top:4px">Апелляция №' + a.no + ' · подал аналитик ' + esc(when(a.created_at)) + ' · ' + statusChip(a) + '</p></div>' +
        '<a class="cqa-btn cqa-btn-ghost cqa-btn-sm" href="' + esc(dialogHref(a)) + '">' + icon('i-chat') + 'Открыть весь диалог</a></div>' +
      '<div class="cqa-ap-cols">' +
        '<div class="cqa-box"><span class="cqa-box-label">Оценка ' + (a.evaluation_source === 'mock' ? '(подставная)' : 'ИИ') + '</span>' +
          '<span class="cqa-box-big">' + esc(CQA.answerText(c, a.original.answer)) + '<span style="font-size:14px;font-weight:600;color:var(--muted)">' + esc(pts) + '</span></span>' +
          '<p style="font-size:14px;color:var(--ink-2)">' + esc(a.original.explanation) + '</p>' + quotes +
          (a.original.na_reason ? '<p class="cqa-muted" style="font-size:13px">N/A: ' + esc(a.original.na_reason) + '</p>' : '') +
        '</div>' +
        '<div class="cqa-box is-comment"><span class="cqa-box-label">Комментарий аналитика</span>' +
          '<p style="font-size:14.5px">' + esc(a.comment) + '</p>' +
          (a.requested_value !== null && a.requested_value !== undefined ? '<p style="font-size:14px"><b>Предлагает:</b> ' + esc(CQA.answerText(c, a.requested_value)) + '</p>' : '') +
        '</div>' +
      '</div>' +
      fragmentHtml(a);

    if (a.status === 'open') html += res.is_current ? decisionFormHtml(a, c, res) : '<div class="cqa-preview">' + icon('i-alert', 'i') + '<p>Оценка диалога обновилась — эта апелляция больше не актуальна.</p></div>';
    else html += decisionRecordHtml(a, c);

    html += '</div>';
    box.innerHTML = html;
    if (a.status === 'open' && res.is_current && CQA.role === 'reviewer') wireForm(a, c, res);
  }

  function decisionRecordHtml(a, c) {
    if (a.status === 'stale') {
      return '<div class="cqa-preview" style="background:var(--slate-soft);color:var(--slate)">' + icon('i-clock', 'i') +
        '<p><b>Закрыта без решения.</b> ' + esc(a.closed_reason || '') + ' (' + esc(when(a.closed_at)) + ').</p></div>';
    }
    var d = a.decision;
    var changed = a.status === 'changed';
    return '<div class="cqa-ap-decision ' + (changed ? 'is-changed' : 'is-kept') + '">' +
      '<span class="cqa-box-label">Решение проверяющего · ' + esc(when(d.decided_at)) + '</span>' +
      '<b class="cqa-ap-decision-head">' + (changed
        ? 'Изменено: ' + esc(CQA.answerText(c, a.original.answer)) + ' → ' + esc(CQA.answerText(c, d.new_value))
        : 'Оставлено: ' + esc(CQA.answerText(c, a.original.answer))) + '</b>' +
      '<p>Причина: ' + esc(d.reason) + '</p>' +
      (c.type === 'flag'
        ? '<p class="cqa-muted">Итог не меняется · Грубая ошибка: ' + (d.gross_before ? 'Да' : 'Нет') + ' → ' + (d.gross_after ? 'Да' : 'Нет') + '</p>'
        : '<p class="cqa-ap-decision-total">Итог диалога: ' + (d.total_before === null ? '—' : F(d.total_before)) + (changed ? ' → <b>' + (d.total_after === null ? '—' : F(d.total_after)) + '</b>' : ' (без изменений)') + '</p>') +
      '<a class="cqa-btn-link" href="' + esc(dialogHref(a)) + '">Открыть карточку с историей</a></div>';
  }

  function decisionFormHtml(a, c, res) {
    if (CQA.role !== 'reviewer') {
      return '<div class="cqa-preview">' + icon('i-scale', 'i') + '<p>Решение по апелляции принимает проверяющий.</p>' +
        '<button class="cqa-btn cqa-btn-primary cqa-btn-sm" type="button" data-ap-switch>Переключиться на проверяющего</button></div>';
    }
    var opts = CQA.answerOptions(c).filter(function (v) { return !CQA.sameAnswer(v, a.original.answer); });
    var pre = a.requested_value !== null && a.requested_value !== undefined ? a.requested_value : null;
    return '<form class="cqa-ap-form" id="ap-form" novalidate>' +
      '<h3 style="margin-bottom:10px">Решение проверяющего</h3>' +
      '<div class="cqa-decide">' +
        '<div class="cqa-choice"><input type="radio" name="ap-outcome" id="ap-keep" value="kept">' +
          '<label for="ap-keep"><span class="cqa-choice-radio"></span><span><b>Оставить оценку</b><small>ИИ оценил верно, итог не изменится</small></span></label></div>' +
        '<div class="cqa-choice"><input type="radio" name="ap-outcome" id="ap-change" value="changed"' + (pre !== null ? ' checked' : '') + '>' +
          '<label for="ap-change"><span class="cqa-choice-radio"></span><span><b>Изменить оценку</b><small>Выберите новый ответ, итог пересчитается</small></span></label></div>' +
      '</div>' +
      '<div class="cqa-newscore">' +
        '<label class="cqa-field" id="ap-new-wrap"><span class="cqa-label">Новый ответ</span><select class="cqa-select" id="ap-new">' +
          opts.map(function (v) { return '<option value="' + esc(String(v)) + '"' + (pre !== null && CQA.sameAnswer(v, pre) ? ' selected' : '') + '>' + esc(CQA.answerText(c, v)) + '</option>'; }).join('') +
        '</select></label>' +
        '<label class="cqa-field"><span class="cqa-label">Причина решения (обязательно)</span>' +
          '<textarea class="cqa-textarea" id="ap-reason" maxlength="2000" placeholder="Например: в реплике №12 оператор попрощался — «Хорошего вечера!»"></textarea>' +
          '<span class="cqa-ap-reasons">' + REASONS.map(function (r) { return '<button type="button" class="cqa-chip cqa-chip-outline" data-ap-reason="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + '</span>' +
        '</label>' +
      '</div>' +
      '<p class="cqa-field-err" id="ap-err" hidden></p>' +
      '<div class="cqa-recalc"><div><div style="font-size:13.5px" id="ap-recalc-label">Итог диалога после решения</div>' +
        '<div class="cqa-recalc-nums" id="ap-recalc"></div></div>' +
        '<button class="cqa-btn cqa-btn-primary cqa-btn-lg" type="submit" id="ap-save">' + icon('i-check', 'i') + 'Сохранить решение</button></div>' +
    '</form>';
  }

  function wireForm(a, c, res) {
    var form = $('#ap-form');
    if (!form) return;
    var parseVal = function (s) { return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s; };
    var outcome = function () { var r = form.querySelector('input[name="ap-outcome"]:checked'); return r ? r.value : null; };
    function recalc() {
      var o = outcome();
      $('#ap-new-wrap').hidden = o !== 'changed';
      var others = Object.assign({}, res.overrides || {});
      delete others[a.criterion_key];
      var before = scoreWith(res, others);
      var after = before;
      if (o === 'changed') { var ov = Object.assign({}, others); ov[a.criterion_key] = parseVal($('#ap-new').value); after = scoreWith(res, ov); }
      var nums = $('#ap-recalc');
      if (!before) { nums.innerHTML = ''; return; }
      if (c.type === 'flag') {
        $('#ap-recalc-label').textContent = 'Итог не меняется. Грубая ошибка после решения';
        nums.innerHTML = '<span class="cqa-recalc-old">' + (before.gross.flagged ? 'Да' : 'Нет') + '</span>' +
          '<span class="cqa-recalc-arrow" aria-hidden="true">' + icon('i-chev', 'i') + '</span><span class="cqa-recalc-new">' + (after.gross.flagged ? 'Да' : 'Нет') + '</span>';
        return;
      }
      var fmt = function (r) { return r.computable ? F(r.total) : '—'; };
      nums.innerHTML = o === 'changed'
        ? '<span class="cqa-recalc-old">' + fmt(before) + '</span><span class="cqa-recalc-arrow" aria-hidden="true">' + icon('i-chev', 'i') + '</span><span class="cqa-recalc-new">' + fmt(after) + '</span>'
        : '<span class="cqa-recalc-new">' + fmt(before) + '</span>' + (o === 'kept' ? '<span class="cqa-muted" style="font-size:14px">без изменений</span>' : '');
    }
    form.addEventListener('change', recalc);
    recalc();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('#ap-err');
      var o = outcome();
      var reason = $('#ap-reason').value.trim();
      if (!o) { err.textContent = 'Выберите «Оставить» или «Изменить».'; err.hidden = false; return; }
      if (reason.length < 3) { err.textContent = 'Укажите причину решения.'; err.hidden = false; $('#ap-reason').focus(); return; }
      err.hidden = true;
      var btn = $('#ap-save');
      btn.disabled = true;
      CQA.api.post('/api/appeals/' + encodeURIComponent(a.id) + '/decision', {
        outcome: o, new_value: o === 'changed' ? parseVal($('#ap-new').value) : null, reason: reason, rev: a.rev, role: 'reviewer'
      }).then(function (out) {
        var d = out.appeal.decision;
        CQA.toast(o === 'changed'
          ? (c.type === 'flag' ? 'Решение сохранено. Грубая ошибка: ' + (d.gross_after ? 'Да' : 'Нет') : 'Решение сохранено. Итог ' + dialogId(a) + ' теперь ' + (d.total_after === null ? '—' : F(d.total_after)))
          : 'Решение сохранено: оценка оставлена', { label: 'Открыть карточку', run: function () { location.hash = dialogHref(a); } });
        document.dispatchEvent(new CustomEvent('cqa:appeals-changed'));
      }).catch(function (e2) {
        btn.disabled = false;
        err.textContent = e2.message; err.hidden = false;
        if (e2.status === 409) {
          // решение уже принял кто-то другой: сообщение — в уведомлении (панель сейчас перерисуется)
          CQA.toast(e2.message);
          document.dispatchEvent(new CustomEvent('cqa:appeals-changed'));
        }
      });
    });
  }
})();
