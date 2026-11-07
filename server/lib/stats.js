'use strict';

/*
 * Статистика по набору (вкладка «Статистика»).
 * Считается по ФИНАЛЬНЫМ ответам: последняя оценка диалога + решённые апелляции «Изменено» —
 * то же, что показывает карточка и что уходит в results.json. Баллы считает scoring.js.
 *
 * «Потерянные баллы» критерия в диалоге = максимум критерия после перераспределения N/A
 * минус набранное (в баллах итога из 100). Сумма потерь по критериям = 100 − итог.
 */

const { totalWith } = require('./appeals');

const BUCKETS = [
  { key: 'lt50', label: 'до 50', test: (t) => t < 50 },
  { key: '50', label: '50–69,99', test: (t) => t >= 50 && t < 70 },
  { key: '70', label: '70–84,99', test: (t) => t >= 70 && t < 85 },
  { key: '85', label: '85–99,99', test: (t) => t >= 85 && t < 100 },
  { key: '100', label: '100', test: (t) => t >= 100 },
];

const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Ответ → группа для распределения: полный балл / частично / ноль / N/A. */
function answerGroup(criterion, answer) {
  if (answer === 'na') return 'na';
  if (criterion.type === 'scale') {
    const top = Math.max(...(criterion.scale || []).map((s) => Number(s.points)));
    if (answer === top) return 'full';
    if (answer === 0) return 'zero';
    return typeof answer === 'number' ? 'partial' : null;
  }
  if (answer === 'yes') return 'full';
  if (answer === 'no') return 'zero';
  return null;
}

/**
 * @param items [{ record, evaluation, checklist, appeals, history }] — диалоги набора
 * @param opts  { channel, language } — фильтры (пусто — все)
 */
function computeStats(items, { channel = '', language = '' } = {}) {
  const pool = items.filter((x) =>
    (!channel || x.record.channel === channel) && (!language || x.record.language === language));

  const crit = new Map();   // key → агрегаты по критерию
  const dialogs = [];
  const totals = [];
  const gross = [];
  let review = 0;
  const appeals = { open: 0, decided: 0, changed: 0 };
  const models = new Set();
  const fullCosts = [];
  let spent = 0;

  for (const x of pool) {
    for (const h of x.history || []) {
      const u = h.usage;
      if (h.source !== 'ai' || !u) continue;
      spent += Number(u.cost_usd) || 0;
      if (Number(u.cost_usd) > 0 && !(u.reused && u.reused.length)) fullCosts.push(Number(u.cost_usd));
    }
    if (!x.evaluation || !x.checklist) continue;
    const e = x.evaluation;
    if (e.source === 'ai' && e.model) models.add(e.model); else if (e.source !== 'ai') models.add('подставная оценка');
    if (e.result && e.result.needs_review) review++;
    for (const a of x.appeals || []) {
      if (a.status === 'open') appeals.open++;
      if (a.status === 'kept' || a.status === 'changed') appeals.decided++;
      if (a.status === 'changed') appeals.changed++;
    }
    const overrides = {};
    for (const a of x.appeals || []) if (a.status === 'changed' && a.decision) overrides[a.criterion_key] = a.decision.new_value;
    const s = totalWith(x.checklist, e.answers, overrides);

    let worst = null;
    for (const c of x.checklist.criteria) {
      const row = s.criteria.find((r) => r.key === c.key);
      if (!row) continue;
      if (!crit.has(c.key)) {
        crit.set(c.key, { key: c.key, name: c.name, type: c.type, weight: c.type === 'flag' ? 0 : Number(c.weight) || 0,
          counts: { full: 0, partial: 0, zero: 0, na: 0 }, steps: {}, lost: 0, earned: 0, max: 0, applicable: 0, evaluated: 0, flagged: 0 });
      }
      const g = crit.get(c.key);
      g.name = c.name;   // имя из последней встреченной версии
      g.evaluated++;
      if (c.type === 'flag') { if (row.answer === 'yes') g.flagged++; continue; }
      const grp = answerGroup(c, row.answer);
      if (grp) g.counts[grp]++;
      if (typeof row.answer === 'number') g.steps[row.answer] = (g.steps[row.answer] || 0) + 1;
      if (s.computable && row.applicable) {
        const lost = row.max_points - row.points;
        g.lost += lost; g.earned += row.points; g.max += row.max_points; g.applicable++;
        if (lost > 1e-9 && (!worst || lost > worst.lost)) worst = { key: c.key, name: c.name, lost };
      }
    }

    const item = {
      key: x.record.key, conversation_id: x.record.conversation_id, channel: x.record.channel, language: x.record.language,
      total: s.computable ? s.total : null, gross: Boolean(s.gross && s.gross.flagged),
      worst: worst ? { name: worst.name, lost: round(worst.lost) } : null,
    };
    dialogs.push(item);
    if (s.computable) totals.push(s.total);
    if (item.gross) {
      const flagKeys = x.checklist.criteria.filter((c) => c.type === 'flag').map((c) => c.key);
      const reasons = flagKeys
        .filter((k) => (overrides[k] === undefined ? e.answers[k] && e.answers[k].answer === 'yes' : overrides[k] === 'yes'))
        .map((k) => e.answers[k] || {});
      gross.push({
        key: item.key, conversation_id: item.conversation_id, language: item.language, total: item.total,
        explanation: reasons.map((a) => a.explanation).filter(Boolean).join(' '),
        turns: [...new Set(reasons.flatMap((a) => (a.evidence || []).map((ev) => ev.turn)))].sort((a, b) => a - b),
      });
    }
  }

  const computed = totals.length;
  const criteria = [...crit.values()].map((g) => ({
    key: g.key, name: g.name, type: g.type, weight: g.weight,
    evaluated: g.evaluated, applicable: g.applicable,
    counts: g.counts, steps: g.steps, flagged: g.flagged,
    avg_lost: computed ? round(g.lost / computed) : null,          // в среднем на диалог, баллов из 100
    share_earned: g.max > 0 ? round((g.earned / g.max) * 100, 1) : null,   // % от возможного там, где применим
  }));

  const groupBy = (field) => {
    const m = new Map();
    for (const d of dialogs) {
      const k = d[field] || '—';
      if (!m.has(k)) m.set(k, { key: k, n: 0, totals: [], gross: 0 });
      const g = m.get(k);
      g.n++; if (d.total !== null) g.totals.push(d.total); if (d.gross) g.gross++;
    }
    return [...m.values()].map((g) => ({ key: g.key, n: g.n, avg: round(mean(g.totals)), gross: g.gross }))
      .sort((a, b) => b.n - a.n);
  };

  return {
    filters: { channel, language },
    total_dialogs: pool.length,
    evaluated: dialogs.length,
    computed,
    avg: round(mean(totals)),
    median: round(median(totals)),
    min: computed ? Math.min(...totals) : null,
    max: computed ? Math.max(...totals) : null,
    needs_review: review,
    appeals,
    gross_count: gross.length,
    models: [...models],
    cost: { spent_usd: round(spent, 4), per_evaluation_usd: round(mean(fullCosts), 4), evaluations: fullCosts.length },
    criteria,
    histogram: BUCKETS.map((b) => ({ key: b.key, label: b.label, n: totals.filter(b.test).length })),
    by_language: groupBy('language'),
    by_channel: groupBy('channel'),
    worst: dialogs.filter((d) => d.total !== null).sort((a, b) => a.total - b.total).slice(0, 8),
    gross,
  };
}

module.exports = { computeStats, answerGroup, BUCKETS };
