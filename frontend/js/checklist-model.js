/* CQA — модель чек-листа: проверки, веса, сравнение версий.
   Один и тот же файл работает в браузере (window.CQA.checklistModel) и на сервере (require),
   поэтому правила проверки никогда не расходятся.

   Чек-лист (одна версия):
   {
     name, instructions,                    // общие правила для ИИ
     sections: [{ key, name }],
     criteria: [{
       key, section, name,
       description,                          // что проверяет ИИ (обязательно)
       guidance,                             // пояснения и примеры для ИИ (необязательно)
       type: 'yes_no' | 'scale' | 'flag',
       weight,                               // баллы критерия; у flag всегда 0
       na_allowed, na_condition,             // можно ли N/A и когда
       scale: [{ points, text }]             // ступени шкалы (только для scale), по убыванию
     }]
   } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.CQA = root.CQA || {}; root.CQA.checklistModel = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TYPES = {
    yes_no: { label: 'Да / Нет', scored: true },
    scale: { label: 'Шкала баллов', scored: true },
    flag: { label: 'Флаг без баллов', scored: false }
  };
  var KEY_RE = /^[a-z][a-z0-9_-]{1,40}$/;
  var LIMITS = { name: 200, description: 3000, guidance: 5000, instructions: 8000, na_condition: 1000, step: 500, sections: 30, criteria: 60, steps: 11 };

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  /** Пустое поле — NaN (а не 0, как дал бы Number('')): так ошибка будет «введите число», а не «повтор». */
  function numOrNaN(v) { return str(v).trim() === '' ? NaN : Number(v); }
  /** Словарь без прототипа: ключи вроде __proto__ или toString не «находятся» сами собой. */
  function dict() { return Object.create(null); }

  function randomPart() {
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || (typeof self !== 'undefined' && self.crypto);
    if (c && c.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 8);
    return Math.random().toString(36).slice(2, 10);
  }

  /** Новый постоянный ключ: оценки ссылаются на него, поэтому при правке текста он не меняется. */
  function newKey(prefix) { return (prefix || 'c') + '_' + randomPart(); }

  function isScored(c) { return Boolean(TYPES[c.type] && TYPES[c.type].scored); }

  /** Максимум шкалы — верхняя ступень. Она и даёт полный вес критерия. */
  function scaleMax(c) {
    var pts = (c.scale || []).map(function (s) { return Number(s.points); }).filter(function (n) { return isFinite(n); });
    return pts.length ? Math.max.apply(null, pts) : 0;
  }

  /** Приводит черновик к чистому виду: обрезает пробелы, числа — целые, шкала по убыванию. */
  function normalize(cl, opts) {
    var keepOrder = Boolean(opts && opts.keepOrder);
    var src = obj(cl);
    var out = {
      name: str(src.name).trim(),
      instructions: str(src.instructions).trim(),
      sections: arr(src.sections).map(function (s) { s = obj(s); return { key: str(s.key).trim(), name: str(s.name).trim() }; }),
      criteria: arr(src.criteria).map(function (c) {
        c = obj(c);
        var type = TYPES[c.type] ? c.type : 'yes_no';
        var item = {
          key: str(c.key).trim(),
          section: str(c.section).trim(),
          name: str(c.name).trim(),
          description: str(c.description).trim(),
          guidance: str(c.guidance).trim(),
          type: type,
          weight: type === 'flag' ? 0 : numOrNaN(c.weight),
          na_allowed: type === 'flag' ? false : Boolean(c.na_allowed),
          na_condition: '',
          scale: []
        };
        if (item.na_allowed) item.na_condition = str(c.na_condition).trim();
        if (type === 'scale') {
          item.scale = arr(c.scale).map(function (st) { st = obj(st); return { points: numOrNaN(st.points), text: str(st.text).trim() }; });
          // По убыванию; некорректные (NaN) — в конец. Для проверки порядок не трогаем, чтобы ошибка была у той же строки.
          if (!keepOrder) item.scale.sort(function (a, b) { return (isFinite(b.points) ? b.points : -Infinity) - (isFinite(a.points) ? a.points : -Infinity); });
        }
        return item;
      })
    };
    return out;
  }

  function err(list, path, message, key) { list.push({ path: path, message: message, key: key || null }); }

  /**
   * Проверка чек-листа. Возвращает { errors, warnings }.
   * errors — сохранить нельзя; warnings — можно, но стоит знать.
   * path — «где»: 'name', 'sections.<key>.name', 'criteria.<key>.weight', 'criteria.<key>.scale.<i>.text' …
   */
  function validate(input) {
    var errors = [];
    var warnings = [];
    var raw = obj(input);
    // Сначала дешёвые проверки размеров — до любой тяжёлой работы.
    if (arr(raw.sections).length > LIMITS.sections) err(errors, 'sections', 'Слишком много разделов (до ' + LIMITS.sections + ').');
    if (arr(raw.criteria).length > LIMITS.criteria) err(errors, 'criteria', 'Слишком много критериев (до ' + LIMITS.criteria + ').');
    if (arr(raw.criteria).some(function (c) { return arr(obj(c).scale).length > LIMITS.steps; })) err(errors, 'criteria', 'Слишком много ступеней шкалы (до ' + LIMITS.steps + ').');
    if (errors.length) return { errors: errors, warnings: warnings, normalized: normalize({}) };

    var cl = normalize(input, { keepOrder: true });  // индексы ступеней — как в редакторе

    if (!cl.name) err(errors, 'name', 'Укажите название чек-листа.');
    else if (cl.name.length > LIMITS.name) err(errors, 'name', 'Название слишком длинное (до ' + LIMITS.name + ' символов).');
    if (cl.instructions.length > LIMITS.instructions) err(errors, 'instructions', 'Общие правила слишком длинные (до ' + LIMITS.instructions + ' символов).');

    if (!cl.sections.length) err(errors, 'sections', 'Добавьте хотя бы один раздел.');
    var sectionKeys = dict();
    cl.sections.forEach(function (s) {
      if (!KEY_RE.test(s.key)) err(errors, 'sections.' + s.key + '.key', 'Служебный ключ раздела повреждён.', s.key);
      else if (sectionKeys[s.key]) err(errors, 'sections.' + s.key + '.key', 'Ключ раздела повторяется.', s.key);
      sectionKeys[s.key] = true;
      if (!s.name) err(errors, 'sections.' + s.key + '.name', 'Укажите название раздела.', s.key);
      else if (s.name.length > LIMITS.name) err(errors, 'sections.' + s.key + '.name', 'Название раздела слишком длинное.', s.key);
    });

    var critKeys = dict();
    var scoredCount = 0;
    cl.criteria.forEach(function (c) {
      var p = 'criteria.' + c.key + '.';
      if (!KEY_RE.test(c.key)) err(errors, p + 'key', 'Служебный ключ критерия повреждён.', c.key);
      else if (critKeys[c.key]) err(errors, p + 'key', 'Ключ критерия повторяется.', c.key);
      critKeys[c.key] = true;

      if (!sectionKeys[c.section]) err(errors, p + 'section', 'Выберите раздел.', c.key);
      if (!c.name) err(errors, p + 'name', 'Укажите название критерия.', c.key);
      else if (c.name.length > LIMITS.name) err(errors, p + 'name', 'Название слишком длинное (до ' + LIMITS.name + ' символов).', c.key);

      if (!c.description) err(errors, p + 'description', 'Опишите, что проверяет ИИ: без этого он не поймёт, как оценивать.', c.key);
      else if (c.description.length < 15) err(errors, p + 'description', 'Опишите подробнее (хотя бы одно предложение), как новому сотруднику.', c.key);
      else if (c.description.length > LIMITS.description) err(errors, p + 'description', 'Описание слишком длинное.', c.key);
      if (c.guidance.length > LIMITS.guidance) err(errors, p + 'guidance', 'Пояснения слишком длинные.', c.key);

      if (isScored(c)) {
        scoredCount++;
        if (!isFinite(c.weight) || Math.round(c.weight) !== c.weight || c.weight < 1 || c.weight > 100) {
          err(errors, p + 'weight', 'Вес — целое число от 1 до 100.', c.key);
        }
      }

      if (c.na_allowed && !c.na_condition) err(errors, p + 'na_condition', 'Опишите, когда критерий не применим (N/A).', c.key);
      else if (c.na_condition.length > LIMITS.na_condition) err(errors, p + 'na_condition', 'Условие N/A слишком длинное.', c.key);

      if (c.type === 'scale') {
        if (c.scale.length < 2) err(errors, p + 'scale', 'У шкалы должно быть минимум 2 ступени.', c.key);
        if (c.scale.length > LIMITS.steps) err(errors, p + 'scale', 'Слишком много ступеней (до ' + LIMITS.steps + ').', c.key);
        var seen = dict();
        c.scale.forEach(function (s, i) {
          var sp = p + 'scale.' + i + '.';
          if (!isFinite(s.points) || Math.round(s.points) !== s.points || s.points < 0 || s.points > 1000) {
            err(errors, sp + 'points', 'Баллы ступени — целое число от 0.', c.key);
          } else if (seen[s.points]) {
            err(errors, sp + 'points', 'Такая ступень уже есть.', c.key);
          }
          seen[s.points] = true;
          if (!s.text) err(errors, sp + 'text', 'Опишите, когда ставится эта ступень.', c.key);
          else if (s.text.length > LIMITS.step) err(errors, sp + 'text', 'Описание ступени слишком длинное.', c.key);
        });
        if (c.scale.length >= 2 && scaleMax(c) <= 0) err(errors, p + 'scale', 'Верхняя ступень должна быть больше нуля.', c.key);
        if (c.scale.length >= 2 && !c.scale.some(function (s) { return s.points === 0; })) {
          warnings.push({ path: p + 'scale', message: 'В шкале нет ступени 0 — ИИ не сможет поставить «совсем плохо».', key: c.key });
        }
      }
    });

    if (!scoredCount) err(errors, 'criteria', 'Нужен хотя бы один критерий с баллами (Да / Нет или шкала).');

    var sum = weightSummary(cl);
    var sorted = normalize(input);
    if (scoredCount && sum.total !== 100) {
      warnings.push({ path: 'weights', message: 'Сумма весов ' + sum.total + ', а не 100. Итог всё равно считается из 100 — пропорционально весам.' });
    }
    cl.sections.forEach(function (s) {
      if (!cl.criteria.some(function (c) { return c.section === s.key; })) {
        warnings.push({ path: 'sections.' + s.key, message: 'В разделе «' + (s.name || 'без названия') + '» нет критериев.', key: s.key });
      }
    });

    return { errors: errors, warnings: warnings, normalized: sorted };
  }

  /** Веса по разделам и общий итог (только критерии с баллами). */
  function weightSummary(input) {
    var cl = input && input.criteria && input.sections ? input : normalize(input);
    var bySection = cl.sections.map(function (s) {
      var w = cl.criteria.filter(function (c) { return c.section === s.key && isScored(c); })
        .reduce(function (acc, c) { return acc + (isFinite(Number(c.weight)) ? Number(c.weight) : 0); }, 0);
      return { key: s.key, name: s.name, weight: w };
    });
    var total = bySection.reduce(function (a, s) { return a + s.weight; }, 0);
    return { total: total, bySection: bySection };
  }

  function typeLabel(c) {
    if (c.type === 'scale') return 'Шкала 0–' + scaleMax(c);
    return (TYPES[c.type] || TYPES.yes_no).label;
  }

  /**
   * Что изменилось между версиями — понятными фразами.
   * Нумерация критериев — по порядку в новой версии (как их видит пользователь).
   */
  function diff(prevInput, nextInput) {
    var a = normalize(prevInput), b = normalize(nextInput);
    var out = [];
    if (a.name !== b.name) out.push('Название: «' + a.name + '» → «' + b.name + '»');
    if (a.instructions !== b.instructions) out.push('Изменены общие правила для ИИ');

    var aSec = dict(); a.sections.forEach(function (s) { aSec[s.key] = s; });
    var bSec = dict(); b.sections.forEach(function (s) { bSec[s.key] = s; });
    b.sections.forEach(function (s) {
      if (!aSec[s.key]) out.push('Добавлен раздел «' + s.name + '»');
      else if (aSec[s.key].name !== s.name) out.push('Раздел «' + aSec[s.key].name + '» переименован в «' + s.name + '»');
    });
    a.sections.forEach(function (s) { if (!bSec[s.key]) out.push('Удалён раздел «' + s.name + '»'); });

    var aCrit = dict(); a.criteria.forEach(function (c) { aCrit[c.key] = c; });
    var bCrit = dict(); b.criteria.forEach(function (c) { bCrit[c.key] = c; });
    var num = function (key) {
      var i = b.criteria.map(function (c) { return c.key; }).indexOf(key);
      return i >= 0 ? (i < 9 ? '0' : '') + (i + 1) : '—';
    };
    b.criteria.forEach(function (c) {
      var o = aCrit[c.key];
      if (!o) { out.push('Добавлен критерий ' + num(c.key) + ' «' + c.name + '»'); return; }
      var parts = [];
      if (o.name !== c.name) parts.push('название');
      if (o.description !== c.description) parts.push('описание для ИИ');
      if (o.guidance !== c.guidance) parts.push('пояснения');
      if (o.type !== c.type) parts.push('тип: ' + typeLabel(o) + ' → ' + typeLabel(c));
      if (o.weight !== c.weight && isScored(c)) parts.push('вес ' + o.weight + ' → ' + c.weight);
      if (o.na_allowed !== c.na_allowed) parts.push(c.na_allowed ? 'разрешён N/A' : 'N/A запрещён');
      else if (o.na_condition !== c.na_condition) parts.push('условие N/A');
      if (JSON.stringify(o.scale) !== JSON.stringify(c.scale) && c.type === 'scale' && o.type === 'scale') parts.push('ступени шкалы');
      if (o.section !== c.section) parts.push('перенесён в раздел «' + ((bSec[c.section] || {}).name || '') + '»');
      if (parts.length) out.push('Критерий ' + num(c.key) + ' «' + c.name + '»: ' + parts.join(', '));
    });
    a.criteria.forEach(function (c) { if (!bCrit[c.key]) out.push('Удалён критерий «' + c.name + '»'); });

    var secOrderA = a.sections.map(function (s) { return s.key; }).filter(function (k) { return bSec[k]; });
    var secOrderB = b.sections.map(function (s) { return s.key; }).filter(function (k) { return aSec[k]; });
    if (secOrderA.join() !== secOrderB.join()) out.push('Изменён порядок разделов');
    var orderA = a.criteria.map(function (c) { return c.key; }).filter(function (k) { return bCrit[k]; });
    var orderB = b.criteria.map(function (c) { return c.key; }).filter(function (k) { return aCrit[k]; });
    if (orderA.join() !== orderB.join()) out.push('Изменён порядок критериев');
    return out;
  }

  /** Одинаковы ли две версии по содержанию (после приведения к чистому виду). */
  function sameContent(a, b) { return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)); }

  /** Пустой критерий для «Добавить» и «Заменить». */
  function blankCriterion(sectionKey, opts) {
    var o = opts || {};
    return {
      key: newKey('c'),
      section: sectionKey,
      name: '',
      description: '',
      guidance: '',
      type: o.type || 'yes_no',
      weight: o.weight === undefined ? 10 : o.weight,
      na_allowed: false,
      na_condition: '',
      scale: o.type === 'scale' ? [{ points: 10, text: '' }, { points: 5, text: '' }, { points: 0, text: '' }] : []
    };
  }

  return {
    TYPES: TYPES,
    KEY_RE: KEY_RE,
    newKey: newKey,
    isScored: isScored,
    scaleMax: scaleMax,
    normalize: normalize,
    validate: validate,
    weightSummary: weightSummary,
    typeLabel: typeLabel,
    diff: diff,
    sameContent: sameContent,
    blankCriterion: blankCriterion
  };
}));
