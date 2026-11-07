'use strict';

/* Записи звонков: скачивание (сеть подменена), отдача с перемоткой, формула «реплика → позиция в записи». */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { JsonStore } = require('../lib/store');
const { createDialogService } = require('../lib/dialogs');
const { createAudioService, extractAudioSrc, looksLikeAudio } = require('../lib/audio');
const { createServer } = require('../server');
const TL = require('../../frontend/js/timeline');

// «mp3»: кадр-заголовок + данные, 4000 байт
const MP3 = Buffer.concat([Buffer.from([0xff, 0xf3, 0x88, 0xc4]), Buffer.alloc(3996, 7)]);
const TEST_HOSTS = ['org.example', '*.example.org'];
const PLAYER_HTML = '<html><audio controls><source src="https://cdn.example.org/rec.mp3?sig=a&amp;sp=r" type="audio/mpeg"></audio></html>';

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    const r = routes[u];
    if (!r) return new Response('not found', { status: 404 });
    if (r instanceof Error) throw r;
    if (r.redirect) return new Response(null, { status: 302, headers: { location: r.redirect } });
    return new Response(r.body, { status: 200, headers: { 'content-type': r.type } });
  };
  impl.calls = calls;
  return impl;
}

const CALL = (id, audioUrl) => ({
  conversation_id: id, channel: 'voice call', language: 'RU', audio_url: audioUrl,
  transcript: [{ timestamp: '2026-11-03T15:49:13.1900670+00:00', speaker: 'client', text: 'Алло' }],
});

async function setup(routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-audio-'));
  const store = new JsonStore(dir);
  const dialogs = createDialogService(store);
  const fetchImpl = fakeFetch(routes);
  const audio = createAudioService({ store, dialogs, dir: path.join(dir, 'audio'), fetchImpl, allowedHosts: TEST_HOSTS });
  return { dir, store, dialogs, audio, fetchImpl };
}

/* ---------- разбор страницы плеера ---------- */

test('ссылка на звук достаётся со страницы плеера организаторов', () => {
  assert.equal(extractAudioSrc(PLAYER_HTML, 'https://org.example/'), 'https://cdn.example.org/rec.mp3?sig=a&sp=r');
  assert.equal(extractAudioSrc('<audio src="/a.mp3"></audio>', 'https://org.example/x'), 'https://org.example/a.mp3');
  assert.equal(extractAudioSrc('<p>нет плеера</p>', 'https://org.example/'), null);
  assert.equal(extractAudioSrc('<source src="javascript:alert(1)">', 'https://org.example/'), null);
});

test('звук распознаётся по типу и по первым байтам', () => {
  assert.ok(looksLikeAudio(MP3, ''));
  assert.ok(looksLikeAudio(Buffer.from('ID3....'), ''));
  assert.ok(looksLikeAudio(Buffer.from('x'), 'audio/mpeg'));
  assert.ok(!looksLikeAudio(Buffer.from('<html>'), 'text/html'));
});

/* ---------- скачивание ---------- */

test('скачивание через страницу плеера, файл сохраняется, повтор не качает заново', async () => {
  const { dialogs, audio, fetchImpl, dir } = await setup({
    'https://org.example/player/1': { body: PLAYER_HTML, type: 'text/html' },
    'https://cdn.example.org/rec.mp3?sig=a&sp=r': { body: MP3, type: 'audio/mpeg' },
  });
  await dialogs.saveRecords('DEV', [CALL('c1', 'https://org.example/player/1')], 'api');
  assert.equal(audio.status('DEV:c1').state, 'missing');

  const st = await audio.ensure('DEV:c1');
  assert.equal(st.state, 'ready');
  assert.equal(st.bytes, MP3.length);
  assert.deepEqual(fs.readFileSync(audio.filePath('DEV:c1')), MP3);
  assert.equal(fs.readdirSync(path.join(dir, 'audio')).filter((f) => f.endsWith('.tmp')).length, 0);

  await audio.ensure('DEV:c1');
  assert.equal(fetchImpl.calls.length, 2, 'второй раз сеть не нужна');
});

test('ссылка сразу на mp3 тоже работает', async () => {
  const { dialogs, audio } = await setup({ 'https://org.example/direct.mp3': { body: MP3, type: 'audio/mpeg' } });
  await dialogs.saveRecords('DEV', [CALL('c2', 'https://org.example/direct.mp3')], 'api');
  assert.equal((await audio.ensure('DEV:c2')).state, 'ready');
});

test('страница без плеера и сбой сети — понятная ошибка и запасная ссылка', async () => {
  const { dialogs, audio } = await setup({
    'https://org.example/changed': { body: '<html>новая страница</html>', type: 'text/html' },
    'https://org.example/down': new TypeError('fetch failed'),
  });
  await dialogs.saveRecords('DEV', [CALL('a', 'https://org.example/changed'), CALL('b', 'https://org.example/down')], 'api');
  const a = await audio.ensure('DEV:a');
  assert.equal(a.state, 'error');
  assert.match(a.error, /не нашлась ссылка на звук/);
  assert.equal(a.fallback_url, 'https://org.example/changed');
  const b = await audio.ensure('DEV:b');
  assert.equal(b.state, 'error');
  assert.match(b.error, /не удалось открыть ссылку/);
});

test('одновременные запросы одной записи качают её один раз', async () => {
  const { dialogs, audio, fetchImpl } = await setup({
    'https://org.example/player/1': { body: PLAYER_HTML, type: 'text/html' },
    'https://cdn.example.org/rec.mp3?sig=a&sp=r': { body: MP3, type: 'audio/mpeg' },
  });
  await dialogs.saveRecords('DEV', [CALL('c1', 'https://org.example/player/1')], 'api');
  const [x, y] = await Promise.all([audio.ensure('DEV:c1'), audio.ensure('DEV:c1')]);
  assert.equal(x.state, 'ready');
  assert.equal(y.state, 'ready');
  assert.equal(fetchImpl.calls.length, 2);
});

test('фоновая очередь скачивает все записи набора; чатам скачивать нечего', async () => {
  const { dialogs, audio } = await setup({
    'https://org.example/p1': { body: MP3, type: 'audio/mpeg' },
    'https://org.example/p2': { body: MP3, type: 'audio/mpeg' },
  });
  const res = await dialogs.saveRecords('DEV', [CALL('c1', 'https://org.example/p1'), CALL('c2', 'https://org.example/p2'),
    { conversation_id: 'chat', channel: 'agent chat', language: 'RU', audio_url: null, transcript: [{ timestamp: '00:01', speaker: 'client', text: 'hi' }] }], 'api');
  assert.equal(audio.enqueue(res.keys), 2);
  await audio.idle();
  assert.equal(audio.status('DEV:c1').state, 'ready');
  assert.equal(audio.status('DEV:c2').state, 'ready');
  assert.equal(audio.status('DEV:chat').state, 'none');
});

/* ---------- HTTP: отдача файла с перемоткой ---------- */

test('файл записи отдаётся целиком и частями (Range) — перемотка в плеере работает', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-audio-http-'));
  const fetchImpl = fakeFetch({ 'https://org.example/p1': { body: MP3, type: 'audio/mpeg' } });
  const server = createServer({ dataDir, orgApiUrl: 'http://127.0.0.1:9/none', allowedOrigins: [], fetchImpl, audioAllowedHosts: TEST_HOSTS });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const post = (p) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(p.includes('import') ? { payload: [CALL('c1', 'https://org.example/p1')], group_id: 'DEV' } : {}));
  });

  try {
    const imp = await post('/api/import/json');
    assert.equal(imp.status, 200);
    assert.equal(imp.json.audio_queued, 1);
    const key = encodeURIComponent('DEV:c1');
    const fetched = await post(`/api/dialogs/${key}/audio/fetch`);
    assert.equal(fetched.json.state, 'ready');

    const full = await get(`/api/dialogs/${key}/audio`);
    assert.equal(full.status, 200);
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.headers['content-type'], 'audio/mpeg');
    assert.equal(full.body.length, MP3.length);

    const part = await get(`/api/dialogs/${key}/audio`, { Range: 'bytes=100-199' });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], `bytes 100-199/${MP3.length}`);
    assert.deepEqual(part.body, MP3.subarray(100, 200));

    const tail = await get(`/api/dialogs/${key}/audio`, { Range: 'bytes=-10' });
    assert.equal(tail.status, 206);
    assert.equal(tail.body.length, 10);

    const bad = await get(`/api/dialogs/${key}/audio`, { Range: 'bytes=999999-' });
    assert.equal(bad.status, 416);

    const st = await get(`/api/dialogs/${key}/audio/status`);
    assert.equal(JSON.parse(st.body).state, 'ready');
    assert.equal((await get('/api/dialogs/nope/audio')).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ---------- формула времени (см. frontend/js/timeline.js) ---------- */

function call(turns) { return turns.map(([t, speaker, text]) => ({ offset_sec: t, speaker, text })); }

test('системные события распознаются на трёх языках', () => {
  assert.equal(TL.classifySystem('Личность клиента подтверждена.').type, 'identity');
  assert.equal(TL.classifySystem('Клиенттің жеке басы расталды.').type, 'identity');
  assert.equal(TL.classifySystem('Customer identity verified.').type, 'identity');
  assert.equal(TL.classifySystem('Чат операторға жіберілді.').type, 'escalation');
  assert.equal(TL.classifySystem('Клиент больше не находится на удержании.').type, 'unhold');
  assert.equal(TL.classifySystem('Клиент находится на удержании.').type, 'hold');
  assert.equal(TL.classifySystem('Жазу және транскрипция басталды.').type, 'record-start');
  assert.equal(TL.classifySystem('Запись и транскрибирование приостановлены.').type, 'record-pause');
  assert.equal(TL.classifySystem('что-то другое'), null);
});

test('после паузы записи позиция сдвигается на (длина паузы − 5 с)', () => {
  const m = TL.buildAudioMap(call([
    [0, 'system', 'Запись и транскрибирование запущены.'],
    [20, 'bot', 'Здравствуйте, добро пожаловать'],
    [56.3, 'system', 'Запись и транскрибирование приостановлены.'],
    [70.9, 'system', 'Запись и транскрибирование возобновлены.'],
    [80, 'operator', 'Добрый день, меня зовут Ерлан'],
  ]));
  assert.equal(m.toAudio(20), 20);
  assert.ok(Math.abs(m.toAudio(80) - (80 - (70.9 - 56.3 - 5))) < 1e-9);
  // метка — конец фразы, начало раньше
  const s = m.spans[4];
  assert.ok(s.end < m.toAudio(80) && s.start < s.end);
  assert.equal(m.spans[0], null, 'системные события — без отрезка');
  assert.deepEqual(m.zones().map((z) => z.type), ['pause']);
});

test('ноль записи — событие «Запись запущена»; фразы до него не на дорожке', () => {
  const m = TL.buildAudioMap(call([
    [0, 'operator', 'реплика до записи'],
    [30.2, 'system', 'Запись и транскрибирование запущены.'],
    [40, 'client', 'Здравствуйте'],
  ]));
  assert.equal(m.t0, 30.2);
  assert.equal(m.spans[0], null);
  assert.ok(Math.abs(m.toAudio(40) - 9.8) < 1e-9);
});

test('удержание из записи не вырезается, но показывается зоной', () => {
  const m = TL.buildAudioMap(call([
    [0, 'client', 'алло'],
    [100, 'system', 'Клиент находится на удержании.'],
    [400, 'system', 'Клиент больше не находится на удержании.'],
    [410, 'operator', 'Спасибо за ожидание'],
  ]));
  assert.equal(m.toAudio(410), 410);
  assert.deepEqual(m.zones().map((z) => [z.type, z.start, z.end]), [['hold', 100, 400]]);
});

test('поиск реплики, которая звучит в момент времени', () => {
  const m = TL.buildAudioMap(call([[5, 'client', 'Добрый день'], [12, 'operator', 'Здравствуйте, чем помочь?']]));
  const mid = (m.spans[1].start + m.spans[1].end) / 2;
  assert.equal(TL.findTurnAt(m.spans, mid), 1);
  assert.equal(TL.findTurnAt(m.spans, 999), -1);
});

test('автоподстройка находит сдвиг, при котором реплики совпадают с речью', () => {
  const turns = [];
  for (let i = 0; i < 30; i++) turns.push({ offset_sec: 5 + i * 7, speaker: i % 2 ? 'operator' : 'client', text: 'фраза номер ' + i });
  // «настоящие» концы речи на 1,5 с раньше меток (базовое правило знает только про 0,7 с)
  const ends = turns.map((t) => t.offset_sec - 1.5);
  const res = TL.bestShift(turns, ends);
  assert.ok(Math.abs(res.shift - (-0.8)) <= 0.2, 'shift=' + res.shift);
  assert.ok(res.after > res.before);
  // если всё и так совпадает — поправки нет
  assert.equal(TL.bestShift(turns, turns.map((t) => t.offset_sec - 0.7)).shift, 0);
});

test('концы речи находятся по громкости', () => {
  const sr = 8000;
  const samples = new Float32Array(sr * 6); // 6 с: речь 1–2 с и 3.5–5 с
  for (let i = 0; i < samples.length; i++) {
    const t = i / sr;
    if ((t >= 1 && t < 2) || (t >= 3.5 && t < 5)) samples[i] = 0.3 * Math.sin(i / 3);
    else samples[i] = 0.0005 * Math.sin(i);
  }
  const ends = TL.detectSpeechEnds(samples, sr);
  assert.equal(ends.length, 2);
  assert.ok(Math.abs(ends[0] - 2) < 0.1 && Math.abs(ends[1] - 5) < 0.1, String(ends));
});

/* ---------- исправления после проверки кода ---------- */

test('чужие домены и http не скачиваются (защита от запросов во внутреннюю сеть)', async () => {
  const { dialogs, audio, fetchImpl } = await setup({
    'https://org.example/to-evil': { redirect: 'https://169.254.169.254/latest/meta-data' },
  });
  await dialogs.saveRecords('F', [CALL('a', 'http://127.0.0.1:3000/api/dialogs'), CALL('b', 'https://evil.example.com/x.mp3'), CALL('c', 'https://org.example/to-evil')], 'file');
  for (const k of ['F:a', 'F:b', 'F:c']) {
    const st = await audio.ensure(k);
    assert.equal(st.state, 'error', k);
    assert.match(st.error, /разрешённых доменов/, k);
  }
  assert.ok(!fetchImpl.calls.some((u) => u.includes('127.0.0.1') || u.includes('169.254') || u.includes('evil.example.com')), 'запросы на чужие адреса не уходили');
});

test('переадресация внутри разрешённых доменов работает', async () => {
  const { dialogs, audio } = await setup({
    'https://org.example/r': { redirect: 'https://cdn.example.org/rec.mp3?sig=a&sp=r' },
    'https://cdn.example.org/rec.mp3?sig=a&sp=r': { body: MP3, type: 'audio/mpeg' },
  });
  await dialogs.saveRecords('DEV', [CALL('r', 'https://org.example/r')], 'api');
  assert.equal((await audio.ensure('DEV:r')).state, 'ready');
});

test('слишком большой поток без Content-Length обрывается во время чтения', async () => {
  let produced = 0;
  const huge = new ReadableStream({
    pull(ctrl) { const chunk = new Uint8Array(1024 * 1024).fill(0xff); produced += chunk.length; ctrl.enqueue(chunk); },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-audio-big-'));
  const store = new JsonStore(dir);
  const dialogs = createDialogService(store);
  const audio = createAudioService({
    store, dialogs, dir: path.join(dir, 'audio'), allowedHosts: TEST_HOSTS,
    fetchImpl: async () => new Response(huge, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
  });
  await dialogs.saveRecords('DEV', [CALL('big', 'https://org.example/big')], 'api');
  const st = await audio.ensure('DEV:big');
  assert.equal(st.state, 'error');
  assert.match(st.error, /больше 100 МБ/);
  assert.ok(produced < 110 * 1024 * 1024, 'прочитали не больше лимита: ' + produced);
});

test('одновременные загрузки разных записей обе попадают в audio.json', async () => {
  const { dialogs, audio, dir } = await setup({
    'https://org.example/a': { body: MP3, type: 'audio/mpeg' },
    'https://org.example/b': { body: MP3, type: 'audio/mpeg' },
  });
  await dialogs.saveRecords('DEV', [CALL('a', 'https://org.example/a'), CALL('b', 'https://org.example/b')], 'api');
  const [x, y] = await Promise.all([audio.ensure('DEV:a'), audio.ensure('DEV:b')]);
  assert.equal(x.state, 'ready');
  assert.equal(y.state, 'ready');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'audio.json'), 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), ['DEV:a', 'DEV:b']);
});

test('HEAD и непонятный Range: заголовки без тела / файл целиком', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-audio-head-'));
  const server = createServer({
    dataDir, orgApiUrl: 'http://127.0.0.1:9/none', allowedOrigins: [], autoDownloadAudio: false, audioAllowedHosts: TEST_HOSTS,
    fetchImpl: fakeFetch({ 'https://org.example/p1': { body: MP3, type: 'audio/mpeg' } }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (method, p, headers = {}, body) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    rq.on('error', reject);
    if (body) rq.write(body);
    rq.end();
  });
  try {
    await req('POST', '/api/import/json', { 'Content-Type': 'application/json' }, JSON.stringify({ group_id: 'DEV', payload: [CALL('c1', 'https://org.example/p1')] }));
    const key = encodeURIComponent('DEV:c1');
    await req('POST', `/api/dialogs/${key}/audio/fetch`, { 'Content-Type': 'application/json' }, '{}');
    const head = await req('HEAD', `/api/dialogs/${key}/audio`);
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers['content-length']), MP3.length);
    assert.equal(head.body.length, 0);
    const multi = await req('GET', `/api/dialogs/${key}/audio`, { Range: 'bytes=0-1,5-9' });
    assert.equal(multi.status, 200);
    assert.equal(multi.body.length, MP3.length);
    const junk = await req('GET', `/api/dialogs/${key}/audio`, { Range: 'items=1-2' });
    assert.equal(junk.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('прерванная загрузка файла записи не оставляет открытых файлов', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-audio-abort-'));
  const big = Buffer.concat([Buffer.from([0xff, 0xf3, 0x88, 0xc4]), Buffer.alloc(8 * 1024 * 1024, 1)]);
  const server = createServer({
    dataDir, orgApiUrl: 'http://127.0.0.1:9/none', allowedOrigins: [], autoDownloadAudio: false, audioAllowedHosts: TEST_HOSTS,
    fetchImpl: fakeFetch({ 'https://org.example/big': { body: big, type: 'audio/mpeg' } }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (p, body) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
    rq.on('error', reject); rq.end(body);
  });
  const opened = [];
  const origCreate = fs.createReadStream;
  fs.createReadStream = function (...args) { const s = origCreate.apply(this, args); opened.push(s); return s; };
  try {
    await post('/api/import/json', JSON.stringify({ group_id: 'DEV', payload: [CALL('b', 'https://org.example/big')] }));
    await post(`/api/dialogs/${encodeURIComponent('DEV:b')}/audio/fetch`, '{}');
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => {
        const rq = http.get({ host: '127.0.0.1', port, path: `/api/dialogs/${encodeURIComponent('DEV:b')}/audio`, headers: { Range: 'bytes=0-' } }, (res) => {
          res.once('data', () => { rq.destroy(); setTimeout(resolve, 50); });
        });
        rq.on('error', () => {});
      });
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(opened.length, 5);
    assert.ok(opened.every((s) => s.destroyed), 'все потоки закрыты');
  } finally {
    fs.createReadStream = origCreate;
    await new Promise((r) => server.close(r));
  }
});

test('длинная реплика не сжимается из-за короткой реплики собеседника', () => {
  const m = TL.buildAudioMap([
    { offset_sec: 10, speaker: 'operator', text: 'Добрый день' },
    { offset_sec: 59, speaker: 'client', text: 'Угу' },
    { offset_sec: 60, speaker: 'operator', text: 'а'.repeat(260) }, // ~20 с речи
  ]);
  const s = m.spans[2];
  assert.ok(s.end - s.start > 15, 'длительность ' + (s.end - s.start));
});

test('у звонков берутся доли секунды из исходной метки, а не округлённое offset_sec', () => {
  const offs = TL.exactOffsets([
    { timestamp: '2026-11-03T15:49:13.1900670+00:00', offset_sec: 0 },
    { timestamp: '2026-11-03T15:49:22.4171535+00:00', offset_sec: 9 },
  ]);
  assert.ok(Math.abs(offs[1] - 9.227) < 1e-6, String(offs[1]));
  assert.deepEqual(TL.exactOffsets([{ timestamp: '00:05', offset_sec: 5 }]), [5]);
});

test('начало реплики привязывается к ближайшему началу речи', () => {
  const turns = [{ offset_sec: 20, speaker: 'client', text: 'Здравствуйте, у меня вопрос' }];
  const plain = TL.buildAudioMap(turns).spans[0];
  const snapped = TL.buildAudioMap(turns, { onsets: [plain.start + 0.8] }).spans[0];
  assert.ok(Math.abs(snapped.start - (plain.start + 0.8)) < 1e-9);
  const far = TL.buildAudioMap(turns, { onsets: [plain.start + 5] }).spans[0];
  assert.ok(Math.abs(far.start - plain.start) < 1e-9, 'дальше 1,5 с — не привязываем');
});

test('казахские системные события звонка', () => {
  assert.equal(TL.classifySystem('Жазу және транскрипция тоқтатылды.').type, 'record-pause');
  assert.equal(TL.classifySystem('Жазу және транскрипция жалғастырылды.').type, 'record-resume');
  assert.equal(TL.classifySystem('Клиент ұстауға қойылды.').type, 'hold');
  assert.equal(TL.classifySystem('Агент әңгімеге қосылды.').type, 'join');
  // слово «тоқтатылды» без «жазу» — не пауза записи
  assert.notEqual((TL.classifySystem('Төлем тоқтатылды') || {}).type, 'record-pause');
});
