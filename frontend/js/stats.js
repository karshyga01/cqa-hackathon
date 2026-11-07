/* Вкладка «Статистика»: где теряются баллы, распределение оценок и ответов, грубые ошибки.
   Данные считает сервер (/api/stats) по финальным оценкам — с учётом решённых апелляций. */
(function () {
  'use strict';
  var CQA = window.CQA;
  var body = document.getElementById('st-body');
  if (!CQA || !body) return;

  var setSel = document.getElementById('st-set');
  var chanSel = document.getElementById('st-chan');
  var langSel = document.getElementById('st-lang');
  var esc = CQA.esc;
  var active = false;
  var seq = 0;

  var GROUPS = [
    { key: 'full', label: 'Полный балл', cls: 'is-full' },
    { key: 'partial', label: 'Частично', cls: 'is-partial' },
    { key: 'zero', label: 'Ноль («Нет» или 0)', cls: 'is-zero' },
    { key: 'na', label: 'N/A', cls: 'is-na' }
  ];
  var LANG = { RU: 'Русский', KZ: 'Казахский', EN: 'Английский' };
  var CHAN = { 'agent chat': 'Чаты', 'voice call': 'Звонки' };

  function num(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    var s = Number(x).toFixed(d === undefined ? 2 : d);
    if (s.indexOf('.') !== -1) s = s.replace(/\.?0+$/, '');   // «4.50» → «4.5», целые не трогаем
    return s.replace('.', ',');
  }
  function pts(x) { return CQA.scoring ? CQA.scoring.formatPoints(x) : num(x); }
  function pct(n, total) { return total ? Math.round((n / total) * 100) : 0; }
  function href(key) { return '#dialog/' + encodeURIComponent(key); }
  function icon(name) { return '<svg class="i"><use href="#' + name + '"/></svg>'; }
  function scoreClass(t) { return t >= 85 ? '' : t >= 70 ? ' is-mid' : ' is-low'; }
  function score(t) {
    if (t === null || t === undefined) return '<span class="cqa-score is-none">—</span>';
    return '<span class="cqa-score' + scoreClass(t) + '"><span class="cqa-score-bar"><i style="width:' + Math.max(0, Math.min(100, t)) + '%"></i></span>' + pts(t) + '</span>';
  }
  function panel(title, hint, inner, cls) {
    return '<section class="cqa-panel cqa-st-panel' + (cls ? ' ' + cls : '') + '"><div class="cqa-panel-head"><div><h2 class="cqa-st-title">' + esc(title) + '</h2>' +
      (hint ? '<p class="cqa-st-hint">' + hint + '</p>' : '') + '</div></div><div class="cqa-panel-body">' + inner + '</div></section>';
  }

  function tiles(s) {
    var ap = s.appeals || {};
    var cost = s.cost || {};
    return '<div class="cqa-summary cqa-st-summary">' +
      '<div class="cqa-sum"><span class="cqa-sum-label">Оценено</span><span class="cqa-sum-value">' + s.evaluated + ' <small>из ' + s.total_dialogs + '</small></span></div>' +
      '<div class="cqa-sum"><span class="cqa-sum-label">Средний балл</span><span class="cqa-sum-value">' + pts(s.avg) + ' <small>медиана ' + pts(s.median) + '</small></span></div>' +
      '<div class="cqa-sum"><span class="cqa-sum-label">Потеряно в среднем</span><span class="cqa-sum-value">' + (s.avg === null ? '—' : '−' + pts(Math.round((100 - s.avg) * 100) / 100)) + ' <small>из 100</small></span></div>' +
      '<div class="cqa-sum cqa-sum-red"><span class="cqa-sum-label">С грубыми ошибками</span><span class="cqa-sum-value">' + s.gross_count + ' <small>' + pct(s.gross_count, s.evaluated) + '%</small></span></div>' +
      '<div class="cqa-sum cqa-sum-amber"><span class="cqa-sum-label">Нужна проверка человеком</span><span class="cqa-sum-value">' + s.needs_review + '</span></div>' +
      '<div class="cqa-sum"><span class="cqa-sum-label">Апелляции</span><span class="cqa-sum-value">' + ((ap.decided || 0) + (ap.open || 0)) +
        ' <small>ждут ' + (ap.open || 0) + ', изменено ' + (ap.changed || 0) + '</small></span></div>' +
      '<div class="cqa-sum" title="' + esc('Модель: ' + ((s.models || []).join(', ') || '—') + '. Средняя цена полной оценки одного диалога по ' + (cost.evaluations || 0) + ' оценкам; всего потрачено ' + CQA.money(cost.spent_usd || 0)) + '">' +
        '<span class="cqa-sum-label">Цена одной оценки</span><span class="cqa-sum-value">' + (cost.per_evaluation_usd ? CQA.money(cost.per_evaluation_usd) : '—') +
        ' <small>по ' + (cost.evaluations || 0) + ' оценкам</small></span></div>' +
      '</div>';
  }

  /** Где теряются баллы: средняя потеря на диалог по критерию (из 100). Сумма = 100 − средний балл. */
  function losses(s) {
    var rows = s.criteria.filter(function (c) { return c.type !== 'flag' && c.avg_lost !== null; })
      .sort(function (a, b) { return b.avg_lost - a.avg_lost; });
    if (!rows.length) return '';
    var max = Math.max.apply(null, rows.map(function (c) { return c.avg_lost; })) || 1;
    var html = '<ol class="cqa-st-loss">' + rows.map(function (c) {
      var zero = c.counts.zero;
      var partial = c.counts.partial;
      var w = Math.max(c.avg_lost > 0 ? 2 : 0, (c.avg_lost / max) * 100);
      var tip = c.name + ': в среднем −' + num(c.avg_lost) + ' балла на диалог; набрано ' + num(c.share_earned, 1) + '% от возможного там, где критерий применим';
      return '<li title="' + esc(tip) + '">' +
        '<div class="cqa-st-loss-name"><b>' + esc(c.name) + '</b><span>вес ' + num(c.weight, 0) + ' · набрано ' + num(c.share_earned, 1) + '% возможного</span></div>' +
        '<div class="cqa-st-loss-bar" aria-hidden="true"><i style="width:' + w + '%"></i></div>' +
        '<div class="cqa-st-loss-val"><b>−' + num(c.avg_lost) + '</b><span>' +
          (c.type === 'scale' ? 'ноль: ' + zero + ', частично: ' + partial : '«Нет»: ' + zero) + (c.counts.na ? ' · N/A: ' + c.counts.na : '') +
        '</span></div></li>';
    }).join('') + '</ol>';
    var sum = rows.reduce(function (a, c) { return a + c.avg_lost; }, 0);
    html += '<p class="cqa-st-note">Потеря — сколько баллов из 100 критерий в среднем отнимает у одного диалога (после перераспределения веса N/A). Сумма по критериям: −' + num(sum) + ' = 100 − средний балл.</p>';
    return panel('Где теряются баллы', 'Отсортировано от самой большой потери. Наведите на строку, чтобы увидеть подробности.', html, 'is-wide');
  }

  /** Ответы по критериям: доля «полный балл / частично / ноль / N/A». */
  function answers(s) {
    var rows = s.criteria.filter(function (c) { return c.type !== 'flag'; });
    if (!rows.length) return '';
    var legend = '<ul class="cqa-st-legend">' + GROUPS.map(function (g) { return '<li><i class="cqa-st-sw ' + g.cls + '"></i>' + esc(g.label) + '</li>'; }).join('') + '</ul>';
    var bars = '<ul class="cqa-st-stack">' + rows.map(function (c) {
      var n = GROUPS.reduce(function (a, g) { return a + (c.counts[g.key] || 0); }, 0);
      var seg = GROUPS.filter(function (g) { return c.counts[g.key]; }).map(function (g) {
        var p = (c.counts[g.key] / n) * 100;
        var tip = c.name + ' — ' + g.label + ': ' + c.counts[g.key] + ' из ' + n + ' (' + Math.round(p) + '%)';
        return '<span class="cqa-st-seg ' + g.cls + '" style="flex-basis:' + p + '%" title="' + esc(tip) + '">' + (p >= 12 ? Math.round(p) + '%' : '') + '</span>';
      }).join('');
      return '<li><span class="cqa-st-stack-name">' + esc(c.name) + '</span><span class="cqa-st-stack-bar" role="img" aria-label="' +
        esc(c.name + ': ' + GROUPS.map(function (g) { return g.label + ' ' + (c.counts[g.key] || 0); }).join(', ')) + '">' + seg + '</span></li>';
    }).join('') + '</ul>';
    return panel('Ответы по критериям', 'Для шкал «частично» — промежуточные ступени (например, 15 или 10 из 20).', legend + bars);
  }

  /** Распределение итоговых баллов. */
  function histogram(s) {
    var max = Math.max.apply(null, s.histogram.map(function (b) { return b.n; })) || 1;
    var cols = s.histogram.map(function (b) {
      return '<div class="cqa-st-col" title="' + esc(b.label + ': ' + b.n + ' диал. (' + pct(b.n, s.computed) + '%)') + '">' +
        '<span class="cqa-st-col-n">' + b.n + '</span><span class="cqa-st-col-bar"><i style="height:' + (b.n ? Math.max(3, (b.n / max) * 100) : 0) + '%"></i></span>' +
        '<span class="cqa-st-col-label">' + esc(b.label) + '</span></div>';
    }).join('');
    return panel('Распределение итоговых баллов', 'Сколько диалогов попало в каждый диапазон. Мин. ' + pts(s.min) + ', макс. ' + pts(s.max) + '.', '<div class="cqa-st-hist">' + cols + '</div>');
  }

  function groupsTable(s) {
    function rows(list, names) {
      return list.map(function (g) {
        return '<tr><td>' + esc(names[g.key] || g.key) + '</td><td class="col-num">' + g.n + '</td><td>' + score(g.avg) + '</td><td class="col-num">' + (g.gross ? '<b class="cqa-st-red">' + g.gross + '</b>' : '0') + '</td></tr>';
      }).join('');
    }
    var html = '<div class="cqa-table-wrap"><table class="cqa-table cqa-st-table"><thead><tr><th>Группа</th><th class="col-num">Диалогов</th><th>Средний балл</th><th class="col-num">Грубые</th></tr></thead><tbody>' +
      '<tr class="cqa-st-sub"><td colspan="4">По языкам</td></tr>' + rows(s.by_language, LANG) +
      '<tr class="cqa-st-sub"><td colspan="4">По каналам</td></tr>' + rows(s.by_channel, CHAN) +
      '</tbody></table></div>';
    return panel('По языкам и каналам', '', html);
  }

  function grossList(s) {
    var inner = s.gross.length ? '<ul class="cqa-st-gross">' + s.gross.map(function (g) {
      return '<li><div class="cqa-st-gross-head"><a class="cqa-id" href="' + href(g.key) + '">' + esc(g.conversation_id) + '</a>' +
        '<span class="cqa-muted">' + esc(LANG[g.language] || g.language || '') + (g.turns.length ? ' · реплики ' + g.turns.join(', ') : '') + '</span>' + score(g.total) + '</div>' +
        '<p>' + esc(g.explanation || 'Объяснения нет.') + '</p></li>';
    }).join('') + '</ul>' : '<p class="cqa-muted">Грубых ошибок не найдено.</p>';
    return panel('Грубые ошибки · ' + s.gross.length, 'Диалоги, где ИИ нашёл оскорбление, услугу в обход компании или раскрытие конфиденциальных данных. Нажмите на номер, чтобы открыть карточку.', inner);
  }

  function worstTable(s) {
    if (!s.worst.length) return '';
    var html = '<div class="cqa-table-wrap"><table class="cqa-table cqa-st-table"><thead><tr><th>Диалог</th><th>Язык</th><th>Итог</th><th>Больше всего потеряно</th></tr></thead><tbody>' +
      s.worst.map(function (d) {
        return '<tr data-href="' + href(d.key) + '"><td><a class="cqa-id" href="' + href(d.key) + '">' + esc(d.conversation_id) + '</a>' + (d.gross ? ' <span class="cqa-st-red" title="Грубая ошибка">' + icon('i-alert') + '</span>' : '') + '</td>' +
          '<td>' + esc(LANG[d.language] || d.language || '') + '</td><td>' + score(d.total) + '</td>' +
          '<td>' + (d.worst ? esc(d.worst.name) + ' <span class="cqa-muted">−' + num(d.worst.lost) + '</span>' : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    return panel('Самые низкие оценки', 'Восемь диалогов с наименьшим итогом. Нажмите на строку, чтобы открыть карточку.', html, 'is-wide');
  }

  function render(s) {
    if (!s.evaluated) {
      body.innerHTML = '<div class="cqa-panel"><div class="cqa-empty"><span class="cqa-empty-icon">' + icon('i-chart') + '</span><b>Пока нечего считать</b>' +
        '<p class="cqa-muted">Оцените диалоги на странице «Диалоги» — статистика появится здесь.</p></div></div>';
      return;
    }
    body.innerHTML = tiles(s) + '<div class="cqa-st-grid">' + losses(s) + answers(s) + histogram(s) + groupsTable(s) + grossList(s) + worstTable(s) + '</div>';
  }

  function load() {
    var my = ++seq;
    var q = '?group_id=' + encodeURIComponent(setSel.value) + '&channel=' + encodeURIComponent(chanSel.value) + '&language=' + encodeURIComponent(langSel.value);
    CQA.api.get('/api/stats' + q).then(function (s) { if (my === seq) render(s); }, function (err) {
      if (my !== seq) return;
      body.innerHTML = '<div class="cqa-panel"><div class="cqa-empty is-error"><span class="cqa-empty-icon">' + icon('i-alert') + '</span><b>Не удалось посчитать</b><p class="cqa-muted">' + esc(err.message) + '</p></div></div>';
    });
  }

  function loadSets() {
    return CQA.api.get('/api/datasets').then(function (r) {
      var keep = setSel.value;
      var items = (r && r.items) || [];
      setSel.innerHTML = '<option value="">Все наборы</option>' + items.map(function (d) {
        return '<option value="' + esc(d.group_id) + '">' + esc(d.group_id) + ' — ' + d.total + ' диал.</option>';
      }).join('');
      if (keep && items.some(function (d) { return d.group_id === keep; })) setSel.value = keep;
      else if (!keep && items.length === 1) setSel.value = items[0].group_id;
    }, function () { /* без списка наборов — считаем по всем */ });
  }

  [setSel, chanSel, langSel].forEach(function (el) { el.addEventListener('change', load); });
  body.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-href]');
    if (tr && !e.target.closest('a')) location.hash = tr.dataset.href;
  });
  document.addEventListener('cqa:route', function (e) {
    active = e.detail.page === 'stats';
    if (active) loadSets().then(load);
  });
})();
