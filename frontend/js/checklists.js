/* CQA — страница «Чек-листы»: список, редактор, версии, замена критерия.
   Правила проверки — общие с сервером (checklist-model.js).
   При вводе текста форма не перерисовывается целиком (курсор не теряется):
   обновляются только заголовок строки, веса, ошибки и панель сохранения.
   Полная перерисовка — при смене структуры (добавить, удалить, сдвинуть, сменить тип). */
(function () {
  'use strict';

  var CQA = window.CQA;
  var M = CQA.checklistModel;
  var $ = CQA.$;
  var esc = CQA.esc;

  var st = {
    list: [],
    current: null,     // последняя версия с сервера
    draft: null,       // то, что редактируем
    viewing: null,     // открытая для просмотра старая версия
    open: {},          // раскрытые критерии
    replaced: null,    // { key, old, index } — идёт замена критерия
    v: { errors: [], warnings: [] },
    errMap: {},
    touched: {},       // поля, которые уже трогали: ошибку показываем только у них
    showAll: false,    // после попытки сохранить показываем все ошибки
    busy: false,
    loaded: false
  };

  function icon(id, cls) { return '<svg class="i ' + (cls || 'i-sm') + '"><use href="#' + id + '"/></svg>'; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function editable(cl) { return clone({ name: cl.name, instructions: cl.instructions || '', sections: cl.sections, criteria: cl.criteria }); }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getDate() + ' ' + months[d.getMonth()] + ' в ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function num(i) { return (i < 9 ? '0' : '') + (i + 1); }
  function plural(n, f) { var a = n % 10, b = n % 100; return a === 1 && b !== 11 ? f[0] : a >= 2 && a <= 4 && (b < 12 || b > 14) ? f[1] : f[2]; }

  /* ---------- состояние черновика ---------- */

  /** Копия версии, где критерии стоят в порядке разделов (как их видит пользователь). */
  function ordered(cl) {
    var e = editable(cl);
    var order = {};
    e.sections.forEach(function (s, i) { order[s.key] = i; });
    var rank = function (c) { return order[c.section] === undefined ? 999 : order[c.section]; };
    e.criteria = e.criteria.map(function (c, i) { return { c: c, i: i }; })
      .sort(function (a, b) { return (rank(a.c) - rank(b.c)) || (a.i - b.i); })
      .map(function (x) { return x.c; });
    return e;
  }

  function setDraft(cl) { st.draft = ordered(cl); }

  function isDirty() {
    if (!st.current || !st.draft) return false;
    return JSON.stringify(M.normalize(st.draft)) !== JSON.stringify(M.normalize(ordered(st.current)));
  }

  function validateNow() {
    st.v = M.validate(st.draft);
    st.errMap = {};
    st.v.errors.forEach(function (e) { if (!st.errMap[e.path]) st.errMap[e.path] = e.message; });
  }

  function crit(key) { return st.draft.criteria.filter(function (c) { return c.key === key; })[0]; }
  function critIndex(key) { return st.draft.criteria.map(function (c) { return c.key; }).indexOf(key); }

  /** Критерии всегда идут в порядке разделов: так номер в списке совпадает с номером в оценке. */
  function reorderBySections() {
    var order = {};
    st.draft.sections.forEach(function (s, i) { order[s.key] = i; });
    st.draft.criteria = st.draft.criteria
      .map(function (c, i) { return { c: c, i: i }; })
      .sort(function (a, b) { return ((order[a.c.section] === undefined ? 999 : order[a.c.section]) - (order[b.c.section] === undefined ? 999 : order[b.c.section])) || (a.i - b.i); })
      .map(function (x) { return x.c; });
  }

  /* ---------- загрузка ---------- */

  function loadList(selectId) {
    return CQA.api.get('/api/checklists').then(function (res) {
      st.list = res.items || [];
      st.loaded = true;
      var id = selectId || (st.current && st.current.id);
      if (!st.list.some(function (x) { return x.id === id; })) {
        var active = st.list.filter(function (x) { return x.active; })[0];
        id = active ? active.id : (st.list[0] && st.list[0].id);
      }
      renderList(id);
      if (id && (!st.current || st.current.id !== id || selectId)) return loadChecklist(id);
      if (!id) renderEmpty();
      return null;
    }).catch(function (err) {
      $('#cl-editor').innerHTML = '<div class="cqa-panel"><div class="cqa-empty is-error"><span class="cqa-empty-icon">' + icon('i-alert', '') + '</span><b>Не удалось загрузить чек-листы</b><p>' + esc(err.message) + '</p></div></div>';
    });
  }

  function loadChecklist(id) {
    return CQA.api.get('/api/checklists/' + encodeURIComponent(id)).then(function (cl) {
      st.current = cl;
      setDraft(cl);
      st.viewing = null;
      st.open = {};
      st.replaced = null;
      st.touched = {}; st.showAll = false;
      validateNow();
      renderList(cl.id);
      renderEditor();
    }).catch(function (err) { CQA.toast(err.message); });
  }

  /* ---------- список чек-листов ---------- */

  function renderList(selectedId) {
    $('#cl-list').innerHTML = st.list.map(function (x) {
      var dirtyMark = st.current && st.current.id === x.id && isDirty() ? ' <span class="cqa-chip cqa-chip-amber">не сохранён</span>' : '';
      return '<button class="cqa-cl-item" type="button" data-id="' + esc(x.id) + '" aria-current="' + (x.id === selectedId) + '">' +
        '<span class="cqa-cl-item-name">' + esc(x.name) + '</span>' +
        '<span class="cqa-cl-item-meta">' +
          (x.active ? '<span class="cqa-chip cqa-chip-green">Используется</span>' : '') +
          '<span class="cqa-chip">Версия ' + x.version + '</span>' +
          '<span class="cqa-chip">' + x.criteria_count + ' ' + plural(x.criteria_count, ['критерий', 'критерия', 'критериев']) + '</span>' + dirtyMark +
        '</span></button>';
    }).join('');
  }

  function renderEmpty() {
    $('#cl-editor').innerHTML = '<div class="cqa-panel"><div class="cqa-empty"><span class="cqa-empty-icon">' + icon('i-list', '') + '</span>' +
      '<b>Чек-листов нет</b><p>Создайте первый — проще всего из чек-листа задания.</p></div></div>';
  }

  /* ---------- редактор ---------- */

  /** Ошибку показываем, если поле уже трогали или была попытка сохранить. */
  function visibleErr(path) {
    if (!st.errMap[path]) return '';
    if (st.showAll || st.touched[path]) return st.errMap[path];
    // ошибки уровня «шкала целиком» / «чек-лист целиком» — сразу, они не про пустое поле
    if (/\.scale$|^criteria$|^sections$/.test(path)) return st.errMap[path];
    return '';
  }
  function errHtml(path) { return '<span class="cqa-field-err" data-err="' + esc(path) + '">' + esc(visibleErr(path)) + '</span>'; }

  function renderEditor() {
    if (!st.current) { renderEmpty(); return; }
    if (st.viewing) { renderVersionView(); renderSavebar(); return; }
    var focus = rememberFocus();
    var d = st.draft;
    var cur = st.current;

    var versionOptions = cur.versions.slice().reverse().map(function (v) {
      return '<option value="' + v.version + '"' + (v.version === cur.latest_version ? ' selected' : '') + '>Версия ' + v.version + (v.version === cur.latest_version ? ' (текущая)' : '') + ' — ' + esc(fmtDate(v.saved_at)) + '</option>';
    }).join('');

    var html =
      '<div class="cqa-panel cqa-cl-top-panel"><div class="cqa-panel-body">' +
        '<div class="cqa-cl-top">' +
          '<label class="cqa-field"><span class="cqa-label">Название</span>' +
            '<input class="cqa-input cqa-cl-title" data-f="cl-name" data-path="name" value="' + esc(d.name) + '" maxlength="200"></label>' +
          '<div class="cqa-cl-top-actions">' +
            (cur.active
              ? '<span class="cqa-chip cqa-chip-green" title="По этому чек-листу оценивают по умолчанию">' + icon('i-check') + 'Используется</span>'
              : '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm" type="button" data-act="activate">' + icon('i-check') + 'Сделать используемым</button>') +
            '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm" type="button" data-act="duplicate" title="Создать копию">Копия</button>' +
            (cur.active ? '' : '<button class="cqa-btn cqa-btn-danger cqa-btn-sm" type="button" data-act="cl-delete">' + icon('i-trash') + 'Удалить</button>') +
          '</div>' +
        '</div>' +
        errHtml('name') +
        '<div class="cqa-cl-versions">' +
          '<label class="cqa-field"><span class="cqa-label">История версий</span><select class="cqa-select" data-f="version">' + versionOptions + '</select></label>' +
          '<p class="cqa-help">Каждое сохранение — новая версия. Оценка запоминает, по какой версии её считали.</p>' +
        '</div>' +
        '<details class="cqa-cl-rules"' + (st.rulesOpen ? ' open' : '') + '><summary>' + icon('i-help') + 'Общие правила для ИИ</summary>' +
          '<textarea class="cqa-textarea" data-f="cl-instructions" data-path="instructions" rows="6">' + esc(d.instructions) + '</textarea>' +
          '<span class="cqa-help">Действуют для всех критериев: чем «Нет» отличается от N/A, как ссылаться на реплики, что не оценивается.</span>' +
          errHtml('instructions') +
        '</details>' +
        '<div class="cqa-weights" id="cl-weights">' + weightsHtml() + '</div>' +
      '</div></div>';

    var n = 0;
    d.sections.forEach(function (s, si) {
      var items = d.criteria.filter(function (c) { return c.section === s.key; });
      html += '<div class="cqa-cl-section" data-sec="' + esc(s.key) + '">' +
        '<div class="cqa-cl-section-head">' +
          '<input class="cqa-input" data-f="sec-name" data-path="sections.' + esc(s.key) + '.name" value="' + esc(s.name) + '" placeholder="Название раздела" aria-label="Название раздела" maxlength="200">' +
          '<span class="cqa-cl-section-sum" data-secsum="' + esc(s.key) + '"></span>' +
          '<span class="cqa-cl-tools">' +
            '<button class="cqa-icon-btn" type="button" data-act="sec-up" title="Раздел выше"' + (si === 0 ? ' disabled' : '') + '>' + icon('i-chev', 'i-sm cqa-rot180') + '</button>' +
            '<button class="cqa-icon-btn" type="button" data-act="sec-down" title="Раздел ниже"' + (si === d.sections.length - 1 ? ' disabled' : '') + '>' + icon('i-chev') + '</button>' +
            '<button class="cqa-icon-btn" type="button" data-act="sec-del" title="Удалить раздел">' + icon('i-trash') + '</button>' +
          '</span>' +
        '</div>' +
        errHtml('sections.' + s.key + '.name');
      items.forEach(function (c, ci) {
        html += critHtml(c, n, ci === 0, ci === items.length - 1);
        n++;
      });
      html += '<button class="cqa-add-row cqa-add-row-sm" type="button" data-act="crit-add">' + icon('i-plus') + 'Добавить критерий в раздел</button></div>';
    });
    html += '<div class="cqa-cl-bottom">' +
      '<button class="cqa-add-row" type="button" data-act="sec-add">' + icon('i-plus', 'i') + 'Добавить раздел</button>' +
      errHtml('criteria') + errHtml('sections') +
    '</div>';

    $('#cl-editor').innerHTML = html;
    refreshDerived();
    restoreFocus(focus);
  }

  function weightsHtml() {
    var sum = M.weightSummary(M.normalize(st.draft));
    var colors = ['#0E3B2E', '#23794B', '#5A9E6E', '#8DB43A', '#4C7A8C', '#A86A00'];
    var scored = sum.bySection.filter(function (s) { return s.weight > 0; });
    var bar = scored.map(function (s, i) {
      return '<span style="flex:' + s.weight + ';background:' + colors[i % colors.length] + '" title="' + esc(s.name) + ': ' + s.weight + '">' + esc(s.name || 'Раздел') + ', ' + s.weight + '</span>';
    }).join('');
    var ok = sum.total === 100;
    return '<div class="cqa-weights-head"><span>Сумма весов по разделам</span>' +
      (ok ? '<span class="cqa-weights-ok">' + icon('i-check') + '100 из 100</span>'
          : '<span class="cqa-weights-warn">' + icon('i-alert') + sum.total + ' из 100 — итог всё равно считается из 100</span>') + '</div>' +
      '<div class="cqa-weights-bar">' + (bar || '<span style="flex:1;background:var(--line)">нет критериев с баллами</span>') + '</div>';
  }

  function naChip(c) {
    if (c.type === 'flag') return '<span class="cqa-chip cqa-chip-outline">Без баллов</span>';
    return c.na_allowed ? '<span class="cqa-chip cqa-chip-slate">N/A можно</span>' : '<span class="cqa-chip cqa-chip-outline">Без N/A</span>';
  }
  function weightLabel(c) {
    if (c.type === 'flag') return '<small>флаг</small>';
    var w = Number(c.weight);
    return (isFinite(w) ? w : '—') + ' <small>' + plural(isFinite(w) ? w : 0, ['балл', 'балла', 'баллов']) + '</small>';
  }
  function typeChip(c) {
    var label = c.type === 'scale' ? 'Шкала 0–' + M.scaleMax(M.normalize({ sections: [], criteria: [c] }).criteria[0]) : M.TYPES[c.type].label;
    return '<span class="cqa-chip' + (c.type === 'flag' ? ' cqa-chip-red' : '') + '">' + esc(label) + '</span>';
  }

  function summaryHtml(c, i) {
    return '<span class="cqa-cl-no">' + num(i) + '</span>' +
      '<button class="cqa-cl-name" type="button" data-act="toggle" aria-expanded="' + Boolean(st.open[c.key]) + '">' +
        '<span data-summary="name">' + (c.name ? esc(c.name) : '<em class="cqa-muted">Новый критерий</em>') + '</span>' +
        '<small data-summary="desc">' + esc(c.description || 'Опишите, что проверяет ИИ') + '</small>' +
      '</button>' +
      '<span class="cqa-cl-type" data-summary="type">' + typeChip(c) + '</span>' +
      '<span class="cqa-cl-na" data-summary="na">' + naChip(c) + '</span>' +
      '<span class="cqa-cl-w" data-summary="weight">' + weightLabel(c) + '</span>';
  }

  function critHtml(c, i, first, last) {
    var open = Boolean(st.open[c.key]);
    var html = '<div class="cqa-cl-item-wrap" data-crit="' + esc(c.key) + '">' +
      '<div class="cqa-cl-row' + (open ? ' is-open' : '') + '">' +
        '<span class="cqa-cl-move">' +
          '<button class="cqa-icon-btn cqa-icon-btn-xs" type="button" data-act="up" title="Выше"' + (first ? ' disabled' : '') + '>' + icon('i-chev', 'i-sm cqa-rot180') + '</button>' +
          '<button class="cqa-icon-btn cqa-icon-btn-xs" type="button" data-act="down" title="Ниже"' + (last ? ' disabled' : '') + '>' + icon('i-chev') + '</button>' +
        '</span>' +
        '<span class="cqa-cl-summary" data-summary-box>' + summaryHtml(c, i) + '</span>' +
        '<span class="cqa-cl-err-dot" title="В критерии есть ошибки"></span>' +
        '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm cqa-cl-replace" type="button" data-act="replace" title="Заменить критерий другим (с тем же разделом и весом)">' + icon('i-refresh') + '<span>Заменить</span></button>' +
        '<button class="cqa-icon-btn" type="button" data-act="toggle" title="' + (open ? 'Свернуть' : 'Изменить') + '">' + icon(open ? 'i-chev' : 'i-edit', open ? 'i cqa-rot180' : 'i') + '</button>' +
      '</div>';
    if (open) html += editHtml(c);
    return html + '</div>';
  }

  function editHtml(c) {
    var p = 'criteria.' + c.key + '.';
    var sections = st.draft.sections.map(function (s) {
      return '<option value="' + esc(s.key) + '"' + (s.key === c.section ? ' selected' : '') + '>' + esc(s.name || 'Раздел без названия') + '</option>';
    }).join('');
    var replacing = st.replaced && st.replaced.key === c.key
      ? '<div class="cqa-replace-note">' + icon('i-refresh', 'i') + '<p><b>Замена критерия «' + esc(st.replaced.old.name) + '».</b> Заполните новый критерий и нажмите «Сохранить» внизу — получится новая версия чек-листа.</p>' +
        '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm" type="button" data-act="replace-undo">Вернуть старый</button></div>'
      : '';

    var scale = '';
    if (c.type === 'scale') {
      scale = '<div class="cqa-scale"><span class="cqa-label">Ступени шкалы</span>' +
        c.scale.map(function (s, i) {
          return '<div class="cqa-scale-row">' +
            '<input class="cqa-input cqa-input-num" data-f="step-points" data-i="' + i + '" data-path="' + p + 'scale.' + i + '.points" value="' + esc(s.points) + '" inputmode="numeric" aria-label="Баллы ступени">' +
            '<input class="cqa-input" data-f="step-text" data-i="' + i + '" data-path="' + p + 'scale.' + i + '.text" value="' + esc(s.text) + '" placeholder="Когда ставится эта ступень" aria-label="Описание ступени" maxlength="500">' +
            '<button class="cqa-icon-btn" type="button" data-act="step-del" data-i="' + i + '" title="Удалить ступень"' + (c.scale.length <= 2 ? ' disabled' : '') + '>' + icon('i-trash') + '</button>' +
          '</div>' + errHtml(p + 'scale.' + i + '.points') + errHtml(p + 'scale.' + i + '.text');
        }).join('') +
        errHtml(p + 'scale') +
        '<button class="cqa-btn-link" type="button" data-act="step-add" style="justify-self:start;display:inline-flex;gap:6px;align-items:center">' + icon('i-plus') + 'Добавить ступень</button>' +
        '<span class="cqa-help">Верхняя ступень даёт полный вес критерия. Порядок ступеней не важен — сохранятся по убыванию.</span>' +
      '</div>';
    }

    var na = c.type === 'flag'
      ? '<div class="cqa-na-box"><b>Флаг без баллов</b><span class="cqa-help">Отмечается отдельно от итога (как «Грубые ошибки»): «Да» — нарушение найдено, «Нет» — не найдено.</span></div>'
      : '<div class="cqa-na-box">' +
          '<label class="cqa-toggle"><input type="checkbox" data-f="na_allowed"' + (c.na_allowed ? ' checked' : '') + '><span class="cqa-toggle-track"></span>Можно ставить N/A</label>' +
          (c.na_allowed
            ? '<label class="cqa-field"><span class="cqa-label">Когда критерий не применим</span>' +
              '<textarea class="cqa-textarea" data-f="na_condition" data-path="' + p + 'na_condition" rows="2">' + esc(c.na_condition) + '</textarea></label>' + errHtml(p + 'na_condition')
            : '<span class="cqa-help">Без N/A критерий оценивается в каждом диалоге.</span>') +
          '<span class="cqa-help">При N/A вес критерия делится между остальными, максимум остаётся 100.</span>' +
        '</div>';

    return '<div class="cqa-cl-edit">' + replacing +
      '<div class="cqa-cl-edit-grid">' +
        '<label class="cqa-field"><span class="cqa-label">Название критерия</span>' +
          '<input class="cqa-input" data-f="name" data-path="' + p + 'name" value="' + esc(c.name) + '" maxlength="200">' + errHtml(p + 'name') + '</label>' +
        '<label class="cqa-field"><span class="cqa-label">Как отвечать</span><select class="cqa-select" data-f="type">' +
          ['yes_no', 'scale', 'flag'].map(function (t) { return '<option value="' + t + '"' + (c.type === t ? ' selected' : '') + '>' + M.TYPES[t].label + '</option>'; }).join('') +
        '</select></label>' +
        '<label class="cqa-field"><span class="cqa-label">Вес, баллов</span>' +
          '<input class="cqa-input cqa-input-num" data-f="weight" data-path="' + p + 'weight" value="' + (c.type === 'flag' ? '0' : esc(c.weight)) + '" inputmode="numeric" style="width:100%"' + (c.type === 'flag' ? ' disabled' : '') + '>' + errHtml(p + 'weight') + '</label>' +
      '</div>' +
      '<label class="cqa-field"><span class="cqa-label">Раздел</span><select class="cqa-select" data-f="section">' + sections + '</select></label>' +
      '<label class="cqa-field"><span class="cqa-label">Что проверяет ИИ</span>' +
        '<textarea class="cqa-textarea" data-f="description" data-path="' + p + 'description" rows="3" placeholder="Например: Да — оператор поздоровался на языке клиента и представился в первом ответе.">' + esc(c.description) + '</textarea>' +
        '<span class="cqa-help">Пишите так, как объясняли бы новому сотруднику: когда «Да», когда «Нет». ИИ читает этот текст при оценке.</span>' + errHtml(p + 'description') + '</label>' +
      '<label class="cqa-field"><span class="cqa-label">Пояснения и примеры для ИИ <span class="cqa-muted">(необязательно)</span></span>' +
        '<textarea class="cqa-textarea" data-f="guidance" data-path="' + p + 'guidance" rows="2" placeholder="Спорные случаи, примеры, чего не считать нарушением">' + esc(c.guidance) + '</textarea>' + errHtml(p + 'guidance') + '</label>' +
      (scale ? '<div class="cqa-cl-edit-2">' + scale + na + '</div>' : na) +
      '<div class="cqa-cl-edit-foot">' +
        '<div class="cqa-cl-edit-foot-left">' +
          '<button class="cqa-btn cqa-btn-danger cqa-btn-sm" type="button" data-act="crit-del">' + icon('i-trash') + 'Удалить критерий</button>' +
          '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm" type="button" data-act="replace">' + icon('i-refresh') + 'Заменить критерий</button>' +
        '</div>' +
        '<button class="cqa-btn cqa-btn-primary cqa-btn-sm" type="button" data-act="toggle">' + icon('i-check') + 'Готово</button>' +
      '</div>' +
    '</div>';
  }

  /** Всё, что зависит от черновика, но не требует перерисовки формы. */
  function refreshDerived(changedKey) {
    var editor = $('#cl-editor');
    if (!editor || st.viewing) return;
    // заголовок изменённой строки
    if (changedKey) {
      var box = editor.querySelector('[data-crit="' + cssEsc(changedKey) + '"] [data-summary-box]');
      var c = crit(changedKey);
      if (box && c) box.innerHTML = summaryHtml(c, critIndex(changedKey));
    }
    var w = $('#cl-weights');
    if (w) w.innerHTML = weightsHtml();
    var sum = M.weightSummary(M.normalize(st.draft));
    sum.bySection.forEach(function (s) {
      var el = editor.querySelector('[data-secsum="' + cssEsc(s.key) + '"]');
      if (el) el.textContent = s.weight ? 'вес раздела ' + s.weight : 'без баллов';
    });
    // ошибки у полей
    editor.querySelectorAll('[data-err]').forEach(function (el) { el.textContent = visibleErr(el.getAttribute('data-err')); });
    editor.querySelectorAll('[data-path]').forEach(function (el) {
      if (visibleErr(el.getAttribute('data-path'))) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    });
    // красная точка у строк с ошибками
    editor.querySelectorAll('[data-crit]').forEach(function (wrap) {
      var k = wrap.getAttribute('data-crit');
      var bad = st.v.errors.some(function (e) { return e.path.indexOf('criteria.' + k + '.') === 0; });
      wrap.querySelector('.cqa-cl-row').classList.toggle('has-error', bad);
    });
    renderSavebar();
    if (st.current) {
      var item = $('#cl-list').querySelector('[data-id="' + cssEsc(st.current.id) + '"]');
      if (item) renderList(st.current.id);
    }
  }

  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  function renderSavebar() {
    var bar = $('#cl-savebar');
    var dirty = isDirty();
    var errors = st.v.errors.length;
    bar.hidden = !dirty;
    if (!dirty) return;
    var text = '<b>Есть несохранённые изменения.</b> Сохранение создаст версию ' + ((st.current && st.current.latest_version) + 1) + '.';
    if (errors) text += ' <button class="cqa-btn-link cqa-savebar-err" type="button" data-act="first-error">' + icon('i-alert') + 'Исправьте ' + errors + ' ' + plural(errors, ['ошибку', 'ошибки', 'ошибок']) + '</button>';
    $('#cl-savebar-text').innerHTML = text;
    var save = $('#cl-save');
    save.disabled = errors > 0 || st.busy;
    $('#cl-save-text').textContent = st.busy ? 'Сохраняю…' : 'Сохранить';
  }

  /* ---------- просмотр старой версии ---------- */

  function renderVersionView() {
    var v = st.viewing;
    var cur = st.current;
    var versionOptions = cur.versions.slice().reverse().map(function (x) {
      return '<option value="' + x.version + '"' + (x.version === v.version ? ' selected' : '') + '>Версия ' + x.version + (x.version === cur.latest_version ? ' (текущая)' : '') + ' — ' + esc(fmtDate(x.saved_at)) + '</option>';
    }).join('');
    var meta = cur.versions.filter(function (x) { return x.version === v.version; })[0] || {};
    var n = 0;
    var body = v.sections.map(function (s) {
      var items = v.criteria.filter(function (c) { return c.section === s.key; });
      return '<div class="cqa-cl-section"><div class="cqa-cl-section-head"><b class="cqa-cl-section-title">' + esc(s.name) + '</b></div>' +
        items.map(function (c) {
          var i = n++;
          return '<div class="cqa-cl-item-wrap"><div class="cqa-cl-row is-readonly"><span class="cqa-cl-move"></span><span class="cqa-cl-summary">' +
            '<span class="cqa-cl-no">' + num(i) + '</span><span class="cqa-cl-name"><span>' + esc(c.name) + '</span><small>' + esc(c.description) + '</small></span>' +
            '<span class="cqa-cl-type">' + typeChip(c) + '</span><span class="cqa-cl-na">' + naChip(c) + '</span><span class="cqa-cl-w">' + weightLabel(c) + '</span></span></div></div>';
        }).join('') + '</div>';
    }).join('');
    $('#cl-editor').innerHTML =
      '<div class="cqa-panel cqa-cl-top-panel"><div class="cqa-panel-body">' +
        '<div class="cqa-version-note">' + icon('i-clock', 'i') + '<div><b>Вы смотрите версию ' + v.version + ' от ' + esc(fmtDate(v.saved_at)) + '.</b> Только просмотр — изменить можно текущую версию.' +
          (meta.changes && meta.changes.length ? '<ul class="cqa-changes">' + meta.changes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') + '</div></div>' +
        '<div class="cqa-cl-versions"><label class="cqa-field"><span class="cqa-label">История версий</span><select class="cqa-select" data-f="version">' + versionOptions + '</select></label>' +
          '<div class="cqa-cl-top-actions">' +
            '<button class="cqa-btn cqa-btn-ghost cqa-btn-sm" type="button" data-act="view-latest">К текущей версии</button>' +
            '<button class="cqa-btn cqa-btn-primary cqa-btn-sm" type="button" data-act="restore">' + icon('i-refresh') + 'Вернуть эту версию</button>' +
          '</div></div>' +
        '<h2 style="margin-top:6px">' + esc(v.name) + '</h2>' +
      '</div></div>' + body;
  }

  /* ---------- фокус при перерисовке ---------- */

  function rememberFocus() {
    var el = document.activeElement;
    if (!el || !$('#cl-editor').contains(el)) return null;
    var wrap = el.closest('[data-crit]');
    var sec = el.closest('[data-sec]');
    return {
      path: el.getAttribute('data-path'),
      f: el.getAttribute('data-f'), i: el.getAttribute('data-i'),
      crit: wrap && wrap.getAttribute('data-crit'), sec: sec && sec.getAttribute('data-sec'),
      start: typeof el.selectionStart === 'number' ? el.selectionStart : null
    };
  }

  function restoreFocus(f) {
    if (!f) return;
    var root = $('#cl-editor');
    var el = (f.path && root.querySelector('[data-path="' + cssEsc(f.path) + '"]')) ||
      (f.crit && f.f && root.querySelector('[data-crit="' + cssEsc(f.crit) + '"] [data-f="' + f.f + '"]' + (f.i ? '[data-i="' + f.i + '"]' : ''))) || null;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (f.start !== null && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(f.start, f.start); } catch (_) { /* select/number */ } }
  }

  function focusField(path) {
    var el = $('#cl-editor').querySelector('[data-path="' + cssEsc(path) + '"]');
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); }
  }

  /* ---------- действия ---------- */

  function onInput(e) {
    var el = e.target;
    var f = el.getAttribute('data-f');
    if (!f || st.viewing || !st.draft) return;
    var wrap = el.closest('[data-crit]');
    var key = wrap && wrap.getAttribute('data-crit');
    var c = key && crit(key);
    var structural = false;
    if (el.getAttribute('data-path')) st.touched[el.getAttribute('data-path')] = true;

    switch (f) {
      case 'cl-name': st.draft.name = el.value; break;
      case 'cl-instructions': st.draft.instructions = el.value; break;
      case 'sec-name': {
        var sk = el.closest('[data-sec]').getAttribute('data-sec');
        st.draft.sections.forEach(function (s) { if (s.key === sk) s.name = el.value; });
        $('#cl-editor').querySelectorAll('[data-f="section"] option[value="' + cssEsc(sk) + '"]').forEach(function (o) { o.textContent = el.value || 'Раздел без названия'; });
        break;
      }
      case 'name': case 'description': case 'guidance': case 'na_condition': c[f] = el.value; break;
      case 'weight': c.weight = el.value.trim() === '' ? NaN : Number(el.value.replace(',', '.')); break;
      case 'step-points': c.scale[Number(el.getAttribute('data-i'))].points = el.value.trim() === '' ? NaN : Number(el.value); break;
      case 'step-text': c.scale[Number(el.getAttribute('data-i'))].text = el.value; break;
      default: return; // select/checkbox — в onChange
    }
    validateNow();
    if (structural) renderEditor(); else refreshDerived(key);
  }

  function onChange(e) {
    var el = e.target;
    var f = el.getAttribute('data-f');
    if (!f || !st.current) return;
    if (f === 'version') { openVersion(Number(el.value)); return; }
    if (st.viewing || !st.draft) return;
    var wrap = el.closest('[data-crit]');
    var c = wrap && crit(wrap.getAttribute('data-crit'));
    if (!c) return;
    if (f === 'type') {
      c.type = el.value;
      if (c.type === 'scale' && c.scale.length < 2) {
        var top = isFinite(Number(c.weight)) && Number(c.weight) > 0 ? Number(c.weight) : 10;
        c.scale = [{ points: top, text: '' }, { points: Math.round(top / 2), text: '' }, { points: 0, text: '' }];
      }
      if (c.type === 'flag') { c.weight = 0; c.na_allowed = false; }
      else if (!(Number(c.weight) > 0)) c.weight = 10;
    } else if (f === 'section') {
      c.section = el.value;
      reorderBySections();
    } else if (f === 'na_allowed') {
      c.na_allowed = el.checked;
    } else {
      return;
    }
    validateNow();
    renderEditor();
  }

  function onClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    var act = btn.getAttribute('data-act');
    var wrap = btn.closest('[data-crit]');
    var key = wrap && wrap.getAttribute('data-crit');
    var secEl = btn.closest('[data-sec]');
    var secKey = secEl && secEl.getAttribute('data-sec');
    var d = st.draft;

    switch (act) {
      case 'toggle':
        st.open[key] = !st.open[key];
        renderEditor();
        if (st.open[key]) focusField('criteria.' + key + '.name');
        else { var tg = $('#cl-editor').querySelector('[data-crit="' + cssEsc(key) + '"] .cqa-cl-name'); if (tg) tg.focus(); }
        return;
      case 'up': case 'down': moveCrit(key, act === 'up' ? -1 : 1); return;
      case 'sec-up': case 'sec-down': moveSection(secKey, act === 'sec-up' ? -1 : 1); return;
      case 'crit-add': addCrit(secKey); return;
      case 'sec-add': {
        var s = { key: M.newKey('s'), name: '' };
        d.sections.push(s);
        validateNow(); renderEditor(); focusField('sections.' + s.key + '.name');
        return;
      }
      case 'sec-del': deleteSection(secKey); return;
      case 'crit-del': {
        var c = crit(key);
        confirmModal({ title: 'Удалить критерий?', text: '«' + (c.name || 'Новый критерий') + '» пропадёт из чек-листа после сохранения. В старых версиях он останется.', ok: 'Удалить' }, function () {
          d.criteria = d.criteria.filter(function (x) { return x.key !== key; });
          delete st.open[key];
          if (st.replaced && st.replaced.key === key) st.replaced = null;
          validateNow(); renderEditor();
        });
        return;
      }
      case 'replace': replaceCrit(key); return;
      case 'replace-undo': undoReplace(); return;
      case 'step-add': {
        var cc = crit(key);
        var min = Math.min.apply(null, cc.scale.map(function (x) { return Number(x.points) || 0; }).concat([0]));
        cc.scale.push({ points: min > 0 ? 0 : '', text: '' });
        validateNow(); renderEditor(); focusField('criteria.' + key + '.scale.' + (cc.scale.length - 1) + '.points');
        return;
      }
      case 'step-del': crit(key).scale.splice(Number(btn.getAttribute('data-i')), 1); validateNow(); renderEditor(); return;
      case 'activate': activate(); return;
      case 'duplicate': openNewModal(true); return;
      case 'cl-delete': deleteChecklist(); return;
      case 'view-latest': st.viewing = null; renderEditor(); return;
      case 'restore': restoreVersion(); return;
      case 'first-error': goToFirstError(); return;
      default:
    }
  }

  function moveCrit(key, dir) {
    var d = st.draft;
    var c = crit(key);
    var same = d.criteria.filter(function (x) { return x.section === c.section; });
    var pos = same.indexOf(c);
    var other = same[pos + dir];
    if (!other) return;
    var i = d.criteria.indexOf(c), j = d.criteria.indexOf(other);
    d.criteria[i] = other; d.criteria[j] = c;
    validateNow(); renderEditor();
    var row = $('#cl-editor').querySelector('[data-crit="' + cssEsc(key) + '"]');
    var same = row && row.querySelector('[data-act="' + (dir < 0 ? 'up' : 'down') + '"]');
    var other = row && row.querySelector('[data-act="' + (dir < 0 ? 'down' : 'up') + '"]');
    if (same && !same.disabled) same.focus(); else if (other) other.focus(); // можно жать дальше с клавиатуры
  }

  function moveSection(key, dir) {
    var arr = st.draft.sections;
    var i = arr.map(function (s) { return s.key; }).indexOf(key);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    reorderBySections();
    validateNow(); renderEditor();
    var head = $('#cl-editor').querySelector('[data-sec="' + cssEsc(key) + '"] .cqa-cl-section-head');
    var sb = head && head.querySelector('[data-act="' + (dir < 0 ? 'sec-up' : 'sec-down') + '"]');
    var ob = head && head.querySelector('[data-act="' + (dir < 0 ? 'sec-down' : 'sec-up') + '"]');
    if (sb && !sb.disabled) sb.focus(); else if (ob) ob.focus();
  }

  function addCrit(secKey) {
    var c = M.blankCriterion(secKey, { weight: 10 });
    var d = st.draft;
    var lastIdx = -1;
    d.criteria.forEach(function (x, i) { if (x.section === secKey) lastIdx = i; });
    if (lastIdx < 0) { d.criteria.push(c); reorderBySections(); } else d.criteria.splice(lastIdx + 1, 0, c);
    st.open[c.key] = true;
    validateNow(); renderEditor(); focusField('criteria.' + c.key + '.name');
  }

  function deleteSection(key) {
    var d = st.draft;
    var s = d.sections.filter(function (x) { return x.key === key; })[0];
    var count = d.criteria.filter(function (c) { return c.section === key; }).length;
    var go = function () {
      d.sections = d.sections.filter(function (x) { return x.key !== key; });
      d.criteria = d.criteria.filter(function (c) { return c.section !== key; });
      validateNow(); renderEditor();
    };
    if (!count) { go(); return; }
    confirmModal({ title: 'Удалить раздел?', text: 'Раздел «' + (s.name || 'без названия') + '» и ' + count + ' ' + plural(count, ['критерий', 'критерия', 'критериев']) + ' в нём пропадут после сохранения.', ok: 'Удалить раздел' }, go);
  }

  /** «Заменить критерий» (контроль): на его месте — новый пустой с тем же разделом и весом. */
  function replaceCrit(key) {
    var d = st.draft;
    var i = critIndex(key);
    var old = d.criteria[i];
    var original = st.replaced && st.replaced.key === key ? st.replaced.old : old; // для «Вернуть старый»
    var fresh = M.blankCriterion(old.section, { weight: old.type === 'flag' ? 10 : old.weight });
    if (old.type === 'flag') { fresh.type = 'flag'; fresh.weight = 0; }
    d.criteria.splice(i, 1, fresh);
    delete st.open[key];
    st.open[fresh.key] = true;
    st.replaced = { key: fresh.key, old: original, index: i };
    validateNow(); renderEditor();
    focusField('criteria.' + fresh.key + '.name');
  }

  function undoReplace() {
    var r = st.replaced;
    if (!r) return;
    var i = critIndex(r.key);
    if (i >= 0) st.draft.criteria.splice(i, 1, r.old); else st.draft.criteria.splice(r.index, 0, r.old);
    reorderBySections(); // если за время замены меняли раздел — порядок снова по разделам
    delete st.open[r.key];
    st.replaced = null;
    validateNow(); renderEditor();
    CQA.toast('Вернули критерий «' + r.old.name + '»');
  }

  function goToFirstError() {
    var e = st.v.errors[0];
    if (!e) return;
    if (!st.showAll) { st.showAll = true; refreshDerived(); }
    var m = /^criteria\.([^.]+)\./.exec(e.path);
    if (m && !st.open[m[1]]) { st.open[m[1]] = true; renderEditor(); }
    if (e.path === 'instructions') { st.rulesOpen = true; renderEditor(); }
    focusField(e.path);
    var el = $('#cl-editor').querySelector('[data-err="' + cssEsc(e.path) + '"]');
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ---------- версии ---------- */

  function openVersion(version) {
    if (version === st.current.latest_version) { st.viewing = null; renderEditor(); return; }
    var go = function () {
      CQA.api.get('/api/checklists/' + encodeURIComponent(st.current.id) + '/versions/' + version).then(function (v) {
        st.viewing = v;
        renderEditor();
      }).catch(function (err) { CQA.toast(err.message); });
    };
    if (isDirty()) askLeave('Чтобы смотреть другую версию, сохраните или отмените правки.', go, function () { renderEditor(); });
    else go();
  }

  function restoreVersion() {
    var v = st.viewing;
    setDraft(v);
    st.viewing = null;
    st.open = {};
    st.replaced = null;
      st.touched = {}; st.showAll = false;
    validateNow();
    renderEditor();
    CQA.toast('Версия ' + v.version + ' загружена в редактор. Нажмите «Сохранить», чтобы она стала текущей.');
  }

  /* ---------- сохранение ---------- */

  function save() {
    if (!st.current || st.busy) return Promise.resolve(false);
    validateNow();
    if (st.v.errors.length) { refreshDerived(); goToFirstError(); return Promise.resolve(false); }
    if (!isDirty()) return Promise.resolve(true);
    st.busy = true;
    renderSavebar();
    var id = st.current.id;
    return CQA.api.put('/api/checklists/' + encodeURIComponent(id), { base_version: st.current.latest_version, checklist: M.normalize(st.draft) }).then(function (res) {
      st.busy = false;
      st.current = res;
      setDraft(res);
      st.replaced = null;
      st.touched = {}; st.showAll = false;
      validateNow();
      return loadListOnly().then(function () {
        renderEditor();
        if (res.unchanged) { CQA.toast('Изменений нет — версия не создана'); return true; }
        showSaved(res);
        return true;
      });
    }).catch(function (err) {
      st.busy = false;
      renderSavebar();
      if (err.status === 409) {
        confirmModal({ title: 'Чек-лист уже изменили', text: err.message + ' Загрузить свежую версию? Ваши правки в этой вкладке пропадут.', ok: 'Загрузить свежую', danger: false }, function () { loadChecklist(id); });
      } else {
        CQA.toast(err.message);
      }
      return false;
    });
  }

  function loadListOnly() {
    return CQA.api.get('/api/checklists').then(function (res) { st.list = res.items || []; renderList(st.current && st.current.id); });
  }

  function showSaved(res) {
    $('#mcs-title').textContent = 'Сохранено: версия ' + res.version;
    $('#mcs-sub').textContent = '«' + res.name + '» — ' + fmtDate(res.saved_at) + '.';
    $('#mcs-changes').innerHTML = (res.changes || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
    var warn = $('#mcs-warn');
    var ws = res.warnings || [];
    warn.hidden = !ws.length;
    warn.innerHTML = ws.length ? icon('i-alert', 'i') + '<div><p><b>Стоит проверить:</b></p><ul>' + ws.map(function (w) { return '<li>' + esc(w.message) + '</li>'; }).join('') + '</ul></div>' : '';
    CQA.openModal('modal-cl-saved');
  }

  function discard() {
    setDraft(st.current);
    st.open = {};
    st.replaced = null;
      st.touched = {}; st.showAll = false;
    validateNow();
    renderEditor();
  }

  /* ---------- активация, создание, удаление ---------- */

  function activate() {
    CQA.api.post('/api/checklists/' + encodeURIComponent(st.current.id) + '/activate', {}).then(function (res) {
      st.current.active = res.active;
      return loadListOnly().then(function () { renderEditor(); CQA.toast('Теперь по умолчанию используется «' + res.name + '»'); });
    }).catch(function (err) { CQA.toast(err.message); });
  }

  function deleteChecklist() {
    var cur = st.current;
    confirmModal({ title: 'Удалить чек-лист?', text: '«' + cur.name + '» и все его версии будут удалены.', ok: 'Удалить чек-лист' }, function () {
      CQA.api.del('/api/checklists/' + encodeURIComponent(cur.id)).then(function () {
        st.current = null; st.draft = null;
        CQA.toast('Чек-лист «' + cur.name + '» удалён');
        return loadList();
      }).catch(function (err) { CQA.toast(err.message); });
    });
  }

  function openNewModal(fromCurrent) {
    var go = function () {
      $('#mcn-name').value = '';
      $('#mcn-err').hidden = true;
      $('#mcn-current-name').textContent = st.current ? '«' + st.current.name + '», версия ' + st.current.latest_version : 'нет открытого чек-листа';
      $('#mcn-from-current').disabled = !st.current;
      $('#mcn-from-current').checked = Boolean(st.current) && fromCurrent !== false;
      $('#mcn-from-default').checked = !$('#mcn-from-current').checked;
      CQA.openModal('modal-cl-new');
      $('#mcn-name').focus();
    };
    if (isDirty()) askLeave('Перед созданием нового чек-листа сохраните или отмените правки.', go);
    else go();
  }

  function createChecklist(e) {
    e.preventDefault();
    var fromCurrent = $('#mcn-from-current').checked && st.current;
    CQA.api.post('/api/checklists', { from: fromCurrent ? st.current.id : undefined, name: $('#mcn-name').value.trim() || undefined }).then(function (res) {
      CQA.closeModal('modal-cl-new');
      CQA.toast('Создан чек-лист «' + res.name + '»');
      st.current = null;
      return loadList(res.id);
    }).catch(function (err) {
      var el = $('#mcn-err');
      el.hidden = false;
      el.innerHTML = icon('i-alert', 'i') + '<div><p>' + esc(err.message) + '</p></div>';
    });
  }

  /* ---------- окна ---------- */

  var confirmCb = null;
  function confirmModal(o, onOk) {
    $('#mcf-title').textContent = o.title;
    $('#mcf-text').textContent = o.text;
    var ok = $('#mcf-ok');
    ok.textContent = o.ok || 'Удалить';
    ok.className = 'cqa-btn ' + (o.danger === false ? 'cqa-btn-primary' : 'cqa-btn-danger');
    confirmCb = onOk;
    CQA.openModal('modal-confirm');
  }

  var leaveCb = null;
  var stayCb = null;
  var leaving = false; // выбрали «Сохранить» или «Не сохранять» — закрытие окна не считается «Остаться»
  function askLeave(text, proceed, stay) {
    $('#mcl-sub').textContent = text || 'Если уйти без сохранения, правки пропадут.';
    leaveCb = proceed;
    stayCb = stay || null;
    leaving = false;
    CQA.openModal('modal-cl-leave');
  }
  function finishLeave() {
    leaving = true;
    CQA.closeModal('modal-cl-leave');
    var cb = leaveCb; leaveCb = null; stayCb = null;
    if (cb) cb();
  }

  /* ---------- привязка событий ---------- */

  function bind() {
    var editor = $('#cl-editor');
    editor.addEventListener('input', onInput);
    editor.addEventListener('change', onChange);
    editor.addEventListener('click', onClick);
    editor.addEventListener('toggle', function (e) { if (e.target.classList && e.target.classList.contains('cqa-cl-rules')) st.rulesOpen = e.target.open; }, true);
    $('#cl-savebar').addEventListener('click', onClick);

    $('#cl-list').addEventListener('click', function (e) {
      var item = e.target.closest('[data-id]');
      if (!item || (st.current && item.dataset.id === st.current.id)) return;
      var id = item.dataset.id;
      if (isDirty()) askLeave('Чтобы открыть другой чек-лист, сохраните или отмените правки.', function () { loadChecklist(id); });
      else loadChecklist(id);
    });

    $('#cl-new').addEventListener('click', function () { openNewModal(true); });
    $('#mcn-form').addEventListener('submit', createChecklist);
    $('#cl-save').addEventListener('click', save);
    $('#cl-discard').addEventListener('click', function () {
      confirmModal({ title: 'Отменить изменения?', text: 'Все несохранённые правки пропадут — вернётся версия ' + st.current.latest_version + '.', ok: 'Отменить изменения' }, discard);
    });

    $('#mcf-ok').addEventListener('click', function () {
      CQA.closeModal('modal-confirm');
      var cb = confirmCb; confirmCb = null;
      if (cb) cb();
    });

    $('#mcl-save').addEventListener('click', function () {
      // Если есть ошибки — save() не сохраняет: закрываем окно и ведём к первой ошибке.
      if (st.v.errors.length) { CQA.closeModal('modal-cl-leave'); goToFirstError(); return; }
      save().then(function (ok) {
        if (!ok) { CQA.closeModal('modal-cl-leave'); return; }
        CQA.closeModal('modal-cl-saved');
        finishLeave();
      });
    });
    $('#mcl-drop').addEventListener('click', function () {
      discard();
      finishLeave();
    });
    // Закрыли окно любым другим способом (Остаться, крестик, Esc, клик мимо) — остаёмся и возвращаем вид.
    $('#modal-cl-leave').addEventListener('cqa:modal-close', function () {
      if (leaving) return;
      var cb = stayCb; stayCb = null; leaveCb = null;
      if (cb) cb(); else renderEditor();
    });

    // Уход на другую страницу с несохранёнными правками.
    CQA.addLeaveGuard(function (from, to) {
      if (from !== 'checklists' || !isDirty()) return true;
      askLeave('Если уйти без сохранения, правки пропадут.', function () { CQA.navigate(to, true); });
      return false;
    });
    window.addEventListener('beforeunload', function (e) {
      if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });

    // Ctrl+S — сохранить.
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'ы') && document.querySelector('[data-page="checklists"].is-active')) {
        e.preventDefault();
        save();
      }
    });

    document.addEventListener('cqa:route', function (e) {
      if (e.detail.page === 'checklists' && !st.loaded) loadList();
    });
  }

  CQA.checklists = { isDirty: isDirty, save: save, reload: loadList };
  bind();
})();
