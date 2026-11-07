'use strict';

/* Чек-листы: правила проверки, версии, конфликт правок, API. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const M = require('../../frontend/js/checklist-model');
const DEFAULT = require('../defaults/checklist-chat');
const { JsonStore } = require('../lib/store');
const { createChecklistService } = require('../lib/checklists');
const { createServer } = require('../server');

const clone = (x) => JSON.parse(JSON.stringify(x));
const paths = (r) => r.errors.map((e) => e.path);

/* ---------- модель ---------- */

test('чек-лист из задания: 8 критериев, 4 раздела, сумма весов 100, без ошибок', () => {
  const r = M.validate(DEFAULT);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.normalized.criteria.length, 8);
  assert.equal(r.normalized.sections.length, 4);
  assert.equal(M.weightSummary(r.normalized).total, 100);
  const gross = r.normalized.criteria.find((c) => c.key === 'c_gross');
  assert.equal(gross.type, 'flag');
  assert.equal(gross.weight, 0);
  assert.equal(M.scaleMax(r.normalized.criteria.find((c) => c.key === 'c_consult')), 20);
});

test('проверки: пустые поля, вес, N/A без условия, шкала', () => {
  const cl = clone(DEFAULT);
  cl.name = ' ';
  cl.criteria[0].name = '';
  cl.criteria[0].description = 'коротко';
  cl.criteria[1].weight = 0;
  cl.criteria[2].weight = 12.5;
  cl.criteria[2].na_condition = '';
  const consult = cl.criteria.find((c) => c.key === 'c_consult');
  consult.scale = [{ points: 20, text: 'всё' }, { points: 20, text: 'дубль' }, { points: 5, text: '' }];
  const r = M.validate(cl);
  const p = paths(r);
  assert.ok(p.includes('name'));
  assert.ok(p.includes('criteria.c_contact.name'));
  assert.ok(p.includes('criteria.c_contact.description'));
  assert.ok(p.includes('criteria.c_needs.weight'));
  assert.ok(p.includes('criteria.c_identity.weight'));
  assert.ok(p.includes('criteria.c_identity.na_condition'));
  assert.ok(p.includes('criteria.c_consult.scale.1.points'), 'повтор ступени');
  assert.ok(p.includes('criteria.c_consult.scale.2.text'), 'пустое описание ступени');
  assert.ok(r.errors.every((e) => typeof e.message === 'string' && /[а-я]/i.test(e.message)), 'тексты ошибок по-русски');
});

test('шкала: меньше двух ступеней — ошибка; без нуля — предупреждение', () => {
  const cl = clone(DEFAULT);
  const consult = cl.criteria.find((c) => c.key === 'c_consult');
  consult.scale = [{ points: 20, text: 'всё закрыто' }];
  assert.ok(paths(M.validate(cl)).includes('criteria.c_consult.scale'));
  consult.scale = [{ points: 20, text: 'всё' }, { points: 10, text: 'половина' }];
  const r = M.validate(cl);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.path === 'criteria.c_consult.scale'));
});

test('флаг всегда без баллов и без N/A; должен остаться хотя бы один критерий с баллами', () => {
  const cl = clone(DEFAULT);
  cl.criteria = cl.criteria.filter((c) => c.type === 'flag').map((c) => ({ ...c, weight: 50, na_allowed: true }));
  const r = M.validate(cl);
  assert.equal(r.normalized.criteria[0].weight, 0);
  assert.equal(r.normalized.criteria[0].na_allowed, false);
  assert.ok(paths(r).includes('criteria'));
});

test('сумма весов не 100 — предупреждение, а не ошибка (итог всё равно из 100)', () => {
  const cl = clone(DEFAULT);
  cl.criteria.find((c) => c.key === 'c_closing').weight = 10;
  const r = M.validate(cl);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.path === 'weights' && /105/.test(w.message)));
});

test('шкала сортируется по убыванию, строки обрезаются', () => {
  const n = M.normalize({ name: '  X ', sections: [{ key: 's_a', name: ' A ' }], criteria: [{ key: 'c_a', section: 's_a', name: ' Имя ', type: 'scale', weight: '10', description: 'd', scale: [{ points: '0', text: 'a' }, { points: 10, text: 'b' }] }] });
  assert.equal(n.name, 'X');
  assert.equal(n.criteria[0].weight, 10);
  assert.deepEqual(n.criteria[0].scale.map((s) => s.points), [10, 0]);
});

test('diff описывает изменения понятными фразами', () => {
  const a = clone(DEFAULT);
  const b = clone(DEFAULT);
  b.criteria.find((c) => c.key === 'c_closing').weight = 10;
  b.criteria = b.criteria.filter((c) => c.key !== 'c_empathy');
  b.criteria.splice(4, 0, { ...M.blankCriterion('s_flow'), name: 'Новый критерий', description: 'Да — оператор сделал что-то полезное для клиента.' });
  const d = M.diff(a, b);
  assert.ok(d.some((x) => /Завершение.*вес 5 → 10/.test(x)), d.join('\n'));
  assert.ok(d.some((x) => /Удалён критерий «Эмпатия/.test(x)));
  assert.ok(d.some((x) => /Добавлен критерий 05 «Новый критерий»/.test(x)));
  assert.deepEqual(M.diff(a, clone(a)), []);
});

test('новые ключи уникальны и проходят проверку', () => {
  const keys = new Set(Array.from({ length: 200 }, () => M.newKey('c')));
  assert.equal(keys.size, 200);
  keys.forEach((k) => assert.ok(M.KEY_RE.test(k), k));
});

/* ---------- сервис ---------- */

function svc(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-cl-'));
  const store = new JsonStore(dir);
  return { dir, store, s: createChecklistService(store, opts) };
}

test('при первом запуске создаётся чек-лист из задания, он используемый', async () => {
  const { s } = svc();
  assert.equal(await s.seed(), true);
  assert.equal(await s.seed(), false, 'повторно не создаётся');
  const list = s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'chat-quality');
  assert.equal(list[0].active, true);
  assert.equal(list[0].version, 1);
  assert.equal(list[0].weight_total, 100);
  assert.equal(s.getActive().criteria.length, 8);
});

test('сохранение создаёт новую версию, старая остаётся доступной', async () => {
  const { s, dir } = svc();
  await s.seed();
  const cur = s.get('chat-quality');
  const next = clone(cur);
  next.criteria.find((c) => c.key === 'c_closing').weight = 10;
  const saved = await s.save('chat-quality', { base_version: 1, checklist: next });
  assert.equal(saved.version, 2);
  assert.ok(saved.changes.some((x) => /вес 5 → 10/.test(x)));
  assert.ok(saved.warnings.some((w) => w.path === 'weights'));
  assert.equal(s.get('chat-quality', 1).criteria.find((c) => c.key === 'c_closing').weight, 5);
  assert.deepEqual(saved.versions.map((v) => v.version), [1, 2]);
  // на диске
  const reloaded = createChecklistService(new JsonStore(dir));
  assert.equal(reloaded.get('chat-quality').version, 2);
});

test('правка поверх устаревшей версии — 409; ошибки — 422 со списком', async () => {
  const { s } = svc();
  await s.seed();
  const cl = clone(s.get('chat-quality'));
  cl.name = 'Версия А';
  await s.save('chat-quality', { base_version: 1, checklist: cl });
  cl.name = 'Версия Б';
  await assert.rejects(() => s.save('chat-quality', { base_version: 1, checklist: cl }), (e) => e.status === 409 && e.latest_version === 2);
  cl.criteria[0].name = '';
  await assert.rejects(() => s.save('chat-quality', { base_version: 2, checklist: cl }), (e) => e.status === 422 && e.errors.length >= 1);
  assert.equal(s.get('chat-quality').name, 'Версия А', 'ошибочное не сохранилось');
});

test('сохранение без изменений не плодит версии', async () => {
  const { s } = svc();
  await s.seed();
  const r = await s.save('chat-quality', { base_version: 1, checklist: s.get('chat-quality') });
  assert.equal(r.unchanged, true);
  assert.equal(r.version, 1);
});

test('замена критерия (контроль): новый ключ, старые версии не трогаются', async () => {
  const { s } = svc();
  await s.seed();
  const cl = clone(s.get('chat-quality'));
  const i = cl.criteria.findIndex((c) => c.key === 'c_empathy');
  const old = cl.criteria[i];
  cl.criteria[i] = { ...M.blankCriterion(old.section, { weight: old.weight }), name: 'Персонализация', description: 'Да — оператор обращался к клиенту по имени, если имя известно.' };
  const saved = await s.save('chat-quality', { base_version: 1, checklist: cl });
  assert.equal(saved.version, 2);
  assert.ok(!saved.criteria.some((c) => c.key === 'c_empathy'));
  assert.ok(saved.changes.some((x) => /Удалён критерий «Эмпатия/.test(x)));
  assert.ok(saved.changes.some((x) => /Добавлен критерий 05 «Персонализация»/.test(x)));
  assert.ok(s.get('chat-quality', 1).criteria.some((c) => c.key === 'c_empathy'));
  assert.equal(M.weightSummary(saved).total, 100);
});

test('копия, переключение «используемого», удаление', async () => {
  let n = 0;
  const { s } = svc({ newId: () => `cl-test${++n}` });
  await s.seed();
  const copy = await s.create({ from: 'chat-quality' });
  assert.equal(copy.id, 'cl-test1');
  assert.equal(copy.name, 'Качество чатов (копия)');
  assert.equal(copy.active, false);
  await assert.rejects(() => s.remove('chat-quality'), (e) => e.status === 409);
  await s.activate('cl-test1');
  assert.equal(s.getActive().id, 'cl-test1');
  assert.equal(s.list().filter((x) => x.active).length, 1);
  await s.remove('chat-quality');
  assert.equal(s.list().length, 1);
  assert.throws(() => s.get('nope'), (e) => e.status === 404);
});

/* ---------- HTTP ---------- */

test('API чек-листов: список, получение, сохранение, 409, 422, активация, удаление', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-cl-http-'));
  const server = createServer({ dataDir, orgApiUrl: 'http://127.0.0.1:9/none', allowedOrigins: [], autoDownloadAudio: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, json: t ? JSON.parse(t) : null }); });
    });
    rq.on('error', reject);
    if (body !== undefined) rq.write(JSON.stringify(body));
    rq.end();
  });
  try {
    const list = await call('GET', '/api/checklists');
    assert.equal(list.status, 200);
    assert.equal(list.json.items[0].id, 'chat-quality');

    const active = await call('GET', '/api/checklists/active');
    assert.equal(active.json.criteria.length, 8);

    const cl = active.json;
    cl.criteria.find((c) => c.key === 'c_closing').weight = 10;
    const saved = await call('PUT', '/api/checklists/chat-quality', { base_version: 1, checklist: cl });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.version, 2);

    const conflict = await call('PUT', '/api/checklists/chat-quality', { base_version: 1, checklist: cl });
    assert.equal(conflict.status, 409);

    cl.criteria[0].description = '';
    const bad = await call('PUT', '/api/checklists/chat-quality', { base_version: 2, checklist: cl });
    assert.equal(bad.status, 422);
    assert.match(bad.json.error, /что проверяет ИИ/);

    const v1 = await call('GET', '/api/checklists/chat-quality/versions/1');
    assert.equal(v1.json.version, 1);

    const copy = await call('POST', '/api/checklists', { from: 'chat-quality', name: 'Звонки' });
    assert.equal(copy.status, 200);
    assert.equal(copy.json.name, 'Звонки');
    const act = await call('POST', `/api/checklists/${copy.json.id}/activate`, {});
    assert.equal(act.json.active, true);
    const del = await call('DELETE', '/api/checklists/chat-quality');
    assert.equal(del.status, 200);
    assert.equal((await call('GET', '/api/checklists/chat-quality')).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ---------- исправления после проверки кода ---------- */

test('служебные имена (__proto__, toString, constructor) не обманывают проверку', () => {
  const a = clone(DEFAULT);
  a.criteria[0].section = 'toString';
  assert.ok(paths(M.validate(a)).includes('criteria.c_contact.section'));
  const b = clone(DEFAULT);
  b.criteria[0].section = '__proto__';
  assert.ok(paths(M.validate(b)).includes('criteria.c_contact.section'));
  const c = clone(DEFAULT);
  c.sections[0].key = 'constructor';
  c.criteria.filter((x) => x.section === 's_start').forEach((x) => { x.section = 'constructor'; });
  assert.ok(!M.validate(c).errors.some((e) => /повторяется/.test(e.message)), 'нет ложного «повторяется»');
});

test('ошибка ступени шкалы указывает на ту строку, что в редакторе (без сортировки)', () => {
  const cl = clone(DEFAULT);
  cl.criteria.find((x) => x.key === 'c_consult').scale.push({ points: 12, text: '' });
  assert.deepEqual(paths(M.validate(cl)), ['criteria.c_consult.scale.5.text']);
  // а сохраняется — по убыванию
  const ok = clone(DEFAULT);
  ok.criteria.find((x) => x.key === 'c_consult').scale.push({ points: 12, text: 'почти всё' });
  const r = M.validate(ok);
  assert.deepEqual(r.normalized.criteria.find((x) => x.key === 'c_consult').scale.map((s) => s.points), [20, 15, 12, 10, 5, 0]);
});

test('пустые баллы ступени и пустой вес — «введите число», а не «повтор»', () => {
  const cl = clone(DEFAULT);
  cl.criteria.find((x) => x.key === 'c_consult').scale.push({ points: '', text: 'что-то' });
  cl.criteria[0].weight = '';
  const msgs = M.validate(cl).errors.map((e) => e.message);
  assert.ok(msgs.includes('Баллы ступени — целое число от 0.'));
  assert.ok(msgs.includes('Вес — целое число от 1 до 100.'));
  assert.ok(!msgs.some((m) => /уже есть/.test(m)));
});

test('мусор вместо чек-листа — ошибки проверки, а не падение', () => {
  for (const bad of [null, 5, 'x', { sections: 'x', criteria: [null, 5, 'y'] }, { criteria: [{ scale: 'z' }] }]) {
    const r = M.validate(bad);
    assert.ok(r.errors.length > 0, JSON.stringify(bad));
  }
});

test('слишком большой чек-лист отклоняется сразу, до тяжёлой проверки', () => {
  const cl = { name: 'x', sections: Array.from({ length: 5000 }, (_, i) => ({ key: 's_' + i, name: 's' })), criteria: [] };
  const t = Date.now();
  const r = M.validate(cl);
  assert.ok(Date.now() - t < 200);
  assert.match(r.errors[0].message, /Слишком много разделов/);
});

test('перестановка пустого раздела сохраняется как новая версия', async () => {
  const { s } = svc();
  await s.seed();
  const cl = clone(s.get('chat-quality'));
  cl.sections.push({ key: 's_empty', name: 'Пустой' });
  const v2 = await s.save('chat-quality', { base_version: 1, checklist: cl });
  const moved = clone(v2);
  const i = moved.sections.findIndex((x) => x.key === 's_empty');
  [moved.sections[i - 1], moved.sections[i]] = [moved.sections[i], moved.sections[i - 1]];
  const v3 = await s.save('chat-quality', { base_version: 2, checklist: moved });
  assert.equal(v3.version, 3);
  assert.ok(v3.changes.includes('Изменён порядок разделов'));
});

test('одновременные «удалить» и «сделать используемым» не оставляют систему без используемого', async () => {
  let n = 0;
  const { s } = svc({ newId: () => `cl-race${++n}` });
  await s.seed();
  await s.create({ from: 'chat-quality' });
  const results = await Promise.allSettled([s.remove('cl-race1'), s.activate('cl-race1')]);
  const actives = s.list().filter((x) => x.active);
  assert.equal(actives.length, 1, 'ровно один используемый: ' + JSON.stringify(results.map((r) => r.status)));
});
