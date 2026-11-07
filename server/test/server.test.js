'use strict';

/* Проверки HTTP-сервера: защита от чужих сайтов, ошибки запросов, лимит размера. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer } = require('../server');

let server;
let port;

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-http-'));
  // orgApiUrl указывает в никуда: эти тесты не ходят к организаторам.
  server = createServer({ dataDir, orgApiUrl: 'http://127.0.0.1:9/none', allowedOrigins: ['https://crm.example.com'] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

test.after(() => new Promise((r) => server.close(r)));

/** Низкоуровневый запрос, чтобы видеть ровно то, что отдал сервер. */
function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* не JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

test('сайт и API отвечают', async () => {
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>CQA/);
  const health = await request('GET', '/api/health');
  assert.deepEqual(health.json, { ok: true, dialogs: 0 });
});

test('чужой сайт не может читать и писать', async () => {
  const read = await request('GET', '/api/dialogs', { headers: { Origin: 'http://evil.example' } });
  assert.equal(read.status, 403);
  assert.equal(read.headers['access-control-allow-origin'], undefined);
  const write = await request('POST', '/api/import/text', { headers: { ...JSON_HEADERS, Origin: 'http://evil.example' }, body: JSON.stringify({ text: '00:01 client: hi' }) });
  assert.equal(write.status, 403);
});

test('тот же адрес и разрешённый адрес (Dynamics) работают', async () => {
  const same = await request('GET', '/api/dialogs', { headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(same.status, 200);
  const crm = await request('GET', '/api/dialogs', { headers: { Origin: 'https://crm.example.com' } });
  assert.equal(crm.status, 200);
  assert.equal(crm.headers['access-control-allow-origin'], 'https://crm.example.com');
});

test('POST без application/json отклоняется (нет «простых» запросов в обход CORS)', async () => {
  const r = await request('POST', '/api/import/text', { headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ text: '00:01 client: hi' }) });
  assert.equal(r.status, 415);
});

test('тело null или массив — понятная ошибка 400, а не 500', async () => {
  for (const body of ['null', '[]', '5']) {
    const r = await request('POST', '/api/import/text', { headers: JSON_HEADERS, body });
    assert.equal(r.status, 400, body);
    assert.match(r.json.error, /JSON-объектом/);
  }
  const bad = await request('POST', '/api/import/text', { headers: JSON_HEADERS, body: '{oops' });
  assert.equal(bad.status, 400);
});

test('слишком большой файл — ответ 413 доходит до клиента', async () => {
  const big = '{"payload":"' + 'x'.repeat(31 * 1024 * 1024) + '"}';
  const r = await request('POST', '/api/import/json', { headers: JSON_HEADERS, body: big });
  assert.equal(r.status, 413);
  assert.match(r.json.error, /слишком большой/);
});

test('кривой ключ диалога и служебные имена — 404', async () => {
  assert.equal((await request('GET', '/api/dialogs/%E0%A4%A')).status, 404);
  assert.equal((await request('GET', '/api/dialogs/__proto__')).status, 404);
  assert.equal((await request('GET', '/api/dialogs/constructor')).status, 404);
});

test('неверный код набора — 400 с понятным текстом', async () => {
  const r = await request('POST', '/api/import/preview', { headers: JSON_HEADERS, body: JSON.stringify({ group_id: 'DEV&sig=1' }) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /латинские буквы/);
});

test('API организаторов недоступен — 502 с понятным текстом', async () => {
  const r = await request('POST', '/api/import/preview', { headers: JSON_HEADERS, body: JSON.stringify({ group_id: 'dev' }) });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /Не удалось связаться с API организаторов/);
});

test('импорт текста и JSON через HTTP, повтор номера — 409', async () => {
  const t = await request('POST', '/api/import/text', { headers: JSON_HEADERS, body: JSON.stringify({ text: '00:01 client: Сәлем', conversation_id: 'kz-1' }) });
  assert.equal(t.status, 200);
  assert.equal(t.json.by_language.KZ, 1);
  const again = await request('POST', '/api/import/text', { headers: JSON_HEADERS, body: JSON.stringify({ text: '00:01 client: x', conversation_id: 'kz-1' }) });
  assert.equal(again.status, 409);

  const j = await request('POST', '/api/import/json', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ group_id: 'ctrl', payload: [{ conversation_id: 'c1', channel: 'agent chat', language: 'RU', transcript: [{ timestamp: '00:01', speaker: 'client', text: 'привет' }] }] }),
  });
  assert.equal(j.status, 200);
  assert.equal(j.json.group_id, 'CTRL');
  const one = await request('GET', '/api/dialogs/' + encodeURIComponent('CTRL:c1'));
  assert.equal(one.status, 200);
  assert.equal(one.json.transcript[0].text, 'привет');
});

test('чужие пути к файлам за пределами сайта закрыты', async () => {
  const r = await request('GET', '/..%2f..%2fpackage.json');
  assert.ok(r.status === 403 || r.status === 404, String(r.status));
  assert.doesNotMatch(r.text, /cqa-hackathon/);
});
