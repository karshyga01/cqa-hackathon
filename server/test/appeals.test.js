'use strict';

/* Апелляции (шаг 7): подача, решение, пересчёт итога, ошибки, закрытие при новой оценке, API. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const M = require('../../frontend/js/checklist-model');
const CL = M.normalize(require('../defaults/checklist-chat'));
const { validateAnswers } = require('../lib/evaluations');
const { createAppealService, fragmentOf } = require('../lib/appeals');
const { JsonStore } = require('../lib/store');
const { createServer } = require('../server');

const T = [
  { timestamp: '00:00', speaker: 'client', text: 'Хочу вывести деньги со счёта, заявка висит' },
  { timestamp: '00:02', speaker: 'system', text: 'Эскалация на оператора.' },
  { timestamp: '00:40', speaker: 'operator', text: 'Здравствуйте! Меня зовут Айгерим. Подскажите номер договора, пожалуйста?' },
  { timestamp: '01:10', speaker: 'client', text: 'Договор 7712' },
  { timestamp: '01:20', speaker: 'system', text: 'Личность клиента подтверждена.' },
  { timestamp: '01:30', speaker: 'operator', text: 'Спасибо, проверю заявку, это займёт пару минут.' },
  { timestamp: '04:00', speaker: 'operator', text: 'Заявка остановлена: счёт открыт на другое имя. Создайте новую заявку на свой счёт, деньги придут за день.' },
  { timestamp: '04:30', speaker: 'client', text: 'Понял, спасибо' },
  { timestamp: '04:50', speaker: 'system', text: 'Оператор закрыл чат.' },
];
const RECORD = { key: 'T:1', transcript: T };

const answers = () => validateAnswers(CL, T, {
  c_contact: { answer: 'yes', explanation: 'Поздоровался и назвал имя.', evidence: [{ turn: 3, quote: 'Меня зовут Айгерим' }] },
  c_needs: { answer: 'yes', explanation: 'Уточнил договор.', evidence: [{ turn: 3, quote: 'номер договора' }] },
  c_identity: { answer: 'yes', explanation: 'Личность подтверждена.', evidence: [{ turn: 5, quote: 'Личность клиента подтверждена' }] },
  c_consult: { answer: 15, explanation: 'Решено, без деталей.', evidence: [{ turn: 7, quote: 'Создайте новую заявку' }] },
  c_empathy: { answer: 'yes', explanation: 'Вежлив.', evidence: [{ turn: 6, quote: 'Спасибо' }] },
  c_manage: { answer: 10, explanation: 'Предупредил об ожидании.', evidence: [{ turn: 6, quote: 'это займёт пару минут' }] },
  c_closing: { answer: 'no', explanation: 'Не попрощался.', evidence: [], checked_range: { from: 8, to: 9 } },
  c_gross: { answer: 'no', explanation: 'Нарушений нет.', evidence: [] },
}).answers;
const EVAL = { id: 'ev_1', source: 'ai', checklist: { id: 'chat-quality', version: 1 }, answers: answers() };
const ctx = (over) => ({ dialogKey: 'T:1', evaluation: EVAL, checklist: CL, record: RECORD, ...over });

function svc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-ap-'));
  return createAppealService(new JsonStore(dir));
}

test('подать апелляцию: статус «ждёт решения», снимок ответа ИИ и фрагмент диалога', async () => {
  const s = svc();
  const a = await s.create(ctx(), { evaluation_id: 'ev_1', criterion_key: 'c_closing', comment: 'Прощание уходит автоматически', requested_value: 'yes' });
  assert.equal(a.status, 'open');
  assert.equal(a.no, 1);
  assert.equal(a.original.answer, 'no');
  assert.deepEqual(a.original.checked_range, { from: 8, to: 9 });
  assert.equal(a.requested_value, 'yes');
  assert.equal(a.total_at_submit, 90);
  assert.deepEqual([a.fragment.from_turn, a.fragment.to_turn], [7, 9]);
  assert.equal(s.counts().open, 1);
  assert.deepEqual(s.overridesFor('ev_1'), {}, 'пока не решено — итог не меняется');
});

test('ошибки подачи: нет комментария, нет критерия, ответ как у ИИ, недопустимый ответ, дубль, устаревшая оценка', async () => {
  const s = svc();
  await assert.rejects(() => s.create(ctx(), { criterion_key: 'c_closing', comment: '' }), (e) => e.status === 422 && e.field === 'comment');
  await assert.rejects(() => s.create(ctx(), { criterion_key: 'c_nope', comment: 'не согласен' }), (e) => e.status === 422);
  await assert.rejects(() => s.create(ctx(), { criterion_key: 'c_closing', comment: 'не согласен', requested_value: 'no' }), (e) => e.status === 422 && /совпадает/.test(e.message));
  await assert.rejects(() => s.create(ctx(), { criterion_key: 'c_consult', comment: 'не согласен', requested_value: 12 }), (e) => e.status === 422 && /12/.test(e.message));
  await assert.rejects(() => s.create(ctx(), { criterion_key: 'c_contact', comment: 'не согласен', requested_value: 'na' }), (e) => e.status === 422, 'N/A запрещён у «Установления контакта»');
  await assert.rejects(() => s.create(ctx(), { evaluation_id: 'ev_old', criterion_key: 'c_closing', comment: 'не согласен' }), (e) => e.status === 409);
  await assert.rejects(() => s.create(ctx({ evaluation: null }), { criterion_key: 'c_closing', comment: 'не согласен' }), (e) => e.status === 409);
  await s.create(ctx(), { criterion_key: 'c_closing', comment: 'не согласен' });
  await assert.rejects(() => s.create(ctx(), { criterion_key: 'c_closing', comment: 'ещё раз' }), (e) => e.status === 409 && /ждёт решения/.test(e.message));
});

test('решение «Изменено»: итог пересчитан (90 → 95), оценка ИИ не тронута; повторно решить нельзя', async () => {
  const s = svc();
  const a = await s.create(ctx(), { criterion_key: 'c_closing', comment: 'Прощание было' });
  await assert.rejects(() => s.decide(a.id, ctx(), { outcome: 'changed', new_value: 'yes', reason: '' }), (e) => e.status === 422 && e.field === 'reason');
  await assert.rejects(() => s.decide(a.id, ctx(), { outcome: 'changed', new_value: 'no', reason: 'причина' }), (e) => e.status === 422 && /совпадает/.test(e.message));
  await assert.rejects(() => s.decide(a.id, ctx(), { outcome: 'maybe', reason: 'причина' }), (e) => e.status === 422);
  await assert.rejects(() => s.decide(a.id, ctx(), { outcome: 'changed', new_value: 'yes', reason: 'Прощание было', rev: 7 }), (e) => e.status === 409);
  const d = await s.decide(a.id, ctx(), { outcome: 'changed', new_value: 'yes', reason: 'Прощание было в шаблоне', rev: 1 });
  assert.equal(d.status, 'changed');
  assert.equal(d.decision.total_before, 90);
  assert.equal(d.decision.total_after, 95);
  assert.deepEqual(s.overridesFor('ev_1'), { c_closing: 'yes' });
  assert.equal(EVAL.answers.c_closing.answer, 'no', 'оценка ИИ не меняется');
  await assert.rejects(() => s.decide(a.id, ctx(), { outcome: 'kept', reason: 'передумал' }), (e) => e.status === 409);
  await assert.rejects(() => s.create(ctx(), { criterion_key: 'c_closing', comment: 'снова' }), (e) => e.status === 409 && /решение уже принято/.test(e.message));
});

test('решение «Оставлено»: итог прежний; несколько решений по одной оценке складываются', async () => {
  const s = svc();
  const a1 = await s.create(ctx(), { criterion_key: 'c_consult', comment: 'Ответ был полным' });
  const a2 = await s.create(ctx(), { criterion_key: 'c_closing', comment: 'Прощание было' });
  const k = await s.decide(a1.id, ctx(), { outcome: 'kept', reason: 'Деталь про отмену заявки пропущена' });
  assert.equal(k.decision.total_before, 90);
  assert.equal(k.decision.total_after, 90);
  const c1 = await s.decide(a2.id, ctx(), { outcome: 'changed', new_value: 'yes', reason: 'так верно' });
  assert.equal(c1.decision.total_after, 95);
  // теперь меняем консультацию у второй оценки — итог считает обе правки
  const s2 = svc();
  const b1 = await s2.create(ctx(), { criterion_key: 'c_closing', comment: 'Прощание было' });
  await s2.decide(b1.id, ctx(), { outcome: 'changed', new_value: 'yes', reason: 'так верно' });
  const b2 = await s2.create(ctx(), { criterion_key: 'c_consult', comment: 'Полный ответ' });
  const d2 = await s2.decide(b2.id, ctx(), { outcome: 'changed', new_value: 20, reason: 'так верно' });
  assert.equal(d2.decision.total_before, 95);
  assert.equal(d2.decision.total_after, 100);
});

test('грубая ошибка: можно оспорить, итог не меняется, меняется только флаг', async () => {
  const s = svc();
  const ev = { ...EVAL, answers: { ...EVAL.answers, c_gross: { answer: 'yes', explanation: 'Похоже на нарушение', evidence: [{ turn: 7, quote: 'Создайте новую заявку' }] } } };
  const a = await s.create(ctx({ evaluation: ev }), { criterion_key: 'c_gross', comment: 'Это обычная инструкция', requested_value: 'no' });
  const d = await s.decide(a.id, ctx({ evaluation: ev }), { outcome: 'changed', new_value: 'no', reason: 'Нарушения нет' });
  assert.equal(d.decision.total_before, d.decision.total_after);
  assert.equal(d.decision.gross_before, true);
  assert.equal(d.decision.gross_after, false);
});

test('N/A как новый ответ: вес перераспределяется', async () => {
  const s = svc();
  const a = await s.create(ctx(), { criterion_key: 'c_needs', comment: 'Данных хватало сразу' });
  const d = await s.decide(a.id, ctx(), { outcome: 'changed', new_value: 'na', reason: 'Клиент сам всё написал' });
  // без c_needs (вес 15): потеряно 5 (консультация) + 5 (завершение) из 85 → 100*(75/85)
  assert.equal(d.decision.total_after, 88.24);
});

test('новая оценка диалога закрывает открытые апелляции, решённые остаются в истории', async () => {
  const s = svc();
  const open = await s.create(ctx(), { criterion_key: 'c_consult', comment: 'Ответ был полным' });
  const done = await s.create(ctx(), { criterion_key: 'c_closing', comment: 'Прощание было' });
  await s.decide(done.id, ctx(), { outcome: 'changed', new_value: 'yes', reason: 'так верно' });
  assert.equal(await s.closeStale('T:1', 'ev_2'), 1);
  assert.equal(s.get(open.id).status, 'stale');
  assert.equal(s.get(done.id).status, 'changed');
  await assert.rejects(() => s.decide(open.id, ctx(), { outcome: 'kept', reason: 'причина' }), (e) => e.status === 409 && /новая оценка/.test(e.message));
  assert.equal(await s.closeStale('T:1', 'ev_2'), 0);
});

test('фрагмент: доказательства ±2 реплики, не больше 14', () => {
  const long = Array.from({ length: 40 }, (_, i) => ({ speaker: 'client', timestamp: '', text: `реплика ${i + 1}` }));
  const f = fragmentOf(long, { evidence: [{ turn: 10 }, { turn: 30 }] });
  assert.equal(f.from_turn, 8);
  assert.equal(f.turns.length, 14);
  assert.equal(fragmentOf(long, { evidence: [{ turn: 1 }] }).from_turn, 1);
  assert.ok(fragmentOf(long, { evidence: [{ turn: 10 }] }).turns.find((t) => t.n === 10).evidence);
});

/* ---------- API ---------- */

test('API: подать → решить → финальный итог в списке и карточке; роли; новая оценка закрывает открытые', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-ap-http-'));
  const server = createServer({ dataDir, orgApiUrl: 'http://127.0.0.1:9/none', allowedOrigins: [], autoDownloadAudio: false, ai: { apiKey: '' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, json: t ? JSON.parse(t) : null }); });
    });
    rq.on('error', reject);
    if (body !== undefined) rq.write(JSON.stringify(body));
    rq.end();
  });
  try {
    await call('POST', '/api/import/json', { group_id: 'T', payload: [{ conversation_id: 'a', channel: 'agent chat', language: 'RU', transcript: T }] });
    const key = encodeURIComponent('T:a');
    assert.equal((await call('POST', `/api/dialogs/${key}/appeals`, { criterion_key: 'c_closing', comment: 'не согласен' })).status, 409, 'не оценён');
    await call('POST', `/api/dialogs/${key}/evaluate`, { mode: 'mock' });
    const ev = (await call('GET', `/api/dialogs/${key}/evaluation`)).json;
    const crit = Object.keys(ev.evaluation.answers).find((k) => ev.evaluation.answers[k].answer === 'no');
    assert.ok(crit, 'у подставной оценки есть «Нет»');
    assert.equal((await call('POST', `/api/dialogs/${key}/appeals`, { evaluation_id: ev.evaluation.id, criterion_key: crit, comment: 'не согласен', role: 'reviewer' })).status, 403);
    const sub = await call('POST', `/api/dialogs/${key}/appeals`, { evaluation_id: ev.evaluation.id, criterion_key: crit, comment: 'Не согласен с оценкой', role: 'analyst' });
    assert.equal(sub.status, 200);
    const id = sub.json.appeal.id;
    assert.equal(sub.json.counts.open, 1);

    let list = (await call('GET', '/api/dialogs')).json.items;
    assert.equal(list[0].evaluation.appeals.open, 1);
    assert.equal((await call('GET', '/api/appeals?status=open')).json.items.length, 1);
    const det = (await call('GET', `/api/appeals/${id}`)).json;
    assert.equal(det.is_current, true);
    assert.equal(det.checklist.version, 1);
    assert.equal(det.appeal.dialog.conversation_id, 'a');

    assert.equal((await call('POST', `/api/appeals/${id}/decision`, { outcome: 'changed', new_value: 'yes', reason: 'так верно', role: 'analyst' })).status, 403, 'аналитик не решает');
    const dec = await call('POST', `/api/appeals/${id}/decision`, { outcome: 'changed', new_value: 'yes', reason: 'Действие было', role: 'reviewer', rev: 1 });
    assert.equal(dec.status, 200);
    assert.ok(dec.json.appeal.decision.total_after > dec.json.appeal.decision.total_before);

    list = (await call('GET', '/api/dialogs')).json.items;
    const it = list[0].evaluation;
    assert.equal(it.total, dec.json.appeal.decision.total_after);
    assert.equal(it.ai_total, dec.json.appeal.decision.total_before);
    assert.deepEqual(it.appeals, { open: 0, decided: 1, changed: 1 });
    const card = (await call('GET', `/api/dialogs/${key}/evaluation`)).json;
    assert.equal(card.appeals.length, 1);
    assert.equal(card.evaluation.answers[crit].answer, 'no', 'оценка ИИ в карточке прежняя — решение лежит отдельно');

    // ещё одна открытая — и новая оценка её закрывает
    const other = Object.keys(card.evaluation.answers).find((k) => k !== crit && card.evaluation.answers[k].answer === 'yes' && k !== 'c_gross');
    await call('POST', `/api/dialogs/${key}/appeals`, { evaluation_id: card.evaluation.id, criterion_key: other, comment: 'Сомневаюсь', role: 'analyst' });
    const re = await call('POST', `/api/dialogs/${key}/evaluate`, { mode: 'mock' });
    assert.equal(re.json.evaluation.id !== card.evaluation.id, true);
    const all = (await call('GET', '/api/appeals?status=all')).json;
    assert.equal(all.items.find((a) => a.criterion_key === other).status, 'stale');
    assert.equal((await call('GET', '/api/dialogs')).json.items[0].evaluation.appeals.decided, 0, 'решение относится к старой оценке');

    assert.equal((await call('POST', '/api/appeals/reset', {})).status, 400);
    assert.equal((await call('POST', '/api/appeals/reset', { confirm: true })).json.counts.all, 0);
    assert.equal((await call('GET', '/api/appeals/ap_nope1')).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
