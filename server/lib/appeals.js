'use strict';

/*
 * Апелляции (шаг 7).
 *
 * Процесс: аналитик оспаривает ОДИН критерий конкретной оценки (комментарий обязателен,
 * верный ответ — по желанию) → проверяющий решает: «Оставить» или «Изменить» (новый ответ),
 * причина обязательна в обоих случаях. Один круг: решённую апелляцию не меняют.
 *
 * Статусы: open → kept | changed. Если по диалогу сделали новую оценку, открытые апелляции
 * старой оценки становятся stale (решать уже нечего: оценка другая).
 *
 * Оценка ИИ НЕ меняется. Финальный итог = scoring.score(версия чек-листа оценки,
 * { ...ответы ИИ, ...новые ответы из апелляций со статусом changed }).
 *
 * appeals.json: { seq, items: [апелляция, ...] }
 */

const scoring = require('../../frontend/js/scoring');

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

const FINAL = new Set(['kept', 'changed', 'stale']);

/** Ответ для сравнения и хранения: 'yes' | 'no' | 'na' | число. */
function canon(c, raw) {
  const p = scoring.parseAnswer(c, raw);
  if (p.error) return { error: p.error };
  if (p.kind === 'step') return { value: p.step };
  return { value: p.kind };
}

function sameAnswer(a, b) { return a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9); }

/** Фрагмент для проверяющего: реплики-доказательства ±2 или проверенный участок ±1 (до 14 реплик). */
function fragmentOf(transcript, answer) {
  const n = transcript.length;
  const marks = new Set();
  (answer.evidence || []).forEach((e) => { if (Number.isInteger(e.turn)) marks.add(e.turn); });
  let from; let to;
  if (answer.checked_range) {
    from = answer.checked_range.from - 1; to = answer.checked_range.to + 1;
  } else if (marks.size) {
    from = Math.min(...marks) - 2; to = Math.max(...marks) + 2;
  } else {
    from = 1; to = Math.min(n, 6);
  }
  from = Math.max(1, from); to = Math.min(n, to);
  if (to - from + 1 > 14) to = from + 13;
  const turns = [];
  for (let k = from; k <= to; k++) {
    const t = transcript[k - 1];
    turns.push({ n: k, speaker: t.speaker, timestamp: t.timestamp || '', text: t.text, evidence: marks.has(k) });
  }
  return { from_turn: from, to_turn: to, turns };
}

function totalWith(checklist, answers, overrides) {
  const values = {};
  for (const k of Object.keys(answers || {})) values[k] = answers[k].answer;
  Object.assign(values, overrides || {});
  return scoring.score(checklist, values);
}

function createAppealService(store, { now = () => new Date().toISOString(), newId } = {}) {
  const read = () => {
    const s = store.get('appeals', null);
    return s && Array.isArray(s.items) ? s : { seq: 0, items: [] };
  };
  const makeId = newId || (() => `ap_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);

  function list({ status = 'all', dialogKey } = {}) {
    let items = read().items;
    if (dialogKey) items = items.filter((a) => a.dialog_key === dialogKey);
    if (status === 'open') items = items.filter((a) => a.status === 'open');
    else if (status === 'decided') items = items.filter((a) => a.status === 'kept' || a.status === 'changed');
    return items.slice().sort((a, b) => (status === 'open' ? a.no - b.no : b.no - a.no));
  }

  function counts() {
    const items = read().items;
    return {
      open: items.filter((a) => a.status === 'open').length,
      decided: items.filter((a) => a.status === 'kept' || a.status === 'changed').length,
      all: items.length,
    };
  }

  function get(id) {
    const a = read().items.find((x) => x.id === id);
    if (!a) throw httpError(404, 'Апелляция не найдена.');
    return a;
  }

  function forEvaluation(evaluationId) { return read().items.filter((a) => a.evaluation_id === evaluationId); }

  /** Новые ответы из решённых апелляций «Изменено» для этой оценки. */
  function overridesFor(evaluationId) {
    const o = {};
    for (const a of read().items) if (a.evaluation_id === evaluationId && a.status === 'changed') o[a.criterion_key] = a.decision.new_value;
    return o;
  }

  /**
   * Подать апелляцию.
   * @param ctx { dialogKey, evaluation (последняя), checklist (версия оценки), record }
   * @param body { evaluation_id, criterion_key, comment, requested_value? }
   */
  async function create(ctx, body) {
    const { dialogKey, evaluation, checklist, record } = ctx;
    const b = body || {};
    if (!evaluation) throw httpError(409, 'Диалог ещё не оценён — оспаривать нечего.');
    if (b.evaluation_id && b.evaluation_id !== evaluation.id) throw httpError(409, 'Оценка уже обновилась. Откройте диалог заново и оспорьте новую оценку.');
    const c = checklist.criteria.find((x) => x.key === b.criterion_key);
    if (!c) throw httpError(422, 'Такого критерия нет в чек-листе этой оценки.');
    const comment = String(b.comment || '').trim();
    if (comment.length < 5) throw httpError(422, 'Напишите, почему вы не согласны (хотя бы пару слов).', { field: 'comment' });
    if (comment.length > 2000) throw httpError(422, 'Комментарий длиннее 2000 символов.', { field: 'comment' });
    const original = evaluation.answers[c.key] || {};
    let requested = null;
    if (b.requested_value !== undefined && b.requested_value !== null && b.requested_value !== '') {
      const r = canon(c, b.requested_value);
      if (r.error) throw httpError(422, `Предложенный ответ не подходит: ${r.error}.`, { field: 'requested_value' });
      if (sameAnswer(r.value, original.answer)) throw httpError(422, 'Предложенный ответ совпадает с ответом ИИ.', { field: 'requested_value' });
      requested = r.value;
    }
    const before = totalWith(checklist, evaluation.answers, overridesFor(evaluation.id));
    let created;
    await store.update('appeals', (cur) => {
      const state = cur && Array.isArray(cur.items) ? cur : { seq: 0, items: [] };
      const same = state.items.filter((a) => a.evaluation_id === evaluation.id && a.criterion_key === c.key);
      if (same.some((a) => a.status === 'open')) throw httpError(409, 'По этому критерию апелляция уже ждёт решения.');
      const done = same.find((a) => a.status === 'kept' || a.status === 'changed');
      if (done) throw httpError(409, `По этому критерию решение уже принято: ${done.status === 'kept' ? 'оставлено' : 'изменено'}.`);
      const no = (state.seq || 0) + 1;
      created = {
        id: makeId(),
        no,
        dialog_key: dialogKey,
        evaluation_id: evaluation.id,
        evaluation_source: evaluation.source,
        checklist: { id: evaluation.checklist.id, version: evaluation.checklist.version },
        criterion_key: c.key,
        criterion_snapshot: { name: c.name, section: c.section, type: c.type, weight: c.weight, scale: c.scale, na_allowed: c.na_allowed, na_condition: c.na_condition },
        original: {
          answer: original.answer === undefined ? null : original.answer,
          explanation: original.explanation || '',
          evidence: original.evidence || [],
          checked_range: original.checked_range || null,
          na_reason: original.na_reason || null,
        },
        fragment: fragmentOf(record.transcript, original),
        comment,
        requested_value: requested,
        total_at_submit: before.total,
        status: 'open',
        rev: 1,
        created_at: now(),
        created_by: { role: 'analyst' },
        decision: null,
        closed_at: null,
        closed_reason: null,
      };
      return { seq: no, items: [...state.items, created] };
    });
    return created;
  }

  /**
   * Решение проверяющего.
   * @param ctx { evaluation (та, к которой относится апелляция), checklist }
   * @param body { outcome: 'kept'|'changed', new_value?, reason, rev? }
   */
  async function decide(id, ctx, body) {
    const b = body || {};
    const outcome = b.outcome;
    if (outcome !== 'kept' && outcome !== 'changed') throw httpError(422, 'Выберите «Оставить» или «Изменить».', { field: 'outcome' });
    const reason = String(b.reason || '').trim();
    if (reason.length < 3) throw httpError(422, 'Укажите причину решения.', { field: 'reason' });
    if (reason.length > 2000) throw httpError(422, 'Причина длиннее 2000 символов.', { field: 'reason' });
    const current = get(id);
    const { evaluation, checklist } = ctx;
    const c = checklist.criteria.find((x) => x.key === current.criterion_key);
    if (!c) throw httpError(409, 'Критерия этой апелляции нет в чек-листе оценки.');
    let newValue = null;
    if (outcome === 'changed') {
      const r = canon(c, b.new_value);
      if (r.error) throw httpError(422, `Новый ответ не подходит: ${r.error}.`, { field: 'new_value' });
      if (sameAnswer(r.value, current.original.answer)) throw httpError(422, 'Новый ответ совпадает с ответом ИИ — выберите «Оставить».', { field: 'new_value' });
      newValue = r.value;
    }
    let decided;
    await store.update('appeals', (cur) => {
      const state = cur && Array.isArray(cur.items) ? cur : { seq: 0, items: [] };
      const i = state.items.findIndex((a) => a.id === id);
      if (i < 0) throw httpError(404, 'Апелляция не найдена.');
      const a = state.items[i];
      if (a.status !== 'open') {
        throw httpError(409, a.status === 'stale' ? 'Апелляция закрыта: по диалогу сделана новая оценка.' : `Решение уже принято: ${a.status === 'kept' ? 'оставлено' : 'изменено'}.`, { appeal: a });
      }
      if (b.rev !== undefined && Number(b.rev) !== a.rev) throw httpError(409, 'Апелляцию уже изменили. Обновите страницу.', { appeal: a });
      // итог «до» и «после» — с учётом других уже решённых апелляций этой оценки (считаем на сервере)
      const others = {};
      for (const x of state.items) if (x.evaluation_id === a.evaluation_id && x.status === 'changed' && x.id !== a.id) others[x.criterion_key] = x.decision.new_value;
      const before = totalWith(checklist, evaluation.answers, others);
      const after = outcome === 'changed' ? totalWith(checklist, evaluation.answers, { ...others, [a.criterion_key]: newValue }) : before;
      decided = {
        ...a,
        status: outcome,
        rev: a.rev + 1,
        decision: {
          outcome, new_value: newValue, reason, decided_at: now(), decided_by: { role: 'reviewer' },
          total_before: before.total, total_after: after.total,
          gross_before: before.gross.flagged, gross_after: after.gross.flagged,
        },
        closed_at: now(),
      };
      const items = state.items.slice();
      items[i] = decided;
      return { ...state, items };
    });
    return decided;
  }

  /** По диалогу сделана новая оценка: открытые апелляции старых оценок закрываются. */
  async function closeStale(dialogKey, currentEvaluationId) {
    let closed = 0;
    // нечего закрывать — файл не трогаем (лишняя запись на каждую оценку)
    const need = read().items.some((a) => a.dialog_key === dialogKey && a.status === 'open' && a.evaluation_id !== currentEvaluationId);
    if (!need) return 0;
    await store.update('appeals', (cur) => {
      const state = cur && Array.isArray(cur.items) ? cur : { seq: 0, items: [] };
      const items = state.items.map((a) => {
        if (a.dialog_key !== dialogKey || a.status !== 'open' || a.evaluation_id === currentEvaluationId) return a;
        closed += 1;
        return { ...a, status: 'stale', rev: a.rev + 1, closed_at: now(), closed_reason: 'Сделана новая оценка диалога' };
      });
      return closed ? { ...state, items } : cur;
    });
    return closed;
  }

  /** Удалить все апелляции (для репетиции демо). */
  async function reset() {
    await store.update('appeals', () => ({ seq: 0, items: [] }));
  }

  return { list, counts, get, forEvaluation, overridesFor, create, decide, closeStale, reset, FINAL };
}

module.exports = { createAppealService, totalWith, fragmentOf };
