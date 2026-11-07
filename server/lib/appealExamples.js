'use strict';

/*
 * Решённые апелляции как примеры для ИИ (переключатель «Учитывать апелляции», по умолчанию выключен).
 *
 * Проверяющий оставил или изменил оценку ИИ по критерию — это прецедент: «в такой ситуации в нашей
 * компании правильно так». При оценке ДРУГИХ диалогов такие решения добавляются в запрос к ИИ
 * как примеры по тому же критерию. Модель не обучается — меняется только запрос.
 *
 * Правила отбора:
 *  - только решённые апелляции: «Изменено» и «Оставлено»;
 *  - тот же критерий И тот же его смысл (название, описание, тип) — после замены критерия старые примеры не подходят;
 *  - не из того же диалога, который сейчас оцениваем (иначе ИИ просто перепишет ответ проверяющего);
 *  - до 3 примеров на критерий: сначала на том же языке, затем самые свежие.
 */

const crypto = require('crypto');

const MAX_PER_CRITERION = 3;
const ROLE = { client: 'CLIENT', operator: 'OPERATOR', bot: 'BOT', system: 'SYSTEM' };

/** Смысл критерия: если он поменялся, прошлые решения по нему не переносим. */
function criterionMeaning(c) {
  return JSON.stringify([String(c.name || '').trim(), String(c.description || '').trim(), c.type,
    (c.scale || []).map((s) => Number(s.points)).sort((a, b) => a - b)]);
}

function answerText(v) {
  if (v === 'yes') return 'Да';
  if (v === 'no') return 'Нет';
  if (v === 'na') return 'N/A';
  if (v === null || v === undefined) return '—';
  return String(v);
}

/**
 * @param appeals    все апелляции (store)
 * @param checklist  версия чек-листа, по которой сейчас оцениваем
 * @param opts.dialogKey   ключ оцениваемого диалога (его апелляции не берём)
 * @param opts.language    язык оцениваемого диалога (такие примеры — первыми)
 * @param opts.criterionOf (appeal) → критерий из версии чек-листа апелляции или null
 * @param opts.dialogOf    (key) → диалог (для языка и номера) или null
 * @returns {{ [criterionKey]: Array<example> }}
 */
function selectExamples(appeals, checklist, { dialogKey, language, criterionOf, dialogOf } = {}) {
  const out = {};
  for (const c of checklist.criteria) {
    const meaning = criterionMeaning(c);
    const list = (appeals || [])
      .filter((a) => (a.status === 'changed' || a.status === 'kept') && a.decision && a.criterion_key === c.key && a.dialog_key !== dialogKey)
      .map((a) => ({ a, crit: criterionOf ? criterionOf(a) : null, d: dialogOf ? dialogOf(a.dialog_key) : null }))
      .filter((x) => x.crit && criterionMeaning(x.crit) === meaning)
      .sort((x, y) => {
        const lx = x.d && x.d.language === language ? 0 : 1;
        const ly = y.d && y.d.language === language ? 0 : 1;
        return lx - ly || String(y.a.decision.decided_at || '').localeCompare(String(x.a.decision.decided_at || ''));
      })
      .slice(0, MAX_PER_CRITERION)
      .map(({ a, d }) => ({
        id: a.id,
        no: a.no,
        rev: a.rev || 1,
        conversation_id: d ? d.conversation_id : String(a.dialog_key).split(':').pop(),
        language: d ? d.language : '',
        status: a.status,
        ai_answer: a.original ? a.original.answer : null,
        ai_explanation: a.original ? a.original.explanation : '',
        comment: a.comment || '',
        final_answer: a.status === 'changed' ? a.decision.new_value : (a.original ? a.original.answer : null),
        reason: a.decision.reason || '',
        fragment: (a.fragment && a.fragment.turns) || [],
      }));
    if (list.length) out[c.key] = list;
  }
  return out;
}

/** Хэш примеров критерия — входит в отпечаток ответа (другие примеры → ответ спрашивается заново). */
function examplesHash(list) {
  return crypto.createHash('sha256').update(JSON.stringify((list || []).map((e) => [e.id, e.rev, e.final_answer]))).digest('hex').slice(0, 16);
}

/** Текст примеров для запроса. Реплики чужого диалога без номеров — чтобы ИИ не цитировал их как доказательства. */
function examplesText(byCriterion, criteria) {
  const blocks = [];
  for (const c of criteria) {
    const list = byCriterion[c.key];
    if (!list || !list.length) continue;
    const lines = [`### ${c.key} — ${c.name}`];
    list.forEach((e, i) => {
      lines.push(`Пример ${i + 1} (апелляция №${e.no}, другой диалог, язык ${e.language || '—'}):`);
      for (const t of e.fragment) lines.push(`  ${ROLE[t.speaker] || String(t.speaker).toUpperCase()}: ${String(t.text || '').replace(/\s+/g, ' ').trim()}`);
      lines.push(`  Ответ ИИ: ${answerText(e.ai_answer)}${e.ai_explanation ? ` — «${e.ai_explanation}»` : ''}`);
      if (e.comment) lines.push(`  Комментарий аналитика: ${e.comment}`);
      lines.push(e.status === 'changed'
        ? `  Решение проверяющего: ИЗМЕНЕНО на «${answerText(e.final_answer)}». Причина: ${e.reason}`
        : `  Решение проверяющего: ОСТАВЛЕНО «${answerText(e.final_answer)}» (ИИ был прав). Причина: ${e.reason}`);
    });
    blocks.push(lines.join('\n'));
  }
  if (!blocks.length) return '';
  return [
    '## Precedents: decisions of the human QA reviewer on past appeals (Russian)',
    'These are final decisions of the quality reviewer on the SAME criteria in OTHER conversations. Treat them as precedents for how this company applies the criteria: if the current conversation has a similar situation, decide consistently with the reviewer. If the situation is different, judge the current conversation on its own. The precedents are NOT part of the current conversation: never cite them as evidence; turn numbers and quotes must come only from the current transcript.',
    '',
    ...blocks,
  ].join('\n');
}

module.exports = { selectExamples, examplesText, examplesHash, criterionMeaning, MAX_PER_CRITERION };
