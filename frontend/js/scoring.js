/* CQA — подсчёт баллов по чек-листу (правила из PDF организаторов, стр. 2).
   Один файл для браузера (window.CQA.scoring) и сервера (require): считаем везде одинаково.

   ИИ только выбирает ответ по каждому критерию, баллы считает этот код:
   1) «Да» — полный вес, «Нет» — 0; шкала — вес × (ступень ÷ верхняя ступень);
   2) N/A исключает критерий, его вес пропорционально делится между применимыми:
      итог = 100 × Σ набранного ÷ Σ весов применимых критериев (максимум всегда 100);
   3) итог округляется до двух знаков; если применимых критериев с весом нет — итог не рассчитывается;
   4) флаг (грубые ошибки) в баллы не входит — отмечается отдельно и итог не меняет.

   Формат ответов: { [ключ критерия]: 'yes' | 'no' | 'na' | число-ступень }.
   Принимаются и русские варианты: «Да», «Нет», «N/A», «Н/П», «15», «15 из 20». */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.CQA = root.CQA || {}; root.CQA.scoring = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Округление до двух знаков «половина вверх» без ловушки двоичной арифметики:
   * 100 × 1,15 ÷ 8 = 14,375 ровно, но JavaScript получает 14,374999999999998,
   * и обычный Math.round дал бы 14,37. Погрешность вычислений — в 15–16-м знаке,
   * поэтому сначала оставляем 12 значащих цифр (убираем «шум»), затем округляем.
   * Настоящие значения чуть меньше половины (…,4999999) при этом не превращаются в половину.
   */
  function round2(x) {
    if (typeof x !== 'number' || !isFinite(x)) return x;
    var sign = x < 0 ? -1 : 1;
    var cents = Number((Math.abs(x) * 100).toPrecision(12));
    var r = sign * Math.round(cents) / 100;
    return r === 0 ? 0 : r; // без «-0»
  }

  /** 88.24 → «88,24»; целые — без дробной части: 20 → «20». */
  function formatPoints(x) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    var r = round2(x);
    var s = Math.abs(r - Math.round(r)) < 1e-9 ? String(Math.round(r)) : r.toFixed(2).replace(/0$/, '');
    return s.replace('.', ',');
  }

  function scaleSteps(c) {
    return (Array.isArray(c.scale) ? c.scale : []).map(function (s) { return Number(s.points); }).filter(function (n) { return isFinite(n); });
  }
  function scaleMax(c) { var p = scaleSteps(c); return p.length ? Math.max.apply(null, p) : 0; }

  /**
   * Приводит ответ к виду { kind: 'yes'|'no'|'na'|'step', step? } или { error }.
   */
  function parseAnswer(c, raw) {
    if (raw === undefined || raw === null || raw === '') return { error: 'нет ответа' };
    var s = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    if (s && typeof s === 'object' && 'value' in s) return parseAnswer(c, s.value);

    var isNa = s === 'na' || s === 'n/a' || s === 'н/п' || s === 'неприменимо' || s === 'не применимо';
    var isYes = s === 'yes' || s === 'да' || s === true;
    var isNo = s === 'no' || s === 'нет' || s === false;

    if (isNa) {
      if (c.type === 'flag') return { error: 'для флага N/A не бывает — нужен «Да» или «Нет»' };
      if (!c.na_allowed) return { error: 'N/A для этого критерия не разрешён' };
      return { kind: 'na' };
    }

    if (c.type === 'scale') {
      var n = typeof s === 'number' ? s : NaN;
      if (typeof s === 'string') {
        var m = /^(-?\d+(?:[.,]\d+)?)(?:\s*(?:из|\/|of)\s*(\d+(?:[.,]\d+)?))?$/.exec(s);
        if (m) {
          n = Number(m[1].replace(',', '.'));
          // «5 из 10» для шкалы 0–20 — это ответ по другой шкале: не пересчитываем, а сообщаем об ошибке.
          if (m[2] !== undefined && Number(m[2].replace(',', '.')) !== scaleMax(c)) {
            return { error: 'шкала критерия 0–' + scaleMax(c) + ', а в ответе «из ' + m[2] + '»' };
          }
        }
      }
      if (isFinite(n)) {
        if (scaleSteps(c).indexOf(n) === -1) return { error: 'ступени ' + n + ' нет в шкале (' + scaleSteps(c).slice().sort(function (a, b) { return b - a; }).join(', ') + ')' };
        return { kind: 'step', step: n };
      }
      return { error: 'для шкалы нужна ступень (' + scaleSteps(c).slice().sort(function (a, b) { return b - a; }).join(', ') + ')' + (c.na_allowed ? ' или N/A' : '') };
    }

    if (isYes) return { kind: 'yes' };
    if (isNo) return { kind: 'no' };
    return { error: 'ответ «' + String(raw) + '» не понят — нужен «Да», «Нет»' + (c.na_allowed ? ' или N/A' : '') };
  }

  /** Подпись ответа для людей: «Да», «Нет», «N/A», «15 из 20». */
  function describeAnswer(c, raw) {
    var a = parseAnswer(c, raw);
    if (a.error) return '—';
    if (a.kind === 'na') return 'N/A';
    if (a.kind === 'yes') return 'Да';
    if (a.kind === 'no') return 'Нет';
    return a.step + ' из ' + scaleMax(c);
  }

  /**
   * Считает итог.
   * @param checklist версия чек-листа: { sections, criteria }
   * @param answers   { [key]: ответ }
   * @returns {{
   *   computable, total, total_exact, max: 100, applicable_weight,
   *   criteria: Array<{key,name,section,type,weight,answer,label,applicable,scored,earned,points,max_points,points_rounded,max_points_rounded}>,
   *   sections: Array<{key,name,points,max,points_rounded,max_rounded,scored,na_count}>,
   *   gross: { flagged, criteria: Array<{key,name,answer}> },
   *   errors: Array<{key,name,message}>, warnings: string[], reason
   * }}
   */
  function score(checklist, answers) {
    var cl = checklist || {};
    var criteria = Array.isArray(cl.criteria) ? cl.criteria : [];
    var sections = Array.isArray(cl.sections) ? cl.sections : [];
    var ans = answers && typeof answers === 'object' ? answers : {};
    var errors = [];
    var warnings = [];

    var known = Object.create(null);
    criteria.forEach(function (c) { known[c.key] = true; });
    Object.keys(ans).forEach(function (k) { if (!known[k]) warnings.push('Ответ для неизвестного критерия «' + k + '» пропущен'); });

    // 1–2. Ответы и «сырые» баллы в единицах веса.
    var rows = criteria.map(function (c) {
      var weight = c.type === 'flag' ? 0 : Number(c.weight);
      var parsed = parseAnswer(c, Object.prototype.hasOwnProperty.call(ans, c.key) ? ans[c.key] : undefined);
      var row = {
        key: c.key, name: c.name, section: c.section, type: c.type,
        weight: isFinite(weight) ? weight : 0,
        answer: parsed.error ? null : (parsed.kind === 'step' ? parsed.step : parsed.kind),
        label: parsed.error ? '—' : describeAnswer(c, ans[c.key]),
        scored: c.type !== 'flag',
        applicable: false,
        earned: 0, points: null, max_points: null, points_rounded: null, max_points_rounded: null,
      };
      if (parsed.error) {
        errors.push({ key: c.key, name: c.name, message: parsed.error });
        return row;
      }
      if (c.type === 'flag') return row;
      if (!(row.weight > 0)) { errors.push({ key: c.key, name: c.name, message: 'у критерия нет веса' }); return row; }
      if (parsed.kind === 'na') return row;
      row.applicable = true;
      if (parsed.kind === 'yes') row.earned = row.weight;
      else if (parsed.kind === 'no') row.earned = 0;
      else {
        var top = scaleMax(c);
        if (!(top > 0)) { errors.push({ key: c.key, name: c.name, message: 'у шкалы нет верхней ступени больше нуля' }); row.applicable = false; return row; }
        row.earned = row.weight * parsed.step / top;
      }
      return row;
    });

    // Грубые ошибки — отдельно.
    var flags = rows.filter(function (r) { return r.type === 'flag'; });
    var gross = {
      flagged: flags.some(function (r) { return r.answer === 'yes'; }),
      criteria: flags.map(function (r) { return { key: r.key, name: r.name, answer: r.answer }; }),
    };

    var base = {
      max: 100, criteria: rows, gross: gross, errors: errors, warnings: warnings,
      sections: [], computable: false, total: null, total_exact: null, applicable_weight: 0, reason: '',
    };

    if (errors.length) {
      base.reason = 'Есть ответы, которые нельзя посчитать: ' + errors.map(function (e) { return (e.name || e.key) + ' — ' + e.message; }).join('; ');
      base.sections = sectionRows(sections, rows);
      return base;
    }

    // 3–4. Перераспределение весов N/A и итог из 100.
    var applicableWeight = rows.reduce(function (s, r) { return s + (r.applicable ? r.weight : 0); }, 0);
    base.applicable_weight = applicableWeight;
    if (!(applicableWeight > 0)) {
      base.reason = 'Итог не рассчитан: нет применимых критериев с весом (все N/A или только флаги).';
      base.sections = sectionRows(sections, rows);
      return base;
    }
    var factor = 100 / applicableWeight;
    rows.forEach(function (r) {
      if (!r.applicable) return;
      r.points = r.earned * factor;
      r.max_points = r.weight * factor;
      r.points_rounded = round2(r.points);
      r.max_points_rounded = round2(r.max_points);
    });
    var exact = rows.reduce(function (s, r) { return s + (r.applicable ? r.points : 0); }, 0);
    base.total_exact = exact;
    base.total = round2(exact);
    base.computable = true;
    base.sections = sectionRows(sections, rows);
    return base;
  }

  /** Итоги разделов: набрано и максимум после перераспределения. */
  function sectionRows(sections, rows) {
    return sections.map(function (s) {
      var own = rows.filter(function (r) { return r.section === s.key && r.scored; });
      var app = own.filter(function (r) { return r.applicable && r.points !== null; });
      var points = app.reduce(function (a, r) { return a + r.points; }, 0);
      var max = app.reduce(function (a, r) { return a + r.max_points; }, 0);
      return {
        key: s.key, name: s.name,
        scored: own.length > 0,
        na_count: own.filter(function (r) { return r.answer === 'na'; }).length,
        points: app.length ? points : null,
        max: app.length ? max : null,
        points_rounded: app.length ? round2(points) : null,
        max_rounded: app.length ? round2(max) : null,
      };
    });
  }

  return {
    round2: round2,
    formatPoints: formatPoints,
    parseAnswer: parseAnswer,
    describeAnswer: describeAnswer,
    score: score,
  };
}));
