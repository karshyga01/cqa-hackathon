/* Окно «Выгрузить результаты»: results/dev/results.json и results/prod/results.json
   в формате организаторов (приложение к гайду, JSON 1.0). Файл собирает и проверяет сервер. */
(function () {
  'use strict';
  var CQA = window.CQA;
  var modal = document.getElementById('modal-export');
  if (!CQA || !modal) return;

  var form = document.getElementById('mx-form');
  var setSel = document.getElementById('mx-set');
  var targetSel = document.getElementById('mx-target');
  var teamInput = document.getElementById('mx-team');
  var status = document.getElementById('mx-status');
  var saveBtn = document.getElementById('mx-save');
  var downloadBtn = document.getElementById('mx-download');
  var esc = CQA.esc;
  var TEAM_KEY = 'cqa.teamName';
  var busy = false;

  function remember(v) { try { localStorage.setItem(TEAM_KEY, v); } catch (_) { /* хранилище недоступно */ } }
  function recall() { try { return localStorage.getItem(TEAM_KEY) || ''; } catch (_) { return ''; } }

  function show(kind, html) {
    status.className = 'cqa-up-status' + (kind ? ' is-' + kind : '');
    status.innerHTML = html;
    status.hidden = !html;
  }

  function list(items) {
    return items && items.length ? '<ul>' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '';
  }

  function icon(name) { return '<svg class="i"><use href="#' + name + '"/></svg>'; }

  function setBusy(on, label) {
    busy = on;
    saveBtn.disabled = on;
    downloadBtn.disabled = on;
    if (on) show('', '<span class="cqa-spin" aria-hidden="true"></span><div><p>' + esc(label) + '</p></div>');
  }

  function params() {
    return { group_id: setSel.value, target: targetSel.value, team_name: teamInput.value.trim() };
  }

  /** Набор DEV → папка dev, остальные → prod (можно поменять вручную). */
  function syncTarget() { targetSel.value = setSel.value === 'DEV' ? 'dev' : 'prod'; }

  function fill() {
    if (!teamInput.value) teamInput.value = recall();
    show('', '');
    CQA.api.get('/api/datasets').then(function (r) {
      var items = (r && r.items) || [];
      var keep = setSel.value;
      setSel.innerHTML = items.length
        ? items.map(function (d) { return '<option value="' + esc(d.group_id) + '">' + esc(d.group_id) + ' — ' + d.total + ' диал.</option>'; }).join('')
        : '<option value="">Наборов нет — сначала загрузите диалоги</option>';
      if (keep && items.some(function (d) { return d.group_id === keep; })) setSel.value = keep;
      else if (items.length) setSel.value = items[items.length - 1].group_id;   // последний загруженный
      syncTarget();
      saveBtn.disabled = !items.length;
      downloadBtn.disabled = !items.length;
    }, function (err) { show('error', icon('i-alert') + '<div><p>' + esc(err.message) + '</p></div>'); });
  }

  function report(r, saved) {
    var problems = r.problems || [];
    var warnings = r.warnings || [];
    var head = saved
      ? '<p><b>Записано: ' + esc(r.file) + '</b> — ' + r.total + ' записей' + (r.errors ? ', из них с ошибкой: ' + r.errors : '') + '. Модель: ' + esc(r.model && r.model.name) + '.</p>' +
        '<p>Дальше: закоммитьте и запушьте файл в репозиторий.</p>'
      : '';
    if (problems.length) {
      show('error', icon('i-alert') + '<div>' + head + '<p><b>Формат не прошёл проверку:</b></p>' + list(problems) + (warnings.length ? '<p><b>Предупреждения:</b></p>' + list(warnings) : '') + '</div>');
    } else if (warnings.length) {
      show('warn', icon('i-alert') + '<div>' + head + '<p>Формат в порядке. <b>Обратите внимание:</b></p>' + list(warnings) + '</div>');
    } else {
      show('ok', icon('i-check') + '<div>' + head + '<p>Формат в порядке, замечаний нет.</p></div>');
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy || !setSel.value) return;
    var p = params();
    remember(p.team_name);
    setBusy(true, 'Собираю и проверяю файл…');
    CQA.api.post('/api/results/export', p).then(function (r) {
      setBusy(false);
      report(r, true);
      CQA.toast('Файл ' + r.file + ' записан');
    }, function (err) {
      setBusy(false);
      show('error', icon('i-alert') + '<div><p>' + esc(err.message) + '</p></div>');
    });
  });

  downloadBtn.addEventListener('click', function () {
    if (busy || !setSel.value) return;
    var p = params();
    remember(p.team_name);
    setBusy(true, 'Собираю файл…');
    var q = '?group_id=' + encodeURIComponent(p.group_id) + '&target=' + encodeURIComponent(p.target) + '&team_name=' + encodeURIComponent(p.team_name);
    CQA.api.get('/api/results' + q).then(function (r) {
      setBusy(false);
      var blob = new Blob([JSON.stringify(r.document, null, 2) + '\n'], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'results-' + r.target + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
      report(r, false);
    }, function (err) {
      setBusy(false);
      show('error', icon('i-alert') + '<div><p>' + esc(err.message) + '</p></div>');
    });
  });

  setSel.addEventListener('change', syncTarget);
  modal.addEventListener('cqa:modal-open', fill);
})();
