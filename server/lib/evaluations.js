'use strict';

const scoring = require('../../frontend/js/scoring');

/*
 * Оценки диалогов.
 * evaluations.json: { "<ключ диалога>": [ оценка, оценка, ... ] } — история, последняя в конце.
 *
 * Оценка:
 * {
 *   id, dialog_key, created_at,
 *   source: 'mock' | 'ai', model,
 *   checklist: { id, version },
 *   answers: { [ключ критерия]: { answer, explanation, evidence:[{turn,quote}], checked_range:{from,to}|null,
 *                                  na_reason, confidence, issues:[текст] } },
 *   summary, usage: { input_tokens, output_tokens, cost_usd } | null,
 *   result: { total, computable, gross_flagged, needs_review, reason }   // для списка; в карточке пересчитывается
 * }
 * Баллы НЕ хранятся как истина: их всегда считает scoring.js из ответов и версии чек-листа.
 */

function norm(s) {
  return String(s || '').toLocaleLowerCase('ru').replace(/[«»"“”„'`]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Проверяет ответы на соответствие чек-листу и диалогу. Ничего не выбрасывает:
 * возвращает копию ответов с полем issues у проблемных критериев.
 * Эта же проверка будет применяться к ответам ИИ (шаг 5).
 */
function validateAnswers(checklist, transcript, answers) {
  const n = transcript.length;
  const out = {};
  const problems = [];
  for (const c of checklist.criteria) {
    const raw = answers && Object.prototype.hasOwnProperty.call(answers, c.key) ? answers[c.key] : null;
    const a = raw && typeof raw === 'object' ? { ...raw } : { answer: raw };
    const issues = [];
    const parsed = scoring.parseAnswer(c, a.answer);
    if (parsed.error) issues.push(parsed.error);

    a.evidence = Array.isArray(a.evidence) ? a.evidence.filter((e) => e && typeof e === 'object') : [];
    a.evidence = a.evidence.map((e) => {
      const turn = Number(e.turn);
      const item = { turn, quote: String(e.quote || '') };
      if (!Number.isInteger(turn) || turn < 1 || turn > n) { issues.push(`реплики №${e.turn} нет (в диалоге ${n})`); return item; }
      if (!norm(item.quote)) { issues.push(`пустая цитата из реплики №${turn}`); return item; }
      if (!norm(transcript[turn - 1].text).includes(norm(item.quote))) {
        // цитата может оказаться в соседней реплике — поправляем номер
        const near = [turn - 1, turn + 1].find((k) => k >= 1 && k <= n && norm(transcript[k - 1].text).includes(norm(item.quote)));
        if (near) { item.turn = near; item.fixed_from = turn; } else issues.push(`цитаты нет в реплике №${turn}`);
      }
      return item;
    });

    if (!parsed.error) {
      if (parsed.kind === 'no' && c.type !== 'flag') {
        const r = a.checked_range;
        if (!r || !Number.isInteger(Number(r.from)) || !Number.isInteger(Number(r.to)) || Number(r.from) < 1 || Number(r.to) > n || Number(r.from) > Number(r.to)) {
          if (!a.evidence.length) issues.push('для «Нет» не указан проверенный участок разговора');
          a.checked_range = null;
        } else {
          a.checked_range = { from: Number(r.from), to: Number(r.to) };
        }
      } else {
        a.checked_range = null;
      }
      if (parsed.kind === 'na' && !String(a.na_reason || '').trim()) issues.push('для N/A не указано, какое условие выполнено');
      if ((parsed.kind === 'yes' || parsed.kind === 'step') && !a.evidence.length && c.type !== 'flag') issues.push('нет реплики-доказательства');
      if (c.type === 'flag' && parsed.kind === 'yes' && !a.evidence.length) issues.push('грубая ошибка без реплики-доказательства');
    }
    if (!String(a.explanation || '').trim()) issues.push('нет объяснения');
    a.issues = issues;
    if (issues.length) problems.push({ key: c.key, name: c.name, issues });
    out[c.key] = a;
  }
  return { answers: out, problems };
}

/** Короткая сводка результата для списка диалогов. */
function resultOf(checklist, answers) {
  const values = {};
  for (const k of Object.keys(answers)) values[k] = answers[k].answer;
  const r = scoring.score(checklist, values);
  const needsReview = Object.values(answers).some((a) => (a.issues && a.issues.length) || a.confidence === 'low')
    || (r.gross && r.gross.flagged);
  return {
    total: r.total,
    computable: r.computable,
    gross_flagged: r.gross.flagged,
    needs_review: Boolean(needsReview),
    reason: r.computable ? '' : r.reason,
  };
}

function createEvaluationService(store, { now = () => new Date().toISOString(), newId } = {}) {
  const all = () => store.get('evaluations', {});
  const makeId = newId || (() => `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);

  function history(key) {
    const h = Object.prototype.hasOwnProperty.call(all(), key) ? all()[key] : [];
    return Array.isArray(h) ? h : [];
  }
  function latest(key) { const h = history(key); return h.length ? h[h.length - 1] : null; }

  /** Сохранить новую оценку (история не перезаписывается). */
  async function save(key, { record, checklist, checklistRef, answers, source, model, summary, usage }) {
    const v = validateAnswers(checklist, record.transcript, answers);
    const evaluation = {
      id: makeId(),
      dialog_key: key,
      created_at: now(),
      source,
      model: model || null,
      checklist: checklistRef,
      answers: v.answers,
      summary: summary || '',
      usage: usage || null,
      result: resultOf(checklist, v.answers),
    };
    await store.update('evaluations', (cur) => {
      const prev = Object.prototype.hasOwnProperty.call(cur, key) && Array.isArray(cur[key]) ? cur[key] : [];
      return { ...cur, [key]: [...prev, evaluation] };
    });
    return { evaluation, problems: v.problems };
  }

  /** Сводка для таблицы «Диалоги». */
  function summary(key) {
    const e = latest(key);
    if (!e) return null;
    return {
      id: e.id, source: e.source, created_at: e.created_at,
      checklist: e.checklist,
      total: e.result.total, computable: e.result.computable,
      gross_flagged: e.result.gross_flagged, needs_review: e.result.needs_review,
    };
  }

  return { history, latest, save, summary };
}

module.exports = { createEvaluationService, validateAnswers, resultOf };
