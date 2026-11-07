'use strict';

/* Оценки: проверка ответов (её же будет использовать ИИ), подставная оценка, хранение, API. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const M = require('../../frontend/js/checklist-model');
const S = require('../../frontend/js/scoring');
const CL = M.normalize(require('../defaults/checklist-chat'));
const { validateAnswers, resultOf, createEvaluationService } = require('../lib/evaluations');
const { mockEvaluate } = require('../lib/mockEvaluator');
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
const RECORD = { key: 'T:1', transcript: T.map((t, i) => ({ ...t, offset_sec: i * 10 })) };

const good = () => ({
  c_contact: { answer: 'yes', explanation: 'Поздоровался и назвал имя.', evidence: [{ turn: 3, quote: 'Меня зовут Айгерим' }] },
  c_needs: { answer: 'yes', explanation: 'Уточнил договор.', evidence: [{ turn: 3, quote: 'номер договора' }] },
  c_identity: { answer: 'yes', explanation: 'Личность подтверждена.', evidence: [{ turn: 5, quote: 'Личность клиента подтверждена' }] },
  c_consult: { answer: 15, explanation: 'Решено, без деталей отмены.', evidence: [{ turn: 7, quote: 'Создайте новую заявку' }] },
  c_empathy: { answer: 'yes', explanation: 'Вежлив.', evidence: [{ turn: 6, quote: 'Спасибо' }] },
  c_manage: { answer: 10, explanation: 'Предупредил об ожидании.', evidence: [{ turn: 6, quote: 'это займёт пару минут' }] },
  c_closing: { answer: 'no', explanation: 'Не попрощался.', evidence: [], checked_range: { from: 8, to: 9 } },
  c_gross: { answer: 'no', explanation: 'Нарушений нет.', evidence: [] },
});

/* ---------- проверка ответов ---------- */

test('корректные ответы проходят проверку без замечаний', () => {
  const v = validateAnswers(CL, T, good());
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.answers.c_closing.checked_range, { from: 8, to: 9 });
});

test('выдуманная реплика, чужая цитата, «Нет» без участка, N/A без причины — замечания', () => {
  const a = good();
  a.c_contact.evidence = [{ turn: 42, quote: 'привет' }];
  a.c_needs.evidence = [{ turn: 1, quote: 'этого текста нет' }];
  a.c_closing = { answer: 'no', explanation: 'нет', evidence: [], checked_range: { from: 9, to: 2 } };
  a.c_identity = { answer: 'na', explanation: 'общий вопрос', evidence: [] };
  a.c_consult = { answer: 12, explanation: 'x', evidence: [{ turn: 7, quote: 'Создайте' }] };
  const v = validateAnswers(CL, T, a);
  const by = Object.fromEntries(v.problems.map((p) => [p.key, p.issues.join(' | ')]));
  assert.match(by.c_contact, /реплики №42 нет/);
  assert.match(by.c_needs, /цитаты нет в реплике №1/);
  assert.match(by.c_closing, /не указан проверенный участок/);
  assert.match(by.c_identity, /не указано, какое условие/);
  assert.match(by.c_consult, /ступени 12 нет в шкале/);
});

test('цитата из соседней реплики — номер поправляется автоматически', () => {
  const a = good();
  a.c_contact.evidence = [{ turn: 4, quote: 'Меня зовут Айгерим' }]; // на самом деле №3
  const v = validateAnswers(CL, T, a);
  assert.deepEqual(v.problems, []);
  assert.equal(v.answers.c_contact.evidence[0].turn, 3);
  assert.equal(v.answers.c_contact.evidence[0].fixed_from, 4);
});

test('итог для списка совпадает с scoring.js; грубая ошибка требует проверки', () => {
  const v = validateAnswers(CL, T, good());
  const r = resultOf(CL, v.answers);
  const values = Object.fromEntries(Object.entries(v.answers).map(([k, x]) => [k, x.answer]));
  assert.equal(r.total, S.score(CL, values).total);
  assert.equal(r.total, 90); // 15 из 20 при весе 20 → −5; «Нет» в завершении (вес 5) → −5
  assert.equal(r.needs_review, false);
  const g = good();
  g.c_gross = { answer: 'yes', explanation: 'Предложил личную карту.', evidence: [{ turn: 7, quote: 'Создайте новую заявку' }] };
  assert.equal(resultOf(CL, validateAnswers(CL, T, g).answers).needs_review, true);
});

/* ---------- подставная оценка ---------- */

test('подставная оценка даёт допустимые ответы с настоящими репликами', () => {
  const { answers } = mockEvaluate(RECORD, CL);
  const v = validateAnswers(CL, T, answers);
  assert.deepEqual(v.problems, []);
  assert.equal(answers.c_contact.answer, 'yes');
  assert.equal(answers.c_identity.answer, 'yes');
  assert.equal(answers.c_identity.evidence[0].turn, 5);
  assert.equal(answers.c_manage.answer, 10);
  assert.equal(answers.c_closing.answer, 'no');
  assert.ok(answers.c_closing.checked_range);
  assert.equal(answers.c_gross.answer, 'no');
  assert.equal(resultOf(CL, v.answers).computable, true);
});

test('подставная оценка работает и после замены критерия и смены шкалы', () => {
  const cl = JSON.parse(JSON.stringify(CL));
  const i = cl.criteria.findIndex((c) => c.key === 'c_empathy');
  cl.criteria[i] = { ...M.blankCriterion('s_flow', { weight: 15, type: 'scale' }), key: 'c_new', name: 'Новый', description: 'Описание нового критерия для ИИ', scale: [{ points: 3, text: 'а' }, { points: 0, text: 'б' }] };
  cl.criteria.find((c) => c.key === 'c_consult').scale = [{ points: 4, text: 'хорошо' }, { points: 2, text: 'средне' }, { points: 0, text: 'плохо' }];
  cl.criteria.find((c) => c.key === 'c_identity').na_allowed = false;
  cl.criteria.find((c) => c.key === 'c_identity').na_condition = '';
  const rec = { transcript: T.filter((t) => !/Личность/.test(t.text)).map((t, k) => ({ ...t, offset_sec: k })) };
  const { answers } = mockEvaluate(rec, cl);
  const v = validateAnswers(cl, rec.transcript, answers);
  const hard = v.problems.filter((p) => p.issues.some((x) => !/нет реплики-доказательства/.test(x)));
  assert.deepEqual(hard, []);
  assert.equal(answers.c_new.answer, 3);
  assert.equal(answers.c_new.confidence, 'low');
  assert.ok([0, 2, 4].includes(answers.c_consult.answer));
  assert.notEqual(answers.c_identity.answer, 'na', 'N/A запрещён — подставная оценка не ставит его');
});

/* ---------- хранение ---------- */

test('оценки хранятся историей, последняя — текущая', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-ev-'));
  const svc = createEvaluationService(new JsonStore(dir));
  const base = { record: RECORD, checklist: CL, checklistRef: { id: 'chat-quality', version: 1 }, source: 'mock', model: 'mock-rules' };
  await svc.save('T:1', { ...base, answers: good() });
  const a2 = good(); a2.c_closing = { answer: 'yes', explanation: 'попрощался', evidence: [{ turn: 8, quote: 'спасибо' }] };
  await svc.save('T:1', { ...base, answers: a2 });
  assert.equal(svc.history('T:1').length, 2);
  assert.equal(svc.latest('T:1').answers.c_closing.answer, 'yes');
  const sum = svc.summary('T:1');
  assert.equal(sum.source, 'mock');
  assert.equal(typeof sum.total, 'number');
  assert.equal(svc.summary('nope'), null);
});

/* ---------- API ---------- */

test('API: оценить диалог (подставная), получить оценку, оценить пачкой; ИИ без ключа — 503', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-ev-http-'));
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
    await call('POST', '/api/import/json', { group_id: 'T', payload: [
      { conversation_id: 'a', channel: 'agent chat', language: 'RU', transcript: T },
      { conversation_id: 'b', channel: 'agent chat', language: 'RU', transcript: T.slice(0, 4) },
    ] });
    const key = encodeURIComponent('T:a');
    assert.equal((await call('GET', `/api/dialogs/${key}/evaluation`)).status, 404);
    const ev = await call('POST', `/api/dialogs/${key}/evaluate`, { mode: 'mock' });
    assert.equal(ev.status, 200);
    assert.equal(ev.json.evaluation.source, 'mock');
    const got = await call('GET', `/api/dialogs/${key}/evaluation`);
    assert.equal(got.status, 200);
    assert.equal(got.json.checklist.version, 1);
    assert.equal(got.json.history.length, 1);
    const ai = await call('POST', `/api/dialogs/${key}/evaluate`, { mode: 'ai' });
    assert.equal(ai.status, 503);
    const batch = await call('POST', '/api/evaluate', { keys: ['T:a', 'T:b', 'T:nope'], mode: 'mock' });
    assert.equal(batch.json.done, 2);
    assert.equal(batch.json.failed.length, 1);
    const list = await call('GET', '/api/dialogs');
    const a = list.json.items.find((x) => x.key === 'T:a');
    assert.equal(a.evaluation.source, 'mock');
    assert.equal(typeof a.evaluation.total, 'number');
    assert.equal((await call('POST', '/api/evaluate', { keys: [] })).status, 400);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ---------- исправления после независимой проверки ---------- */

test('смена типа критерия в редакторе: правило не применяется, грубого нарушения «за вежливость» нет', () => {
  const asFlag = JSON.parse(JSON.stringify(CL));
  const emp = asFlag.criteria.find((c) => c.key === 'c_empathy');
  Object.assign(emp, { type: 'flag', weight: 0, na_allowed: false, na_condition: '' });
  const idn = asFlag.criteria.find((c) => c.key === 'c_needs');
  Object.assign(idn, { type: 'flag', weight: 0, na_allowed: false, na_condition: '' }); // правило дало бы N/A
  const short = { transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Я хочу узнать подробно про тарифы для брокерского счёта, какие есть варианты' },
    { timestamp: '00:10', speaker: 'operator', text: 'Здравствуйте, меня зовут Ая. Спасибо за вопрос, тарифов три.' },
  ] };
  const a = mockEvaluate(short, asFlag).answers;
  assert.equal(a.c_empathy.answer, 'no');
  assert.equal(a.c_needs.answer, 'no');
  const r = resultOf(asFlag, validateAnswers(asFlag, short.transcript, a).answers);
  assert.equal(r.gross_flagged, false);

  const asScale = JSON.parse(JSON.stringify(CL));
  Object.assign(asScale.criteria.find((c) => c.key === 'c_empathy'), { type: 'scale', scale: [{ points: 10, text: 'да' }, { points: 0, text: 'нет' }] });
  const v = validateAnswers(asScale, T, mockEvaluate(RECORD, asScale).answers);
  assert.deepEqual(v.problems.filter((p) => p.key === 'c_empathy' && p.issues.some((x) => /ступень/.test(x))), []);
  assert.equal(resultOf(asScale, v.answers).computable, true);
});

test('смена шкалы: «Управление диалогом» (0–10) переводится в новую шкалу по своей вершине', () => {
  const cl = JSON.parse(JSON.stringify(CL));
  const m = cl.criteria.find((c) => c.key === 'c_manage');
  m.scale = [{ points: 5, text: 'хорошо' }, { points: 0, text: 'плохо' }];
  assert.equal(mockEvaluate(RECORD, cl).answers.c_manage.answer, 5); // было 10 из 10 → 5 из 5, а не 0
  m.scale = [{ points: 10, text: 'а' }, { points: 5, text: 'б' }, { points: 0, text: 'в' }];
  const gap = { transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Вопрос' },
    { timestamp: '00:10', speaker: 'operator', text: 'Добрый день' },
    { timestamp: '05:00', speaker: 'operator', text: 'Ответ' },
  ].map((t, i) => ({ ...t, offset_sec: [0, 10, 300][i] })) };
  assert.equal(mockEvaluate(gap, cl).answers.c_manage.answer, 5); // 7 из 10 → ближайшая снизу 5, а не 0
});

test('приветствие «чем могу помочь?» не считается уточнением; длинная цитата режется по слову', () => {
  const long = 'Здравствуйте! Тариф называется Свободный, комиссия ноль целых одна десятая процента за сделку, обслуживание бесплатно';
  const rec = { transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Тариф?' },
    { timestamp: '00:05', speaker: 'operator', text: 'Здравствуйте! Чем могу помочь?' },
    { timestamp: '00:10', speaker: 'operator', text: long },
    { timestamp: '00:20', speaker: 'operator', text: 'Всего доброго!' },
  ] };
  const a = mockEvaluate(rec, CL).answers;
  assert.notEqual(a.c_needs.answer, 'yes');
  const q = a.c_consult.evidence[0].quote;
  assert.ok(q.length <= 90 && long.startsWith(q) && long[q.length] === ' ', 'обрезано на границе слова: ' + q);
  assert.deepEqual(validateAnswers(CL, rec.transcript, a).problems.filter((p) => p.issues.some((x) => /цитаты нет/.test(x))), []);
});

test('удалённый чек-лист: скрыт из списка, но прежние оценки по нему открываются', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-ev-del-'));
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
    const copy = (await call('POST', '/api/checklists', { from: 'chat-quality' })).json;
    const key = encodeURIComponent('T:a');
    assert.equal((await call('POST', `/api/dialogs/${key}/evaluate`, { mode: 'mock', checklist_id: copy.id })).status, 200);
    assert.equal((await call('DELETE', `/api/checklists/${copy.id}`)).status, 200);
    const list = (await call('GET', '/api/checklists')).json.items;
    assert.ok(!list.some((x) => x.id === copy.id), 'удалённый не показывается в списке');
    assert.equal((await call('GET', `/api/checklists/${copy.id}`)).status, 404);
    assert.equal((await call('DELETE', `/api/checklists/${copy.id}`)).status, 404);
    assert.equal((await call('POST', `/api/dialogs/${key}/evaluate`, { mode: 'mock', checklist_id: copy.id })).status, 404);
    const got = await call('GET', `/api/dialogs/${key}/evaluation`);
    assert.equal(got.status, 200);
    assert.equal(got.json.checklist.id, copy.id);
    assert.equal(got.json.checklist.deleted, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
