/* CQA — общая оболочка: переходы между страницами, окна, уведомления, запросы к серверу.
   Страницы подключаются отдельными файлами (dialogs.js и т. д.) и пользуются window.CQA. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var CQA = window.CQA = window.CQA || {};
  CQA.$ = $;
  CQA.$$ = $$;

  /* ---------- Экранирование текста из данных (данные чужие — только так) ---------- */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  CQA.esc = function (v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); };

  /* ---------- Запросы к серверу ---------- */
  var apiBase = ((window.CQA_CONFIG && window.CQA_CONFIG.apiBase) || '').replace(/\/$/, '');
  function request(method, path, body) {
    var opts = { method: method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(apiBase + path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* не JSON */ }
        if (!res.ok) {
          var err = new Error((data && data.error) || ('Сервер ответил ошибкой ' + res.status + '.'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }, function () {
      throw new Error('Сервер CQA не отвечает. Запустите его командой npm start и обновите страницу.');
    });
  }
  CQA.api = {
    get: function (path) { return request('GET', path); },
    post: function (path, body) { return request('POST', path, body || {}); },
    put: function (path, body) { return request('PUT', path, body || {}); },
    del: function (path) { return request('DELETE', path); }
  };

  /* Подключён ли ИИ (шаг 5): без ключа на сервере доступна только подставная оценка. */
  CQA.ai = { available: false };
  CQA.aiReady = request('GET', '/api/ai').then(function (info) { CQA.ai = info || CQA.ai; return CQA.ai; }, function () { return CQA.ai; });
  CQA.shortModel = function (m) { return String(m || '').replace(/^[^/]+\//, ''); };

  /* «Учитывать апелляции»: решения проверяющего по прошлым апелляциям уходят в запрос к ИИ как примеры.
     Одна настройка на всё приложение, по умолчанию выключена (не запоминается между запусками). */
  CQA.useAppeals = false;
  CQA.appealsToggleHtml = function () {
    return '<label class="cqa-check cqa-use-appeals" title="ИИ получит решения проверяющего по прошлым апелляциям на те же критерии (из других диалогов, до 3 на критерий) как примеры, как применять чек-лист в компании. По умолчанию выключено.">' +
      '<input type="checkbox" data-use-appeals' + (CQA.useAppeals ? ' checked' : '') + '> Учитывать апелляции</label>';
  };
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.matches || !el.matches('[data-use-appeals]')) return;
    CQA.useAppeals = el.checked;
    Array.prototype.forEach.call(document.querySelectorAll('[data-use-appeals]'), function (x) { x.checked = CQA.useAppeals; });
  });
  /* Цена в долларах: мелкие суммы с нужным числом знаков, чтобы не показывать «$0». */
  CQA.money = function (x) {
    x = Number(x) || 0;
    if (x > 0 && x < 0.0001) return '<$0,0001';
    return '$' + x.toFixed(x >= 0.01 ? 3 : 4).replace('.', ',');
  };

  /* ---------- Защита от ухода со страницы с несохранёнными правками ----------
     Страница регистрирует guard(fromPage, toHash): вернуть false — уход отменён
     (страница сама покажет своё окно и потом вызовет CQA.navigate(toHash, true)). */
  var guards = [];
  var currentHash = location.hash || '#dialogs';
  var suppressNext = false;
  var forceNext = false;
  CQA.addLeaveGuard = function (fn) { guards.push(fn); };
  CQA.navigate = function (hash, force) {
    if (force) forceNext = true;
    if (location.hash === hash) { forceNext = false; route(); } else location.hash = hash;
  };
  function pageOf(hash) { return (String(hash || '#dialogs').slice(1).split('/')[0]) || 'dialogs'; }

  /* ---------- Переходы между страницами ----------
     #dialogs, #dialog/<ключ>, #checklists, #appeals */
  function route() {
    var hash = (location.hash || '#dialogs').slice(1);
    var parts = hash.split('/');
    var page = parts[0] || 'dialogs';
    // Сравниваем со списком страниц, а не подставляем в селектор: адрес может быть любым.
    if (!$$('.cqa-page').some(function (p) { return p.dataset.page === page; })) page = 'dialogs';

    $$('.cqa-page').forEach(function (p) { p.classList.toggle('is-active', p.dataset.page === page); });

    var navKey = page === 'dialog' ? 'dialogs' : page;
    $$('[data-nav]').forEach(function (a) {
      if (a.dataset.nav === navKey) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    window.scrollTo(0, 0);
    currentHash = location.hash || '#dialogs';
    document.dispatchEvent(new CustomEvent('cqa:route', { detail: { page: page, parts: parts } }));
  }
  window.addEventListener('hashchange', function () {
    if (suppressNext) { suppressNext = false; return; }  // это мы сами вернули адрес назад
    var to = location.hash || '#dialogs';
    if (!forceNext && pageOf(currentHash) !== pageOf(to)) {
      for (var i = 0; i < guards.length; i++) {
        if (guards[i](pageOf(currentHash), to) === false) {
          suppressNext = true;
          location.hash = currentHash;  // остаёмся; страница покажет вопрос
          return;
        }
      }
    }
    forceNext = false;
    route();
  });
  // Первый переход — после подключения всех файлов страниц.
  document.addEventListener('DOMContentLoaded', route);

  /* ---------- Модальные окна ---------- */
  var lastFocus = null;
  CQA.openModal = function (id) {
    var m = document.getElementById(id);
    if (!m) return;
    lastFocus = document.activeElement;
    m.classList.add('is-open');
    m.dispatchEvent(new CustomEvent('cqa:modal-open'));
    var f = m.querySelector('[autofocus], select, textarea, input:not([type=file]):not([type=hidden]), button');
    if (f) f.focus();
  };
  CQA.closeModal = function (m) {
    if (typeof m === 'string') m = document.getElementById(m);
    if (!m || !m.classList.contains('is-open')) return;
    m.classList.remove('is-open');
    // Страницы узнают о закрытии любым способом (кнопка, Esc, клик мимо окна).
    m.dispatchEvent(new CustomEvent('cqa:modal-close'));
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  };
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-open]');
    if (opener) { e.preventDefault(); CQA.openModal(opener.dataset.open); return; }
    var closer = e.target.closest('[data-close]');
    if (closer) { CQA.closeModal(closer.closest('.cqa-modal')); }
    if (e.target.classList && e.target.classList.contains('cqa-modal')) CQA.closeModal(e.target);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $$('.cqa-modal.is-open').forEach(CQA.closeModal);
  });

  /* ---------- Всплывающее уведомление ---------- */
  var toastTimer;
  /* action — необязательная кнопка { label, run }: такое уведомление висит дольше. */
  CQA.toast = function (text, action) {
    var el = $('[data-toast-el]');
    $('[data-toast-text]').textContent = text;
    var old = el.querySelector('.cqa-toast-action');
    if (old) old.remove();
    if (action && action.label) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cqa-toast-action';
      b.textContent = action.label;
      b.addEventListener('click', function () { hideToast(); action.run(); });
      el.appendChild(b);
    }
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 8000 : 3200);
  };
  // Скрытое уведомление не должно ловить клики: кнопку убираем вместе с ним.
  function hideToast() {
    var el = $('[data-toast-el]');
    el.classList.remove('is-show');
    var b = el.querySelector('.cqa-toast-action');
    if (b) b.remove();
  }

  /* ---------- Ответы критериев: подпись и допустимые варианты (для апелляций) ---------- */
  function scaleTop(c) { return Math.max.apply(null, (c.scale || []).map(function (s) { return Number(s.points); })); }
  CQA.answerText = function (c, v) {
    if (v === null || v === undefined) return '—';
    if (c.type === 'flag') return v === 'yes' ? 'Да — нарушение' : 'Нет';
    if (v === 'yes') return 'Да';
    if (v === 'no') return 'Нет';
    if (v === 'na') return 'N/A';
    if (typeof v === 'number') return v + ' из ' + scaleTop(c);
    return String(v);
  };
  CQA.answerOptions = function (c) {
    if (c.type === 'flag') return ['yes', 'no'];
    var base = c.type === 'scale'
      ? (c.scale || []).map(function (s) { return Number(s.points); }).sort(function (a, b) { return b - a; })
      : ['yes', 'no'];
    return c.na_allowed ? base.concat(['na']) : base;
  };
  CQA.sameAnswer = function (a, b) { return a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9); };

  /* Счётчик апелляций, ждущих решения, в меню. */
  CQA.refreshAppealCount = function () {
    var el = $('#nav-appeals-count');
    if (!el) return;
    request('GET', '/api/appeals?status=open').then(function (r) {
      var n = (r && r.counts && r.counts.open) || 0;
      el.textContent = n;
      el.hidden = n === 0;
    }, function () { el.hidden = true; });
  };
  document.addEventListener('cqa:appeals-changed', CQA.refreshAppealCount);
  document.addEventListener('cqa:evaluations-changed', CQA.refreshAppealCount);   // новая оценка закрывает открытые апелляции
  document.addEventListener('DOMContentLoaded', CQA.refreshAppealCount);
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-toast]');
    if (t) CQA.toast(t.dataset.toast);
  });

  /* ---------- Подсказка из трёх шагов ---------- */
  var steps = $('[data-steps]');
  var closeSteps = $('[data-close-steps]');
  if (steps && closeSteps) closeSteps.addEventListener('click', function () { steps.style.display = 'none'; });

  /* ---------- Роль: аналитик / проверяющий ---------- */
  var roleNotes = {
    analyst: 'Аналитик оценивает диалоги и подаёт апелляции.',
    reviewer: 'Проверяющий рассматривает апелляции и выносит решение.'
  };
  // Входа нет: роль — переключатель интерфейса (запоминается в браузере). Сервер всё равно
  // проверяет, что апелляцию подаёт аналитик, а решает проверяющий.
  CQA.role = 'analyst';
  try { if (localStorage.getItem('cqa-role') === 'reviewer') CQA.role = 'reviewer'; } catch (_) { /* приватный режим */ }
  function applyRole() {
    $$('[data-role]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.role === CQA.role)); });
    var note = $('[data-role-note]');
    if (note) note.textContent = roleNotes[CQA.role];
    document.body.dataset.role = CQA.role;
  }
  CQA.setRole = function (role) {
    CQA.role = role === 'reviewer' ? 'reviewer' : 'analyst';
    try { localStorage.setItem('cqa-role', CQA.role); } catch (_) { /* не страшно */ }
    applyRole();
    document.dispatchEvent(new CustomEvent('cqa:role', { detail: { role: CQA.role } }));
  };
  $$('[data-role]').forEach(function (b) {
    b.addEventListener('click', function () { CQA.setRole(b.dataset.role); });
  });
  applyRole();

  /* ---------- Карточка: «Показать в переписке» — прокрутка и подсветка реплики ---------- */
  function flash(el) {
    el.classList.remove('is-flash');
    void el.offsetWidth;
    el.classList.add('is-flash');
  }
  document.addEventListener('click', function (e) {
    var j = e.target.closest('[data-jump]');
    if (j) {
      var target = document.getElementById(j.dataset.jump);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(target);
      }
      return;
    }
    var tag = e.target.closest('[data-crit]');
    if (tag) {
      var crit = document.getElementById(tag.dataset.crit);
      if (crit) {
        crit.open = true;
        crit.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  });

  /* ---------- Вкладки источника в окне загрузки ---------- */
  $$('[data-src]').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('[data-src]').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      $$('[data-pane]').forEach(function (p) { p.classList.toggle('is-active', p.dataset.pane === b.dataset.src); });
      document.dispatchEvent(new CustomEvent('cqa:upload-source', { detail: { source: b.dataset.src } }));
    });
  });

  /* ---------- Выбранный элемент в списках (макеты чек-листов и апелляций) ---------- */
  function selectable(selector, attr) {
    $$(selector).forEach(function (b) {
      b.addEventListener('click', function () {
        $$(selector).forEach(function (x) { x.setAttribute(attr, String(x === b)); });
      });
    });
  }
  selectable('.cqa-tab', 'aria-selected');
  selectable('.cqa-ap-item', 'aria-current');
  selectable('.cqa-cl-item', 'aria-current');

  /* ---------- Звуковые дорожки в макете карточки (декоративные) ---------- */
  $$('[data-wave]').forEach(function (w) {
    var seed = Number(w.dataset.seed) || 1;
    var html = '';
    for (var i = 0; i < 140; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      var r = seed / 233280;
      var envelope = 0.35 + 0.65 * Math.abs(Math.sin(i / 9 + (w.dataset.wave === 'client' ? 0 : 1.7)));
      var h = Math.max(8, Math.round(100 * r * envelope));
      html += '<i style="height:' + h + '%"></i>';
    }
    w.innerHTML = html;
  });
})();
