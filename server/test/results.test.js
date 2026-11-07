'use strict';

/* Выгрузка результатов в формате организаторов (results/<dev|prod>/results.json, JSON 1.0). */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const M = require('../../frontend/js/checklist-model');
const CL = M.normalize(require('../defaults/checklist-chat'));
const { validateAnswers } = require('../lib/evaluations');
const R = require('../lib/results');
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
const RECORD = { key: 'T:1', conversation_id: 'p1-ru-001', transcript: T };

const ANSWERS = validateAnswers(CL, T, {
  c_contact: { answer: 'yes', explanation: 'Поздоровался и назвал имя.', evidence: [{ turn: 3, quote: 'Меня зовут Айгерим' }] },
  c_needs: { answer: 'na', explanation: 'Данных хватало.', na_reason: 'Данных для ответа хватало с самого начала.', evidence: [] },
  c_identity: { answer: 'yes', explanation: 'Личность подтверждена.', evidence: [{ turn: 5, quote: 'Личность клиента подтверждена' }] },
  c_consult: { answer: 15, explanation: 'Решено, без деталей.', evidence: [{ turn: 7, quote: 'Создайте новую заявку' }, { turn: 7, quote: 'деньги придут за день' }] },
  c_empathy: { answer: 'yes', explanation: 'Вежлив.', evidence: [{ turn: 6, quote: 'Спасибо' }] },
  c_manage: { answer: 7, explanation: 'Один сбой.', evidence: [{ turn: 6, quote: 'это займёт пару минут' }] },
  c_closing: { answer: 'no', explanation: 'Не попрощался.', evidence: [], checked_range: { from: 8, to: 9 } },
  c_gross: { answer: 'no', explanation: 'Нарушений нет.', evidence: [] },
}).answers;
const EVAL = { id: 'ev_1', source: 'ai', model: 'deepseek/deepseek-v4.1-flash-1017', checklist: { id: 'chat-quality', version: 1 }, answers: ANSWERS };

test('коды критериев: ключи по умолчанию → коды организаторов', () => {
  assert.deepEqual(R.criterionIds(CL), {
    c_contact: 'contact', c_needs: 'discovery', c_identity: 'identification', c_consult: 'consultation',
    c_empathy: 'empathy', c_manage: 'dialogue', c_closing: 'closure', c_gross: 'critical',
  });
});

test('коды критериев: заменённый критерий получает код того места, которое занял', () => {
  const cl = JSON.parse(JSON.stringify(CL));
  const i = cl.criteria.findIndex((c) => c.key === 'c_closing');
  cl.criteria[i] = { ...cl.criteria[i], key: 'c_ab12cd34', name: 'Новый критерий' };
  assert.equal(R.criterionIds(cl).c_ab12cd34, 'closure');
  assert.equal(new Set(Object.values(R.criterionIds(cl))).size, 8, 'коды не повторяются');
});

test('значения: Да/Нет/N/A/ступень → true/false/null/число; номера реплик без повторов, «Нет» без цитат — участок', () => {
  assert.equal(R.toValue('yes'), true);
  assert.equal(R.toValue('no'), false);
  assert.equal(R.toValue('na'), null);
  assert.equal(R.toValue(15), 15);
  assert.equal(R.toValue(null), undefined);
  const e = R.buildEntry(RECORD, EVAL, CL, []);
  const by = Object.fromEntries(e.criteria.map((c) => [c.criterion_id, c]));
  assert.deepEqual(by.consultation.evidence_turns, [7]);
  assert.deepEqual(by.closure.evidence_turns, [8, 9]);
  assert.equal(by.discovery.value, null);
  assert.equal(by.discovery.rationale, 'Данных хватало.');
  assert.deepEqual(by.critical.evidence_turns, [3, 6, 7], '«нарушений нет» без цитат — все реплики оператора');
});

test('запись: итог по правилам чек-листа (N/A перераспределяет вес), флаг грубой ошибки', () => {
  const e = R.buildEntry(RECORD, EVAL, CL, []);
  assert.equal(e.status, 'ok');
  assert.equal(e.criteria.length, 8);
  // применимо 85: 10 + 20 + 15 + 15 + 10.5 + 0 = 70.5 → 70.5 / 85 × 100 = 82.94
  assert.equal(e.score.final_score, 82.94);
  assert.equal(e.score.critical_flag, false);
  assert.deepEqual(R.validateResults({ schema_version: '1.0', team_name: 'X', model: { mode: 'external_api', name: 'm' }, results: [e] }), []);
});

test('запись: решённая апелляция «Изменено» меняет ответ, обоснование и итог; «Оставлено» — нет', () => {
  const appeals = [
    { criterion_key: 'c_closing', status: 'changed', decision: { new_value: 'yes', reason: 'Прощание было' } },
    { criterion_key: 'c_manage', status: 'kept', decision: { new_value: null, reason: 'Верно' } },
  ];
  const e = R.buildEntry(RECORD, EVAL, CL, appeals);
  const by = Object.fromEntries(e.criteria.map((c) => [c.criterion_id, c]));
  assert.equal(by.closure.value, true);
  assert.match(by.closure.rationale, /^Изменено по апелляции: Прощание было/);
  assert.equal(by.dialogue.value, 7);
  assert.equal(e.score.final_score, 88.82);
});

test('ошибки: не оценён, нет чек-листа, нет ответа — status "error", пустые criteria, score null', () => {
  const a = R.buildEntry(RECORD, null, null, []);
  assert.deepEqual(a, { conversation_id: 'p1-ru-001', status: 'error', criteria: [], score: null, error: 'Диалог не оценён.' });
  assert.equal(R.buildEntry(RECORD, EVAL, null, []).status, 'error');
  const broken = { ...EVAL, answers: { ...ANSWERS, c_empathy: { ...ANSWERS.c_empathy, answer: null } } };
  const b = R.buildEntry({ ...RECORD, conversation_id: 'p1-ru-002' }, broken, CL, []);
  assert.equal(b.status, 'error');
  assert.match(b.error, /Эмпатия/);
  assert.deepEqual(R.validateResults({ schema_version: '1.0', team_name: 'X', model: { mode: 'external_api', name: 'm' }, results: [a, b] }), []);
});

test('model: только ИИ — external_api, с подставной — hybrid, только подставная — local', () => {
  assert.deepEqual(R.modelInfo([EVAL, EVAL]), { mode: 'external_api', name: 'deepseek/deepseek-v4.1-flash-1017' });
  assert.equal(R.modelInfo([EVAL, { source: 'mock' }]).mode, 'hybrid');
  assert.equal(R.modelInfo([{ source: 'mock' }]).mode, 'local');
  assert.equal(R.modelInfo([null], 'x/y').name, 'x/y');
});

test('проверка формата: повтор ID, число записей prod, лишний критерий, неверное значение, флаг не совпадает', () => {
  const ok = R.buildEntry(RECORD, EVAL, CL, []);
  const doc = (results) => ({ schema_version: '1.0', team_name: 'X', model: { mode: 'external_api', name: 'm' }, results });
  assert.ok(R.validateResults(doc([ok, ok])).some((p) => /повторяется/.test(p)));
  assert.ok(R.validateResults(doc([ok]), { expectedCount: 10 }).some((p) => /должно быть 10/.test(p)));
  const badValue = JSON.parse(JSON.stringify(ok));
  badValue.criteria.find((c) => c.criterion_id === 'dialogue').value = 5;
  assert.ok(R.validateResults(doc([badValue])).some((p) => /dialogue: недопустимое значение 5/.test(p)));
  const badFlag = JSON.parse(JSON.stringify(ok));
  badFlag.score.critical_flag = true;
  assert.ok(R.validateResults(doc([badFlag])).some((p) => /critical_flag не совпадает/.test(p)));
  const noTeam = { ...doc([ok]), team_name: ' ' };
  assert.ok(R.validateResults(noTeam).some((p) => /team_name/.test(p)));
  assert.deepEqual(R.validateResults(doc([badValue]), { strictValues: false }), [], 'после замены критерия типы не сверяются с таблицей');
});

test('API: выгрузка набора пишет results/<папка>/results.json, проверяет формат и предупреждает о неоценённых', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-res-data-'));
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-res-out-'));
  const server = createServer({ dataDir, resultsDir, teamName: 'Команда', orgApiUrl: 'http://127.0.0.1:9/none', allowedOrigins: [], autoDownloadAudio: false, ai: { apiKey: '' } });
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
    assert.equal((await call('POST', '/api/results/export', { group_id: 'CTRL' })).status, 404, 'набор не загружен');
    await call('POST', '/api/import/json', { group_id: 'CTRL', payload: [
      { conversation_id: 'c-1', channel: 'agent chat', language: 'RU', transcript: T },
      { conversation_id: 'c-2', channel: 'agent chat', language: 'RU', transcript: T },
    ] });
    await call('POST', `/api/dialogs/${encodeURIComponent('CTRL:c-1')}/evaluate`, { mode: 'mock' });

    assert.equal((await call('POST', '/api/results/export', { group_id: 'CTRL', target: 'other' })).status, 400);

    const r = await call('POST', '/api/results/export', { group_id: 'CTRL' });
    assert.equal(r.status, 200);
    assert.equal(r.json.target, 'prod', 'не DEV — контрольный набор');
    assert.equal(r.json.file, 'results/prod/results.json');
    assert.equal(r.json.total, 2);
    assert.equal(r.json.errors, 1);
    assert.equal(r.json.team_name, 'Команда');
    assert.ok(r.json.problems.some((p) => /должно быть 10/.test(p)), 'в prod ровно 10 записей');
    assert.ok(r.json.warnings.some((w) => /c-2/.test(w)), 'неоценённый назван');
    assert.ok(r.json.warnings.some((w) => /Подставная/.test(w)));

    const file = JSON.parse(fs.readFileSync(path.join(resultsDir, 'prod', 'results.json'), 'utf8'));
    assert.equal(file.schema_version, '1.0');
    assert.deepEqual(file.results.map((x) => [x.conversation_id, x.status]), [['c-1', 'ok'], ['c-2', 'error']]);
    assert.equal(file.model.mode, 'local');
    assert.equal(fs.readdirSync(path.join(resultsDir, 'prod')).length, 1, 'временный файл не остался');

    const dev = await call('POST', '/api/results/export', { group_id: 'CTRL', target: 'dev', team_name: 'Другая' });
    assert.equal(dev.json.file, 'results/dev/results.json');
    assert.equal(dev.json.team_name, 'Другая');
    assert.ok(!dev.json.problems.some((p) => /должно быть/.test(p)), 'для dev число записей не ограничено');

    const preview = await call('GET', '/api/results?group_id=CTRL');
    assert.equal(preview.status, 200);
    assert.equal(preview.json.document.results.length, 2);
  } finally {
    server.close();
  }
});

/* ---------- статистика (вкладка «Статистика») ---------- */

const { computeStats } = require('../lib/stats');

test('статистика: потери по критериям в сумме = 100 − средний балл; грубые, фильтры, апелляции', () => {
  const gross = { ...ANSWERS, c_gross: { answer: 'yes', explanation: 'Оскорбление.', evidence: [{ turn: 3, quote: 'Меня зовут' }] } };
  const items = [
    { record: { ...RECORD, key: 'T:1', conversation_id: 'a', channel: 'agent chat', language: 'RU' }, evaluation: EVAL, checklist: CL, appeals: [], history: [{ source: 'ai', usage: { cost_usd: 0.004, reused: [] } }] },
    { record: { ...RECORD, key: 'T:2', conversation_id: 'b', channel: 'agent chat', language: 'KZ' }, evaluation: { ...EVAL, answers: gross }, checklist: CL,
      appeals: [{ criterion_key: 'c_closing', status: 'changed', decision: { new_value: 'yes', reason: 'Было' } }], history: [{ source: 'ai', usage: { cost_usd: 0.006, reused: [] } }, { source: 'ai', usage: { cost_usd: 0, reused: ['c_contact'] } }] },
    { record: { ...RECORD, key: 'T:3', conversation_id: 'c', channel: 'voice call', language: 'RU' }, evaluation: null, checklist: null, appeals: [], history: [] },
  ];
  const s = computeStats(items);
  assert.equal(s.total_dialogs, 3);
  assert.equal(s.evaluated, 2);
  assert.equal(s.avg, Math.round(((82.94 + 88.82) / 2) * 100) / 100);
  const lost = s.criteria.filter((c) => c.type !== 'flag').reduce((a, c) => a + c.avg_lost, 0);
  assert.ok(Math.abs(lost - (100 - s.avg)) < 0.05, 'сумма потерь = 100 − средний');
  const closing = s.criteria.find((c) => c.key === 'c_closing');
  assert.deepEqual(closing.counts, { full: 1, partial: 0, zero: 1, na: 0 }, 'апелляция «Изменено» учтена');
  assert.equal(s.criteria.find((c) => c.key === 'c_needs').counts.na, 2);
  assert.equal(s.gross_count, 1);
  assert.deepEqual(s.gross[0].turns, [3]);
  assert.deepEqual(s.appeals, { open: 0, decided: 1, changed: 1 });
  assert.equal(s.cost.per_evaluation_usd, 0.005, 'средняя цена только по полным оценкам');
  assert.equal(s.histogram.reduce((a, b) => a + b.n, 0), 2);
  const kz = computeStats(items, { language: 'KZ' });
  assert.equal(kz.total_dialogs, 1);
  assert.equal(kz.gross_count, 1);
  assert.equal(computeStats(items, { channel: 'voice call' }).evaluated, 0);
});

/* ---------- удаление диалогов ---------- */

test('API: удалить выбранные — диалог, его оценки, апелляции и запись; соседний не трогается', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-del-'));
  const server = createServer({ dataDir, resultsDir: dataDir, orgApiUrl: 'http://127.0.0.1:9/none', allowedOrigins: [], autoDownloadAudio: false, ai: { apiKey: '' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, json: t ? JSON.parse(t) : null }); });
    });
    rq.on('error', reject); if (body !== undefined) rq.write(JSON.stringify(body)); rq.end();
  });
  try {
    await call('POST', '/api/import/json', { group_id: 'X', payload: [
      { conversation_id: 'a', channel: 'agent chat', language: 'RU', transcript: T },
      { conversation_id: 'b', channel: 'agent chat', language: 'RU', transcript: T },
    ] });
    const ka = encodeURIComponent('X:a');
    await call('POST', `/api/dialogs/${ka}/evaluate`, { mode: 'mock' });
    await call('POST', `/api/dialogs/${encodeURIComponent('X:b')}/evaluate`, { mode: 'mock' });
    const ev = (await call('GET', `/api/dialogs/${ka}/evaluation`)).json.evaluation;
    const crit = Object.keys(ev.answers).find((k) => ev.answers[k].answer === 'no');
    assert.equal((await call('POST', `/api/dialogs/${ka}/appeals`, { role: 'analyst', evaluation_id: ev.id, criterion_key: crit, comment: 'не согласен с оценкой' })).status, 200);
    // звонок с записью у нас — файл тоже должен удалиться
    fs.mkdirSync(path.join(dataDir, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'audio', 'X_a.mp3'), 'x');
    fs.writeFileSync(path.join(dataDir, 'audio.json'), JSON.stringify({ 'X:a': { file: 'X_a.mp3', bytes: 1 } }));

    assert.equal((await call('POST', '/api/dialogs/delete', { keys: [] })).status, 400);
    const r = await call('POST', '/api/dialogs/delete', { keys: ['X:a', 'X:nope'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.deleted, 1);
    assert.equal(r.json.not_found, 1);
    assert.equal(r.json.evaluations, 1);
    assert.equal(r.json.appeals, 1);
    assert.equal((await call('GET', `/api/dialogs/${ka}`)).status, 404);
    assert.equal((await call('GET', `/api/dialogs/${ka}/evaluation`)).status, 404);
    assert.equal((await call('GET', '/api/appeals')).json.items.length, 0);
    const left = (await call('GET', '/api/dialogs')).json.items.map((d) => d.key);
    assert.deepEqual(left, ['X:b']);
    assert.equal((await call('GET', `/api/dialogs/${encodeURIComponent('X:b')}/evaluation`)).status, 200, 'соседний диалог и его оценка на месте');
  } finally {
    server.close();
  }
});
