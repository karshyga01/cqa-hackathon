'use strict';

/*
 * Выгрузка результатов в формате организаторов (приложение к гайду «Как сдать результаты», JSON 1.0).
 *
 *   results/dev/results.json  — набор DEV (65 диалогов);
 *   results/prod/results.json — контрольный набор (ровно 10 чатов).
 *
 * Берётся ПОСЛЕДНЯЯ оценка каждого диалога и решённые апелляции («Изменено») — то же, что
 * карточка показывает как финальный результат. Итог считает scoring.js по версии чек-листа оценки.
 *
 * Коды критериев у организаторов фиксированы (contact, discovery, …). Наши ключи другие (c_contact, …).
 * Критерий, заменённый через «Заменить критерий», получает новый ключ — ему достаётся код того
 * критерия, место которого он занял (свободный код по порядку).
 */

const scoring = require('../../frontend/js/scoring');
const { totalWith } = require('./appeals');

const SCHEMA_VERSION = '1.0';

/** Коды организаторов в порядке чек-листа и наши ключи чек-листа по умолчанию. */
const ORG_CRITERIA = [
  { id: 'contact', key: 'c_contact' },
  { id: 'discovery', key: 'c_needs' },
  { id: 'identification', key: 'c_identity' },
  { id: 'consultation', key: 'c_consult' },
  { id: 'empathy', key: 'c_empathy' },
  { id: 'dialogue', key: 'c_manage' },
  { id: 'closure', key: 'c_closing' },
  { id: 'critical', key: 'c_gross' },
];
const ORG_IDS = ORG_CRITERIA.map((x) => x.id);

/**
 * Ключ критерия → criterion_id организаторов.
 * Известные ключи — по таблице; остальные (новый критерий после замены) — свободные коды
 * по порядку критериев в чек-листе. Если кодов не хватило — собственный ключ без «c_».
 */
function criterionIds(checklist) {
  const byKey = Object.fromEntries(ORG_CRITERIA.map((x) => [x.key, x.id]));
  const map = {};
  const used = new Set();
  const criteria = (checklist && checklist.criteria) || [];
  for (const c of criteria) {
    if (byKey[c.key] && !used.has(byKey[c.key])) { map[c.key] = byKey[c.key]; used.add(byKey[c.key]); }
  }
  // Свободный код — того же места в чек-листе, иначе первый незанятый.
  criteria.forEach((c, i) => {
    if (map[c.key]) return;
    const sameSlot = ORG_IDS[i];
    const free = sameSlot && !used.has(sameSlot) ? sameSlot : ORG_IDS.find((id) => !used.has(id));
    map[c.key] = free || String(c.key).replace(/^c_/, '');
    used.add(map[c.key]);
  });
  return map;
}

/** Наш ответ ('yes' | 'no' | 'na' | число) → value организаторов (true | false | null | число). */
function toValue(answer) {
  if (answer === 'yes') return true;
  if (answer === 'no') return false;
  if (answer === 'na') return null;
  if (typeof answer === 'number' && Number.isFinite(answer)) return answer;
  return undefined;   // ответа нет — запись станет status "error"
}

/** Номера реплик-доказательств (с 1, по исходному массиву). Для «Нет» без цитат — проверенный участок. */
function evidenceTurns(answer, turnsCount) {
  const ok = (n) => Number.isInteger(n) && n >= 1 && n <= turnsCount;
  const turns = new Set((answer.evidence || []).map((e) => Number(e && e.turn)).filter(ok));
  if (!turns.size && answer.checked_range) {
    const from = Number(answer.checked_range.from);
    const to = Math.min(Number(answer.checked_range.to), from + 19);
    for (let n = from; n <= to; n++) if (ok(n)) turns.add(n);
  }
  return [...turns].sort((a, b) => a - b);
}

function operatorTurns(record) {
  return (record.transcript || []).map((t, i) => (t && t.speaker === 'operator' ? i + 1 : 0)).filter(Boolean);
}

function errorEntry(conversationId, message) {
  return { conversation_id: conversationId, status: 'error', criteria: [], score: null, error: message };
}

/**
 * Одна запись results[] для диалога.
 * @param record      диалог (conversation_id, transcript)
 * @param evaluation  последняя оценка или null
 * @param checklist   версия чек-листа этой оценки или null
 * @param appeals     решённые апелляции этой оценки [{ criterion_key, status, decision }]
 */
function buildEntry(record, evaluation, checklist, appeals) {
  const id = record.conversation_id;
  if (!evaluation) return errorEntry(id, 'Диалог не оценён.');
  if (!checklist) return errorEntry(id, 'Не найдена версия чек-листа, по которой была оценка.');

  const changed = {};
  for (const a of appeals || []) if (a.status === 'changed' && a.decision) changed[a.criterion_key] = a;
  const overrides = Object.fromEntries(Object.entries(changed).map(([k, a]) => [k, a.decision.new_value]));

  const ids = criterionIds(checklist);
  const turnsCount = (record.transcript || []).length;
  const criteria = [];
  const missing = [];
  for (const c of checklist.criteria) {
    const ai = evaluation.answers[c.key] || {};
    const appeal = changed[c.key];
    const value = toValue(appeal ? appeal.decision.new_value : ai.answer);
    if (value === undefined) { missing.push(c.name || c.key); continue; }
    let rationale = String(ai.explanation || ai.na_reason || '').trim();
    if (appeal) rationale = `Изменено по апелляции: ${String(appeal.decision.reason || '').trim()}${rationale ? ` (оценка ИИ: ${rationale})` : ''}`;
    let turns = evidenceTurns(ai, turnsCount);
    // «Грубых нарушений нет» без цитат: проверялись все реплики оператора — их и указываем (как в примере организаторов).
    if (!turns.length && c.type === 'flag' && value === false) turns = operatorTurns(record);
    criteria.push({ criterion_id: ids[c.key], value, rationale, evidence_turns: turns });
  }
  if (missing.length) return errorEntry(id, `Нет ответа по критериям: ${missing.join(', ')}.`);

  const r = totalWith(checklist, evaluation.answers, overrides);
  return {
    conversation_id: id,
    status: 'ok',
    criteria,
    score: {
      final_score: r.computable ? r.total : null,
      critical_flag: Boolean(r.gross && r.gross.flagged),
    },
  };
}

/** Поле model: фактически использованные модели и режим (external_api | local | hybrid). */
function modelInfo(evaluations, fallbackModel) {
  const names = [];
  let ai = false;
  let local = false;
  for (const e of evaluations) {
    if (!e) continue;
    const name = e.source === 'ai' ? (e.model || fallbackModel || 'unknown') : 'mock-rules (подставная оценка, не ИИ)';
    if (e.source === 'ai') ai = true; else local = true;
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length) names.push(fallbackModel || 'unknown');
  return { mode: ai && local ? 'hybrid' : local ? 'local' : 'external_api', name: names.join(', ') };
}

/**
 * Собрать файл результатов.
 * @param items [{ record, evaluation, checklist, appeals }] — диалоги набора в исходном порядке
 */
function buildResults(items, { teamName, fallbackModel } = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    team_name: String(teamName || '').trim() || 'CQA',
    model: modelInfo(items.map((x) => x.evaluation), fallbackModel),
    results: items.map((x) => buildEntry(x.record, x.evaluation, x.checklist, x.appeals)),
  };
}

const VALUE_RULES = {
  contact: { bool: true },
  discovery: { bool: true, na: true },
  identification: { bool: true, na: true },
  consultation: { steps: [0, 5, 10, 15, 20], na: true },
  empathy: { bool: true },
  dialogue: { steps: [0, 4, 7, 10] },
  closure: { bool: true, na: true },
  critical: { bool: true },
};

/**
 * Проверка файла по правилам организаторов. Возвращает список проблем (пустой — всё в порядке).
 * @param opts.expectedCount  сколько должно быть записей (prod — ровно 10)
 * @param opts.strictValues   проверять типы значений по таблице кодов (после замены критерия тип может отличаться)
 */
function validateResults(doc, { expectedCount, strictValues = true } = {}) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['Файл — не JSON-объект.'];
  if (doc.schema_version !== SCHEMA_VERSION) problems.push(`schema_version должен быть "${SCHEMA_VERSION}".`);
  if (!String(doc.team_name || '').trim()) problems.push('Не указан team_name.');
  if (!doc.model || !['local', 'external_api', 'hybrid'].includes(doc.model.mode) || !String(doc.model.name || '').trim()) problems.push('model: нужны mode (local | external_api | hybrid) и name.');
  if (!Array.isArray(doc.results)) return [...problems, 'results должен быть массивом.'];
  if (expectedCount != null && doc.results.length !== expectedCount) problems.push(`Записей ${doc.results.length}, а должно быть ${expectedCount}.`);
  const seen = new Set();
  doc.results.forEach((r, i) => {
    const where = `results[${i}]${r && r.conversation_id ? ` (${r.conversation_id})` : ''}`;
    if (!r || typeof r.conversation_id !== 'string' || !r.conversation_id) { problems.push(`${where}: нет conversation_id.`); return; }
    if (seen.has(r.conversation_id)) problems.push(`${where}: conversation_id повторяется.`);
    seen.add(r.conversation_id);
    if (r.status === 'error') {
      if (!Array.isArray(r.criteria) || r.criteria.length || r.score !== null || !String(r.error || '').trim()) problems.push(`${where}: для status "error" нужны пустой criteria, score = null и причина в error.`);
      return;
    }
    if (r.status !== 'ok') { problems.push(`${where}: status должен быть "ok" или "error".`); return; }
    if (!Array.isArray(r.criteria) || r.criteria.length !== 8) problems.push(`${where}: нужно ровно 8 критериев.`);
    const ids = new Set();
    for (const c of r.criteria || []) {
      if (ids.has(c.criterion_id)) problems.push(`${where}: критерий ${c.criterion_id} повторяется.`);
      ids.add(c.criterion_id);
      if (typeof c.rationale !== 'string') problems.push(`${where}: ${c.criterion_id}: rationale должен быть строкой.`);
      if (!Array.isArray(c.evidence_turns) || c.evidence_turns.some((n) => !Number.isInteger(n) || n < 1)) problems.push(`${where}: ${c.criterion_id}: evidence_turns — массив номеров реплик с 1.`);
      const rule = VALUE_RULES[c.criterion_id];
      if (!rule) { if (strictValues) problems.push(`${where}: неизвестный criterion_id "${c.criterion_id}".`); continue; }
      if (!strictValues) continue;
      const v = c.value;
      const ok = (v === null && rule.na) || (rule.bool && typeof v === 'boolean') || (rule.steps && typeof v === 'number' && rule.steps.includes(v));
      if (!ok) problems.push(`${where}: ${c.criterion_id}: недопустимое значение ${JSON.stringify(v)}.`);
    }
    if (strictValues) for (const id of ORG_IDS) if (!ids.has(id)) problems.push(`${where}: нет критерия ${id}.`);
    const s = r.score;
    if (!s || typeof s !== 'object') { problems.push(`${where}: нет score.`); return; }
    if (s.final_score !== null && !(typeof s.final_score === 'number' && s.final_score >= 0 && s.final_score <= 100 && scoring.round2(s.final_score) === s.final_score)) problems.push(`${where}: final_score — число от 0 до 100 с двумя знаками.`);
    const crit = (r.criteria || []).find((c) => c.criterion_id === 'critical');
    if (typeof s.critical_flag !== 'boolean') problems.push(`${where}: critical_flag должен быть true или false.`);
    else if (crit && crit.value !== s.critical_flag) problems.push(`${where}: critical_flag не совпадает с критерием critical.`);
  });
  return problems;
}

module.exports = { buildResults, buildEntry, validateResults, criterionIds, toValue, evidenceTurns, modelInfo, ORG_CRITERIA, SCHEMA_VERSION };
