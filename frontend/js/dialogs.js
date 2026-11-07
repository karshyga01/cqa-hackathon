/* CQA — страница «Диалоги» и окно «Загрузить диалоги». Данные берутся с сервера. */
(function () {
  'use strict';

  var CQA = window.CQA;
  var $ = CQA.$;
  var esc = CQA.esc;

  var PAGE_SIZE = 20;
  var LANG_NAMES = { RU: 'Русский', KZ: 'Казахский', EN: 'Английский' };
  var LANG_NAMES_LOWER = { RU: 'русский', KZ: 'казахский', EN: 'английский' };
  var CHANNEL = {
    'agent chat': { label: 'Чат', icon: 'i-chat' },
    'voice call': { label: 'Звонок', icon: 'i-phone' }
  };

  var state = {
    loaded: false,
    error: null,
    items: [],
    datasets: [],
    filters: { q: '', set: '', lang: '', chan: '', status: '', gross: false },
    searchKeys: null,
    sort: { key: 'order', dir: 1 },
    page: 1,
    selected: {}
  };

  /* ---------- helpers ---------- */

  function plural(n, forms) {
    var n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return forms[1];
    return forms[2];
  }
  function nDialogs(n) { return n + ' ' + plural(n, ['диалог', 'диалога', 'диалогов']); }

  function formatClock(sec) {
    if (sec === null || sec === undefined) return '—';
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var pad = function (x) { return (x < 10 ? '0' : '') + x; };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  function icon(id, cls) { return '<svg class="i ' + (cls || 'i-sm') + '"><use href="#' + id + '"/></svg>'; }

  function dialogHref(key) { return '#dialog/' + encodeURIComponent(key); }

  // Статус по последней оценке. Подставная оценка (не ИИ) помечается отдельно.
  function statusOf(it) {
    var ev = it.evaluation;
    if (!ev) return { code: 'new', label: 'Не оценён', chip: '' };
    if (ev.appeals && ev.appeals.open) return { code: 'appeal', label: 'На апелляции', chip: 'cqa-chip-amber' };
    if (ev.appeals && ev.appeals.decided) return { code: 'reviewed', label: 'Пересмотрен', chip: 'cqa-chip-forest' };
    if (ev.needs_review) return { code: 'review', label: 'Нужна проверка', chip: 'cqa-chip-amber' };
    return { code: 'rated', label: 'Оценён', chip: 'cqa-chip-green' };
  }
  function hasGross(it) { return Boolean(it.evaluation && it.evaluation.gross_flagged); }
  function scoreClass(total) { return total >= 85 ? '' : total >= 70 ? ' is-mid' : ' is-low'; }
  function scoreCell(it) {
    var ev = it.evaluation;
    if (!ev) return '<span class="cqa-score is-none">Не оценён</span>';
    if (!ev.computable) return '<span class="cqa-score is-none" title="Все критерии с весом получили N/A">Не рассчитан</span>';
    var t = ev.total;
    return '<span class="cqa-score' + scoreClass(t) + '"><span class="cqa-score-bar"><i style="width:' + Math.max(0, Math.min(100, t)) + '%"></i></span>' +
      (CQA.scoring ? CQA.scoring.formatPoints(t) : String(t)) + '</span>' +
      (ev.appeals && ev.appeals.changed && ev.ai_total !== t ? '<span class="cqa-id-sub" title="Итог изменён решением по апелляции">ИИ: ' + (ev.ai_total === null ? '—' : CQA.scoring.formatPoints(ev.ai_total)) + '</span>' : '') +
      (ev.source === 'mock' ? '<span class="cqa-id-sub" title="Подставная оценка по правилам, не ИИ">подставная</span>' : '');
  }

  function channelSummary(byChannel) {
    var chats = byChannel['agent chat'] || 0, calls = byChannel['voice call'] || 0;
    var parts = [];
    if (chats) parts.push(chats + ' ' + plural(chats, ['чат', 'чата', 'чатов']));
    if (calls) parts.push(calls + ' ' + plural(calls, ['звонок', 'звонка', 'звонков']));
    return parts.join(' и ');
  }
  function languageSummary(byLang) {
    return ['RU', 'KZ', 'EN'].filter(function (l) { return byLang[l]; })
      .map(function (l) { return LANG_NAMES_LOWER[l] + ' ' + byLang[l]; })
      .concat(Object.keys(byLang).filter(function (l) { return !LANG_NAMES[l]; }).map(function (l) { return l + ' ' + byLang[l]; }))
      .join(', ');
  }
  function countBy(items, fn) {
    var out = {};
    items.forEach(function (it) { var k = fn(it); out[k] = (out[k] || 0) + 1; });
    return out;
  }

  /* ---------- загрузка ---------- */

  function load() {
    return Promise.all([CQA.api.get('/api/dialogs'), CQA.api.get('/api/datasets')]).then(function (res) {
      state.items = res[0].items || [];
      state.datasets = res[1].items || [];
      state.loaded = true;
      state.error = null;
      if (state.filters.set && !state.datasets.some(function (d) { return d.group_id === state.filters.set; })) state.filters.set = '';
      render();
    }).catch(function (err) {
      state.error = err.message;
      state.loaded = true;
      render();
    }).then(notifyLoaded);
  }

  var searchToken = 0;
  var searchTimer = null;
  function runSearch() {
    var q = state.filters.q.trim();
    var token = ++searchToken;
    if (!q) { state.searchKeys = null; state.page = 1; render(); return; }
    CQA.api.get('/api/dialogs?q=' + encodeURIComponent(q)).then(function (res) {
      if (token !== searchToken) return;
      var keys = {};
      (res.items || []).forEach(function (it) { keys[it.key] = true; });
      state.searchKeys = keys;
      state.page = 1;
      render();
    }).catch(function (err) {
      if (token !== searchToken) return;
      state.searchKeys = {}; // не показываем результаты прошлого запроса под новым
      state.page = 1;
      render();
      CQA.toast('Поиск не удался: ' + err.message);
    });
  }

  /* ---------- фильтры и сортировка ---------- */

  function inScope(it) { return !state.filters.set || it.group_id === state.filters.set; }

  function visibleItems() {
    var f = state.filters;
    var list = state.items.filter(function (it) {
      if (!inScope(it)) return false;
      if (state.searchKeys && !state.searchKeys[it.key]) return false;
      if (f.lang && it.language !== f.lang) return false;
      if (f.chan && it.channel !== f.chan) return false;
      if (f.status && statusOf(it).code !== f.status) return false;
      if (f.gross && !hasGross(it)) return false;
      return true;
    });
    var key = state.sort.key, dir = state.sort.dir;
    var byId = function (a, b) {
      return a.group_id.localeCompare(b.group_id, 'ru', { numeric: true }) ||
        a.conversation_id.localeCompare(b.conversation_id, 'ru', { numeric: true });
    };
    list.sort(function (a, b) {
      var r = 0;
      if (key === 'turns') r = a.turns - b.turns;
      else if (key === 'duration') r = (a.duration_sec || 0) - (b.duration_sec || 0);
      else if (key === 'channel') r = a.channel.localeCompare(b.channel);
      else if (key === 'language') r = a.language.localeCompare(b.language);
      else if (key === 'order') r = a.group_id.localeCompare(b.group_id, 'ru', { numeric: true }) || (a.order - b.order);
      return (r * dir) || (byId(a, b) * (key === 'id' ? dir : 1));
    });
    return list;
  }

  function filtersActive() {
    var f = state.filters;
    return Boolean(f.q || f.lang || f.chan || f.status || f.gross);
  }

  /* ---------- отрисовка ---------- */

  function render() {
    renderSummary();
    renderDatasetSelect();
    renderTable();
  }

  function renderSummary() {
    var scope = state.items.filter(inScope);
    var byChan = countBy(scope, function (it) { return it.channel; });
    $('#sum-total').textContent = scope.length;
    $('#sum-total-note').textContent = channelSummary(byChan);
    var rated = scope.filter(function (it) { return it.evaluation; });
    var computable = rated.filter(function (it) { return it.evaluation.computable; });
    var avg = computable.length ? computable.reduce(function (a, it) { return a + it.evaluation.total; }, 0) / computable.length : null;
    $('#sum-rated').textContent = rated.length;
    $('#sum-rated-note').textContent = 'из ' + scope.length;
    $('#sum-avg').textContent = avg === null ? '—' : CQA.scoring.formatPoints(avg);
    $('#sum-gross').textContent = scope.filter(hasGross).length;
    $('#sum-appeals').textContent = scope.reduce(function (n, it) { return n + ((it.evaluation && it.evaluation.appeals && it.evaluation.appeals.open) || 0); }, 0);

    var nav = $('#nav-dialogs-count');
    nav.textContent = state.items.length;
    nav.hidden = state.items.length === 0;
  }

  function renderDatasetSelect() {
    var sel = $('#dl-set');
    var html = '<option value="">Все наборы</option>' + state.datasets.map(function (d) {
      return '<option value="' + esc(d.group_id) + '">Набор ' + esc(d.group_id) + ' (' + d.total + ')</option>';
    }).join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
    sel.value = state.filters.set;
    sel.parentElement.hidden = state.datasets.length < 2;
  }

  function emptyRow(kind, title, text, actionHtml) {
    var ic = kind === 'error' ? 'i-alert' : kind === 'empty' ? 'i-upload' : 'i-search';
    return '<tr class="cqa-row-state"><td colspan="9"><div class="cqa-empty' + (kind === 'error' ? ' is-error' : '') + '">' +
      '<span class="cqa-empty-icon">' + icon(ic, '') + '</span>' +
      '<b>' + esc(title) + '</b><p>' + esc(text) + '</p>' + (actionHtml || '') + '</div></td></tr>';
  }

  function renderTable() {
    var body = $('#dl-body');
    var range = $('#dl-range');
    var pager = $('#dl-pager');
    $('#dl-reset').hidden = !filtersActive();

    document.querySelectorAll('.cqa-sort').forEach(function (b) {
      var th = b.closest('th');
      if (b.dataset.sort === state.sort.key) th.setAttribute('aria-sort', state.sort.dir > 0 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });

    if (!state.loaded) return;

    if (state.error) {
      body.innerHTML = emptyRow('error', 'Не удалось получить список', state.error,
        '<button class="cqa-btn cqa-btn-ghost" type="button" data-action="retry">' + icon('i-refresh') + 'Повторить</button>');
      range.textContent = ''; pager.innerHTML = '';
      renderBulk([]);
      return;
    }

    if (!state.items.length) {
      body.innerHTML = emptyRow('empty', 'Диалогов пока нет',
        'Загрузите набор DEV из API организаторов — это займёт несколько секунд.',
        '<button class="cqa-btn cqa-btn-primary" type="button" data-open="modal-upload">' + icon('i-upload') + 'Загрузить диалоги</button>');
      range.textContent = ''; pager.innerHTML = '';
      renderBulk([]);
      return;
    }

    var list = visibleItems();
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * PAGE_SIZE;
    var pageItems = list.slice(start, start + PAGE_SIZE);

    if (!list.length) {
      body.innerHTML = emptyRow('search', 'Ничего не найдено', 'Под выбранные условия не подходит ни один диалог.',
        '<button class="cqa-btn cqa-btn-ghost" type="button" data-action="reset">Сбросить фильтры</button>');
    } else {
      var showGroup = state.datasets.length > 1 && !state.filters.set;
      body.innerHTML = pageItems.map(function (it) { return rowHtml(it, showGroup); }).join('');
    }

    range.textContent = list.length
      ? 'Показаны ' + (start + 1) + '–' + (start + pageItems.length) + ' из ' + list.length
      : '';
    pager.innerHTML = pagerHtml(pages);
    renderBulk(pageItems);
  }

  function rowHtml(it, showGroup) {
    var ch = CHANNEL[it.channel] || { label: it.channel, icon: 'i-chat' };
    var st = statusOf(it);
    var checked = state.selected[it.key] ? ' checked' : '';
    var href = dialogHref(it.key);
    return '<tr data-key="' + esc(it.key) + '"' + (checked ? ' class="is-selected"' : '') + '>' +
      '<td class="col-check"><label class="cqa-check"><input type="checkbox" data-select="' + esc(it.key) + '"' + checked +
        ' aria-label="Выбрать ' + esc(it.conversation_id) + '"></label></td>' +
      '<td><a class="cqa-id" href="' + esc(href) + '">' + esc(it.conversation_id) + '</a>' +
        (showGroup ? '<span class="cqa-id-sub">набор ' + esc(it.group_id) + '</span>' : '') + '</td>' +
      '<td><span class="cqa-chan">' + icon(ch.icon) + esc(ch.label) + '</span></td>' +
      '<td>' + esc(LANG_NAMES[it.language] || it.language) + '</td>' +
      '<td class="col-num">' + it.turns + '</td>' +
      '<td class="col-num">' + formatClock(it.duration_sec) + '</td>' +
      '<td>' + scoreCell(it) + '</td>' +
      (it.evaluation
        ? (hasGross(it) ? '<td><span class="cqa-flag">' + icon('i-alert') + 'Грубая ошибка</span></td>' : '<td class="cqa-muted">Нет</td>')
        : '<td class="cqa-muted">—</td>') +
      '<td><span class="cqa-chip' + (st.chip ? ' ' + st.chip : '') + '"><span class="cqa-dot"></span>' + esc(st.label) + '</span></td>' +
      '</tr>';
  }

  function pagerHtml(pages) {
    if (pages <= 1) return '';
    var p = state.page;
    var nums = [];
    for (var i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - p) <= 1) nums.push(i);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    var html = '<button type="button" data-page-go="' + (p - 1) + '" aria-label="Предыдущая страница"' + (p === 1 ? ' disabled' : '') + '>' + icon('i-left') + '</button>';
    nums.forEach(function (n) {
      if (n === '…') html += '<button type="button" disabled>…</button>';
      else html += '<button type="button" data-page-go="' + n + '"' + (n === p ? ' aria-current="page"' : '') + '>' + n + '</button>';
    });
    html += '<button type="button" data-page-go="' + (p + 1) + '" aria-label="Следующая страница"' + (p === pages ? ' disabled' : '') +
      '><svg class="i i-sm" style="transform:rotate(180deg)"><use href="#i-left"/></svg></button>';
    return html;
  }

  function renderBulk(pageItems) {
    var keys = Object.keys(state.selected);
    var bulk = $('#dl-bulk');
    bulk.hidden = keys.length === 0;
    $('#dl-sel-count').textContent = nDialogs(keys.length);

    var all = $('#dl-sel-all');
    var onPage = pageItems.filter(function (it) { return state.selected[it.key]; }).length;
    all.checked = pageItems.length > 0 && onPage === pageItems.length;
    all.indeterminate = onPage > 0 && onPage < pageItems.length;
    all.disabled = pageItems.length === 0;
  }

  /* ---------- события страницы ---------- */

  function bindPage() {
    $('#dl-q').addEventListener('input', function (e) {
      state.filters.q = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 250);
    });
    [['#dl-set', 'set'], ['#dl-lang', 'lang'], ['#dl-chan', 'chan'], ['#dl-status', 'status']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function (e) {
        state.filters[pair[1]] = e.target.value;
        state.page = 1;
        render();
      });
    });
    $('#dl-gross').addEventListener('change', function (e) {
      state.filters.gross = e.target.checked;
      state.page = 1;
      render();
    });
    $('#dl-reset').addEventListener('click', resetFilters);

    document.querySelectorAll('.cqa-sort').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.dataset.sort;
        state.sort = { key: key, dir: state.sort.key === key ? -state.sort.dir : 1 };
        render();
      });
    });

    $('#dl-sel-all').addEventListener('change', function (e) {
      var list = visibleItems();
      var start = (state.page - 1) * PAGE_SIZE;
      list.slice(start, start + PAGE_SIZE).forEach(function (it) {
        if (e.target.checked) state.selected[it.key] = true; else delete state.selected[it.key];
      });
      renderTable();
    });
    $('#dl-sel-clear').addEventListener('click', function () { state.selected = {}; renderTable(); });
    $('#dl-evaluate').addEventListener('click', evaluateSelected);
    $('#dl-delete').addEventListener('click', deleteSelected);
    // Окно подтверждения общее (то же, что в чек-листах): наш обработчик срабатывает только для нашего вопроса.
    $('#mcf-ok').addEventListener('click', function () {
      var cb = deleteConfirmCb; deleteConfirmCb = null;
      if (cb) { CQA.closeModal('modal-confirm'); cb(); }
    });
    $('#modal-confirm').addEventListener('cqa:modal-close', function () { deleteConfirmCb = null; });
    CQA.aiReady.then(function (ai) {
      var help = $('#dl-eval-help');
      if (help && ai && ai.available) help.textContent = 'Оценка ИИ (' + CQA.shortModel(ai.model) + '). Повторно спрашиваются только изменившиеся критерии';
    });

    var body = $('#dl-body');
    body.addEventListener('change', function (e) {
      var key = e.target.getAttribute('data-select');
      if (!key) return;
      if (e.target.checked) state.selected[key] = true; else delete state.selected[key];
      e.target.closest('tr').classList.toggle('is-selected', e.target.checked);
      renderBulk(currentPageItems());
    });
    body.addEventListener('click', function (e) {
      var action = e.target.closest('[data-action]');
      if (action) {
        if (action.dataset.action === 'retry') { state.loaded = false; load(); }
        if (action.dataset.action === 'reset') resetFilters();
        return;
      }
      if (e.target.closest('input, label, a, button')) return;
      var tr = e.target.closest('tr[data-key]');
      if (tr) location.hash = dialogHref(tr.dataset.key);
    });

    $('#dl-pager').addEventListener('click', function (e) {
      var b = e.target.closest('[data-page-go]');
      if (!b || b.disabled) return;
      state.page = Number(b.dataset.pageGo);
      renderTable();
      $('#dl-body').closest('.cqa-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  /* Удалить выбранные: диалог, его оценки, апелляции и запись звонка — после подтверждения. */
  var deleteConfirmCb = null;
  function deleteSelected() {
    var keys = Object.keys(state.selected);
    if (!keys.length || evaluating) return;
    var names = keys.slice(0, 5).map(function (k) { return k.split(':').slice(1).join(':'); }).join(', ') + (keys.length > 5 ? ' и ещё ' + (keys.length - 5) : '');
    $('#mcf-title').textContent = 'Удалить ' + nDialogs(keys.length) + '?';
    $('#mcf-text').textContent = names + '. Вместе с ними удалятся их оценки, апелляции и записи звонков. Вернуть будет нельзя — только загрузить заново.';
    var ok = $('#mcf-ok');
    ok.textContent = 'Удалить';
    ok.className = 'cqa-btn cqa-btn-danger';
    deleteConfirmCb = function () {
      var btn = $('#dl-delete');
      btn.disabled = true;
      CQA.api.post('/api/dialogs/delete', { keys: keys }).then(function (res) {
        state.selected = {};
        CQA.toast('Удалено: ' + nDialogs(res.deleted) +
          (res.evaluations ? ', оценок ' + res.evaluations : '') + (res.appeals ? ', апелляций ' + res.appeals : '') + (res.audio_files ? ', записей ' + res.audio_files : ''));
        document.dispatchEvent(new CustomEvent('cqa:appeals-changed'));
        document.dispatchEvent(new CustomEvent('cqa:evaluations-changed', { detail: { fromList: true } }));
        return load();
      }).catch(function (err) { CQA.toast(err.message); }).then(function () { btn.disabled = false; });
    };
    CQA.openModal('modal-confirm');
  }

  /* Оценить выбранные: ИИ, если он подключён, иначе подставная оценка по правилам.
     Повторная оценка ИИ спрашивает только изменившиеся критерии (например, после замены критерия). */
  var evaluating = false;
  function evaluateSelected() {
    var keys = Object.keys(state.selected);
    if (!keys.length || evaluating) return;
    evaluating = true;
    var btn = $('#dl-evaluate');
    btn.classList.add('is-busy');
    var mode = CQA.ai.available ? 'ai' : 'mock';
    btn.querySelector('span').textContent = (mode === 'ai' ? 'ИИ оценивает ' : 'Оцениваю ') + nDialogs(keys.length) + '…';
    CQA.api.post('/api/evaluate', { keys: keys, mode: mode, use_appeals: mode === 'ai' && CQA.useAppeals }).then(function (res) {
      state.selected = {};
      var msg = 'Оценено: ' + nDialogs(res.done) + (mode === 'ai' ? ' (ИИ)' : ' (подставная оценка, не ИИ)');
      if (mode === 'ai' && res.cost_usd > 0) msg += ' · ' + CQA.money(res.cost_usd);
      if (res.failed && res.failed.length) msg += '. Не получилось: ' + res.failed.length + ' (' + res.failed[0].error + ')';
      if (res.stopped) msg += '. Остановлено: ' + res.stopped + (res.not_started ? ' Не начаты: ' + res.not_started + '.' : '');
      CQA.toast(msg);
      document.dispatchEvent(new CustomEvent('cqa:evaluations-changed', { detail: { fromList: true } }));
      return load();
    }).catch(function (err) { CQA.toast(err.message); }).then(function () {
      evaluating = false;
      btn.classList.remove('is-busy');
      btn.querySelector('span').textContent = 'Оценить выбранные';
      renderTable();
    });
  }
  document.addEventListener('cqa:evaluations-changed', function (e) { if (!e.detail || !e.detail.fromList) load(); });
  document.addEventListener('cqa:appeals-changed', function () { load(); });

  function currentPageItems() {
    var start = (state.page - 1) * PAGE_SIZE;
    return visibleItems().slice(start, start + PAGE_SIZE);
  }

  function resetFilters() {
    state.filters.q = ''; state.filters.lang = ''; state.filters.chan = ''; state.filters.status = ''; state.filters.gross = false;
    state.searchKeys = null;
    searchToken++;
    $('#dl-q').value = ''; $('#dl-lang').value = ''; $('#dl-chan').value = ''; $('#dl-status').value = ''; $('#dl-gross').checked = false;
    state.page = 1;
    render();
  }

  /* ---------- для карточки: порядок диалогов для кнопок «предыдущий / следующий» ---------- */

  CQA.dialogs = {
    /** Ключи в том порядке, в каком они видны в таблице (с учётом фильтров и сортировки). */
    orderedKeys: function () {
      var visible = visibleItems().map(function (it) { return it.key; });
      return visible.length ? visible : state.items.map(function (it) { return it.key; });
    }
  };
  function notifyLoaded() { document.dispatchEvent(new CustomEvent('cqa:dialogs-loaded')); }

  /* ==========================================================================
     Окно «Загрузить диалоги»
     ========================================================================== */

  var up = {
    source: 'api',
    preview: null,      // результат «Проверить» для текущего кода набора
    file: null,         // { name, payload, count, groupId }
    busy: false
  };

  function upStatus(kind, html) {
    var el = $('#up-status');
    if (!kind) { el.hidden = true; el.innerHTML = ''; el.className = 'cqa-up-status'; return; }
    var ic = kind === 'ok' ? icon('i-check', '') : kind === 'loading' ? '<span class="cqa-spin" aria-hidden="true"></span>' : icon('i-alert', '');
    el.className = 'cqa-up-status' + (kind === 'loading' ? '' : ' is-' + kind);
    el.innerHTML = ic + '<div>' + html + '</div>';
    el.hidden = false;
  }

  function upSubmitLabel() {
    var text;
    if (up.source === 'api') {
      var g = $('#up-group').value.trim() || '…';
      text = up.preview ? 'Загрузить ' + nDialogs(up.preview.total) : 'Загрузить набор ' + g;
    } else if (up.source === 'file') {
      text = up.file ? (up.file.audio ? 'Распознать запись' : 'Загрузить ' + nDialogs(up.file.count)) : 'Загрузить из файла';
    } else {
      text = CQA.ai.available ? 'Разобрать с ИИ и добавить' : 'Добавить диалог';
    }
    $('#up-submit-text').textContent = text;
    $('#up-submit').disabled = up.busy || (up.source === 'file' && !up.file);
  }

  function setBusy(on, btn) {
    up.busy = on;
    var targets = [$('#up-submit'), $('#up-check')];
    targets.forEach(function (b) { b.classList.toggle('is-busy', on && b === btn); });
    $('#up-check').disabled = on;
    upSubmitLabel();
  }

  function skippedHtml(skipped, warnings) {
    var html = '';
    if (skipped && skipped.length) {
      html += '<ul>' + skipped.slice(0, 5).map(function (s) { return '<li>' + esc(s.id) + ': ' + esc(s.reason) + '</li>'; }).join('') +
        (skipped.length > 5 ? '<li>и ещё ' + (skipped.length - 5) + '</li>' : '') + '</ul>';
    }
    if (warnings && warnings.length) {
      html += '<ul>' + warnings.slice(0, 5).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') +
        (warnings.length > 5 ? '<li>и ещё ' + (warnings.length - 5) + ' предупреждений</li>' : '') + '</ul>';
    }
    return html;
  }

  function previewText(p) {
    var html = '<p><b>Найдено ' + nDialogs(p.total) + ':</b> ' + esc(channelSummary(p.by_channel)) +
      '. ' + esc(capitalize(languageSummary(p.by_language))) + '.</p>';
    if (p.already_loaded) html += '<p>Уже загружено: ' + p.already_loaded + '. Они обновятся, дубликатов не будет.</p>';
    if (p.skipped && p.skipped.length) html += '<p>Будут пропущены ' + p.skipped.length + ':</p>' + skippedHtml(p.skipped);
    return html;
  }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function previewKind(p) { return p.skipped && p.skipped.length ? 'warn' : 'ok'; }
  function currentGroup() { return $('#up-group').value.trim().toUpperCase(); }

  function checkApi() {
    var g = currentGroup();
    if (!g) { upStatus('error', '<p>Укажите код набора, например DEV.</p>'); $('#up-group').focus(); return; }
    setBusy(true, $('#up-check'));
    upStatus('loading', '<p>Скачиваю набор «' + esc(g) + '» у организаторов…</p>');
    CQA.api.post('/api/import/preview', { group_id: g }).then(function (p) {
      if (currentGroup() !== g) return; // пока ждали ответ, код набора поменяли — результат уже не про него
      up.preview = p;
      if (up.source === 'api') upStatus(previewKind(p), previewText(p));
    }).catch(function (err) {
      if (currentGroup() !== g) return;
      up.preview = null;
      if (up.source === 'api') upStatus('error', '<p>' + esc(err.message) + '</p>');
    }).then(function () { setBusy(false); });
  }

  function afterImport(res, label, exactMsg) {
    var msg = exactMsg || (label + ': ' + nDialogs(res.added + res.updated) +
      (res.updated ? ' (новых ' + res.added + ', обновлено ' + res.updated + ')' : ''));
    // Показываем только что загруженный набор целиком: старые фильтры сбрасываем.
    resetFilters();
    state.filters.set = res.group_id;
    state.page = 1;
    return load().then(function () {
      var issues = (res.skipped ? res.skipped.length : 0) + (res.warnings ? res.warnings.length : 0);
      var issuesHtml = '<p><b>' + esc(msg) + '.</b> Есть замечания:</p>' + skippedHtml(res.skipped, res.warnings);
      var modalOpen = $('#modal-upload').classList.contains('is-open');
      if (issues && modalOpen) {
        upStatus('warn', issuesHtml);
      } else {
        // Окно могли закрыть, пока шла загрузка, — тогда итог показываем уведомлением.
        CQA.closeModal('modal-upload');
        CQA.toast(issues ? msg + '. Замечаний: ' + issues + ' — откройте окно загрузки, чтобы их увидеть.' : msg);
        if (issues) up.pendingStatus = { kind: 'warn', html: issuesHtml };
      }
      if (location.hash && location.hash !== '#dialogs') location.hash = '#dialogs';
      highlightRows(res.keys || []);
    });
  }

  function submitUpload() {
    if (up.busy) return;
    var btn = $('#up-submit');

    if (up.source === 'api') {
      var g = currentGroup();
      if (!g) { upStatus('error', '<p>Укажите код набора, например DEV.</p>'); $('#up-group').focus(); return; }
      setBusy(true, btn);
      upStatus('loading', '<p>Загружаю набор «' + esc(g) + '»…</p>');
      CQA.api.post('/api/import/api', { group_id: g }).then(function (res) {
        up.preview = null;
        return afterImport(res, 'Набор ' + res.group_id + ' загружен');
      }).catch(function (err) {
        upStatus('error', '<p>' + esc(err.message) + '</p>');
      }).then(function () { setBusy(false); });
      return;
    }

    if (up.source === 'file') {
      if (!up.file) { upStatus('error', '<p>Сначала выберите файл.</p>'); return; }
      if (up.file.audio) {
        var af = up.file;
        setBusy(true, btn);
        upStatus('loading', '<p>Распознаю запись «' + esc(af.name) + '» на этом компьютере… Обычно в 5–6 раз быстрее длины записи (5 минут разговора — около минуты).</p>');
        var rd = new FileReader();
        rd.onload = function () {
          CQA.api.post('/api/import/audio', { name: af.name, data: String(rd.result), group_id: $('#up-file-group').value.trim() || undefined }).then(function (res) {
            resetFileUi();
            var R = { client: 'клиент', operator: 'оператор', bot: 'автоответчик' };
            var roles = Object.keys(res.roles || {}).map(function (r) { return (R[r] || r) + ' ' + res.roles[r]; }).join(', ');
            return afterImport(res, '', 'Запись распознана за ' + String(res.asr_seconds).replace('.', ',') + ' с: звонок ' + res.conversation_id + ' в наборе ' + res.group_id + ' — ' +
              res.turns + ' реплик (' + roles + ')' + (res.roles_by === 'rules' ? '; роли по простым правилам — ИИ не подключён' : ''));
          }).catch(function (err) {
            upStatus('error', '<p>' + esc(err.message) + '</p>');
          }).then(function () { setBusy(false); });
        };
        rd.onerror = function () { setBusy(false); upStatus('error', '<p>Не удалось прочитать файл.</p>'); };
        rd.readAsDataURL(af.file);
        return;
      }
      setBusy(true, btn);
      upStatus('loading', '<p>Загружаю «' + esc(up.file.name) + '»…</p>');
      CQA.api.post('/api/import/json', { payload: up.file.payload, group_id: $('#up-file-group').value.trim() || undefined }).then(function (res) {
        return afterImport(res, 'Файл загружен в набор ' + res.group_id);
      }).catch(function (err) {
        upStatus('error', '<p>' + esc(err.message) + '</p>');
      }).then(function () { setBusy(false); });
      return;
    }

    var text = $('#up-text').value;
    if (!text.trim()) { upStatus('error', '<p>Вставьте текст диалога или загрузите текстовый файл.</p>'); $('#up-text').focus(); return; }
    setBusy(true, btn);

    // С ИИ — любой формат: ИИ раскладывает на реплики, сервер проверяет дословность.
    if (CQA.ai.available) {
      upStatus('loading', '<p>ИИ раскладывает текст на диалоги и реплики…</p>');
      var lang = $('#up-text-lang').value;
      var chan = $('#up-text-chan').value;
      CQA.api.post('/api/import/ai', {
        text: text,
        conversation_id: $('#up-text-id').value.trim() || undefined,
        language: lang === 'auto' ? undefined : lang,
        channel: chan === 'call' ? 'voice call' : chan === 'chat' ? 'agent chat' : undefined
      }).then(function (res) {
        $('#up-text').value = '';
        $('#up-text-id').value = '';
        var ROLE = { client: 'клиент', operator: 'оператор', bot: 'бот', system: 'система' };
        var list = (res.dialogs || []).map(function (d) {
          var roles = Object.keys(d.roles || {}).map(function (r) { return (ROLE[r] || r) + ' ' + d.roles[r]; }).join(', ');
          return d.conversation_id + ' (' + (d.channel === 'voice call' ? 'звонок' : 'чат') + ', ' + d.language + ', ' + d.turns + ' репл.: ' + roles + ')';
        });
        return afterImport(res, '', 'ИИ разобрал текст: ' + nDialogs(list.length) + ' в наборе ' + res.group_id + ' — ' + list.join('; ') + (res.cost_usd ? ' · ' + CQA.money(res.cost_usd) : ''));
      }).catch(function (err) {
        upStatus('error', '<p>' + esc(err.message) + '</p>');
      }).then(function () { setBusy(false); });
      return;
    }

    upStatus('loading', '<p>Добавляю диалог…</p>');
    CQA.api.post('/api/import/text', {
      text: text,
      conversation_id: $('#up-text-id').value.trim() || undefined,
      language: $('#up-text-lang').value,
      channel: $('#up-text-chan').value
    }).then(function (res) {
      $('#up-text').value = '';
      $('#up-text-id').value = '';
      var id = ((res.keys && res.keys[0]) || '').split(':').slice(1).join(':');
      return afterImport(res, '', 'Диалог ' + id + (res.updated ? ' обновлён' : ' добавлен') + ' в набор MANUAL');
    }).catch(function (err) {
      upStatus('error', '<p>' + esc(err.message) + '</p>');
    }).then(function () { setBusy(false); });
  }

  /* --- файл --- */

  function countRecords(payload) {
    if (!payload || typeof payload !== 'object') return { error: 'В файле не JSON-объект.' };
    if (payload.isSuccess === false) return { error: 'В файле ответ API с ошибкой: ' + (payload.error || 'без описания') };
    if (payload.data && Array.isArray(payload.data.records)) return { count: payload.data.records.length, groupId: payload.data.dataset_group_id };
    if (Array.isArray(payload.records)) return { count: payload.records.length, groupId: payload.dataset_group_id };
    if (Array.isArray(payload)) return { count: payload.length };
    if (payload.conversation_id !== undefined) return { count: 1 };
    return { error: 'Не нашёл диалоги. Нужен ответ API организаторов, массив диалогов или один диалог с conversation_id и transcript.' };
  }

  var readToken = 0;
  function resetFileUi() {
    up.file = null;
    $('#up-drop').classList.remove('has-file');
    $('#up-file-title').textContent = 'Перетащите файл сюда';
    $('#up-file-sub').innerHTML = 'или <span class="cqa-btn-link">выберите на компьютере</span>';
    $('#up-file-group').placeholder = 'Возьму из файла, иначе FILE';
  }

  function readFile(file) {
    var token = ++readToken;
    resetFileUi();
    if (!file) { upSubmitLabel(); return; }
    // Запись звонка: распознаётся на этом компьютере (whisper.cpp), звук никуда не уходит.
    if (/^audio\//.test(file.type) || /\.(mp3|wav|m4a|ogg|oga|opus|aac|flac|webm)$/i.test(file.name)) {
      if (file.size > 22 * 1024 * 1024) { upStatus('error', '<p>Запись больше 22 МБ.</p>'); upSubmitLabel(); return; }
      if (!CQA.ai.asr) {
        upStatus('error', '<p>Распознавание речи не настроено на этом компьютере' + (CQA.ai.asr_problem ? ': ' + esc(CQA.ai.asr_problem) : '') + '</p>');
        upSubmitLabel();
        return;
      }
      up.file = { audio: true, name: file.name, file: file, count: 1 };
      $('#up-drop').classList.add('has-file');
      $('#up-file-title').textContent = file.name;
      $('#up-file-sub').innerHTML = 'запись звонка, ' + (file.size / 1048576).toFixed(1).replace('.', ',') + ' МБ. <span class="cqa-btn-link">Выбрать другой</span>';
      $('#up-file-group').placeholder = 'AUDIO';
      upStatus('ok', '<p>Запись звонка. Нажмите «Распознать запись»: речь распознаётся на этом компьютере (звук никуда не уходит), роли оператор / клиент расставит ИИ по тексту.</p>');
      upSubmitLabel();
      return;
    }
    if (file.size > 25 * 1024 * 1024) { upStatus('error', '<p>Файл больше 25 МБ.</p>'); upSubmitLabel(); return; }
    upStatus('loading', '<p>Читаю «' + esc(file.name) + '»…</p>');
    var reader = new FileReader();
    reader.onload = function () {
      if (token !== readToken) return; // уже выбрали другой файл
      var payload;
      var raw = String(reader.result).replace(/^﻿/, '');
      try { payload = JSON.parse(raw); } catch (_) {
        // Не JSON — это просто текст: отдаём его во «Вставить что угодно», ИИ разложит сам.
        moveToPaste(raw, file.name);
        return;
      }
      var c = countRecords(payload);
      if (c.error && CQA.ai.available) { moveToPaste(raw, file.name); return; }
      if (c.error) { upStatus('error', '<p>' + esc(c.error) + '</p>'); upSubmitLabel(); return; }
      if (!c.count) { upStatus('error', '<p>В файле нет диалогов.</p>'); upSubmitLabel(); return; }
      up.file = { name: file.name, payload: payload, count: c.count, groupId: c.groupId };
      $('#up-drop').classList.add('has-file');
      $('#up-file-title').textContent = file.name;
      $('#up-file-sub').innerHTML = esc(nDialogs(c.count)) + '. <span class="cqa-btn-link">Выбрать другой</span>';
      $('#up-file-group').placeholder = c.groupId ? 'Из файла: ' + c.groupId : 'FILE';
      upStatus('ok', '<p>Файл прочитан: ' + esc(nDialogs(c.count)) + '.</p>');
      upSubmitLabel();
    };
    reader.onerror = function () { if (token === readToken) { upStatus('error', '<p>Не удалось прочитать файл.</p>'); upSubmitLabel(); } };
    reader.readAsText(file);
  }

  /** Текст файла → вкладка «Вставить что угодно» (без ИИ — только строгий формат «время роль: текст»). */
  function moveToPaste(text, name) {
    resetFileUi();
    $('#up-text').value = text;
    var tab = document.querySelector('[data-src="paste"]');
    if (tab) tab.click();
    upStatus(CQA.ai.available ? 'ok' : 'warn', CQA.ai.available
      ? '<p>«' + esc(name) + '» — не JSON, перенёс текст сюда. Нажмите «Разобрать с ИИ» — ИИ разложит его на диалоги.</p>'
      : '<p>«' + esc(name) + '» — не JSON, перенёс текст сюда. ИИ не подключён: текст должен быть в виде «время роль: текст».</p>');
  }

  /** Подсвечивает только что загруженные строки (если они на текущей странице). */
  function highlightRows(keys) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('#dl-body tr[data-key]'));
    var hits = rows.filter(function (tr) { return keys.indexOf(tr.dataset.key) !== -1; });
    hits.forEach(function (tr) { tr.classList.add('is-new'); });
    if (hits.length && keys.length <= 3) hits[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(function () { hits.forEach(function (tr) { tr.classList.remove('is-new'); }); }, 4000);
  }

  function bindUpload() {
    var modal = $('#modal-upload');
    modal.addEventListener('cqa:modal-open', function () {
      if (up.pendingStatus) { upStatus(up.pendingStatus.kind, up.pendingStatus.html); up.pendingStatus = null; }
      else if (!up.busy) upStatus(null);
      upSubmitLabel();
    });
    document.addEventListener('cqa:upload-source', function (e) {
      up.source = e.detail.source;
      if (!up.busy) upStatus(null);
      if (up.source === 'api' && up.preview) upStatus(previewKind(up.preview), previewText(up.preview));
      if (up.source === 'file' && up.file) upStatus('ok', '<p>Файл прочитан: ' + esc(nDialogs(up.file.count)) + '.</p>');
      upSubmitLabel();
    });
    $('#up-group').addEventListener('input', function () { up.preview = null; upStatus(null); upSubmitLabel(); });
    $('#up-check').addEventListener('click', checkApi);
    $('#up-form').addEventListener('submit', function (e) { e.preventDefault(); submitUpload(); });

    // «Вставить что угодно» → «загрузить текстовый файл»: читаем текст файла в поле
    var textFile = $('#up-text-file');
    $('#up-text-file-btn').addEventListener('click', function () { textFile.click(); });
    textFile.addEventListener('change', function () {
      var f = textFile.files && textFile.files[0];
      textFile.value = '';
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { upStatus('error', '<p>Файл больше 2 МБ — для текста диалога это слишком много.</p>'); return; }
      var rd = new FileReader();
      rd.onload = function () { $('#up-text').value = String(rd.result).replace(/^﻿/, ''); upStatus('ok', '<p>Текст из «' + esc(f.name) + '» вставлен. Нажмите «' + esc($('#up-submit-text').textContent) + '».</p>'); };
      rd.onerror = function () { upStatus('error', '<p>Не удалось прочитать файл.</p>'); };
      rd.readAsText(f);
    });
    CQA.aiReady.then(function (ai) {
      if (!(ai && ai.available)) $('#up-text-help').textContent = 'ИИ не подключён: каждая реплика с новой строки — время (можно без него), роль, двоеточие, текст. Роли: client, operator, bot, system — можно по-русски.';
      upSubmitLabel();
    });

    var input = $('#up-file');
    var drop = $('#up-drop');
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      input.value = ''; // чтобы повторный выбор того же файла снова сработал
      if (f) readFile(f);
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFile(f);
    });
  }

  /* ---------- старт ---------- */
  bindPage();
  bindUpload();
  load();
})();
