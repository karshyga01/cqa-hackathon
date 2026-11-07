'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseTimestamp, computeOffsets, formatClock } = require('../lib/time');
const { normalizeRecord, extractRecords, summarize, parseTextTranscript, detectLanguage } = require('../lib/normalize');
const { JsonStore } = require('../lib/store');
const { createDialogService } = require('../lib/dialogs');
const { validateGroupId } = require('../lib/orgApi');

// Записи в формате API организаторов (как в реальном DEV-наборе).
const CHAT = {
  conversation_id: 'p1-ru-001', channel: 'agent chat', language: 'RU', audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Хочу узнать тариф' },
    { timestamp: '00:02', speaker: 'bot', text: 'Соединяю с оператором' },
    { timestamp: '01:15', speaker: 'operator', text: 'Здравствуйте! Меня зовут Айгерим.' },
    { timestamp: '05:31', speaker: 'system', text: 'Чат закрыт' },
  ],
};
const CALL = {
  conversation_id: 'p4-ru-003', channel: 'voice call', language: 'RU', audio_url: 'https://example.org/rec/1',
  transcript: [
    { timestamp: '2026-11-03T15:49:13.1900670+00:00', speaker: 'system', text: 'Запись запущена.' },
    { timestamp: '2026-11-03T15:49:22.4171535+00:00', speaker: 'bot', text: 'Здравствуйте' },
    { timestamp: '2026-11-03T15:55:46.0000000+00:00', speaker: 'operator', text: 'До свидания' },
  ],
};
const API_RESPONSE = { error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 2, records: [CHAT, CALL] } };

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-test-'));
  return { dir, store: new JsonStore(dir) };
}

/* ---------- время ---------- */

test('время чата MM:SS и H:MM:SS', () => {
  assert.deepEqual(parseTimestamp('05:31'), { kind: 'clock', seconds: 331 });
  assert.deepEqual(parseTimestamp('1:02:03'), { kind: 'clock', seconds: 3723 });
  assert.equal(parseTimestamp('').kind, 'none');
  assert.equal(parseTimestamp('вчера').kind, 'unknown');
});

test('время звонка ISO с 7 знаками долей секунды', () => {
  const p = parseTimestamp('2026-11-03T15:49:13.1900670+00:00');
  assert.equal(p.kind, 'iso');
  assert.equal(p.ms, Date.UTC(2026, 10, 3, 15, 49, 13, 190));
});

test('смещения звонка считаются от первой реплики', () => {
  assert.deepEqual(computeOffsets(CALL.transcript), [0, 9.227, 392.81]);
  assert.deepEqual(computeOffsets(CHAT.transcript), [0, 2, 75, 331]);
});

test('formatClock', () => {
  assert.equal(formatClock(393), '06:33');
  assert.equal(formatClock(3723), '1:02:03');
  assert.equal(formatClock(null), '');
});

/* ---------- приведение записей ---------- */

test('запись чата сохраняет исходные поля и получает ключ', () => {
  const { record, warnings, error } = normalizeRecord(CHAT, { groupId: 'DEV', source: 'api', importedAt: 'T' });
  assert.equal(error, undefined);
  assert.deepEqual(warnings, []);
  assert.equal(record.key, 'DEV:p1-ru-001');
  assert.equal(record.transcript[0].timestamp, '00:00');
  assert.equal(record.transcript[2].text, CHAT.transcript[2].text);
  assert.equal(record.transcript[3].offset_sec, 331);
  assert.equal(record.audio_url, null);
});

test('исходная метка звонка не меняется', () => {
  const { record } = normalizeRecord(CALL, { groupId: 'DEV', source: 'api', importedAt: 'T' });
  assert.equal(record.transcript[0].timestamp, '2026-11-03T15:49:13.1900670+00:00');
  assert.equal(record.channel, 'voice call');
  assert.equal(summarize(record).duration_sec, 392.81);
  assert.equal(summarize(record).has_audio, true);
});

test('плохие записи отклоняются с понятной причиной', () => {
  const opts = { groupId: 'DEV', source: 'api', importedAt: 'T' };
  assert.match(normalizeRecord({ transcript: [] }, opts).error, /conversation_id/);
  assert.match(normalizeRecord({ conversation_id: 'x', transcript: 'не json' }, opts).error, /массивом/);
  assert.match(normalizeRecord({ conversation_id: 'x', transcript: [] }, opts).error, /нет реплик/);
});

test('транскрипт строкой JSON тоже принимается', () => {
  const { record } = normalizeRecord({ ...CHAT, transcript: JSON.stringify(CHAT.transcript) }, { groupId: 'G', source: 'file', importedAt: 'T' });
  assert.equal(record.transcript.length, 4);
});

test('неизвестные язык и канал определяются с предупреждением', () => {
  const raw = { conversation_id: 'z', transcript: [{ timestamp: '00:01', speaker: 'client', text: 'Сәлеметсіз бе' }] };
  const { record, warnings } = normalizeRecord(raw, { groupId: 'G', source: 'file', importedAt: 'T' });
  assert.equal(record.language, 'KZ');
  assert.equal(record.channel, 'agent chat');
  assert.equal(warnings.length, 2);
});

test('extractRecords понимает все форматы', () => {
  assert.equal(extractRecords(API_RESPONSE).records.length, 2);
  assert.equal(extractRecords(API_RESPONSE).groupId, 'DEV');
  assert.equal(extractRecords([CHAT]).records.length, 1);
  assert.equal(extractRecords(CHAT).records.length, 1);
  assert.equal(extractRecords({ records: [CHAT] }).records.length, 1);
  assert.match(extractRecords({ isSuccess: false, error: 'bad group' }).error, /bad group/);
  assert.ok(extractRecords({ foo: 1 }).error);
  assert.ok(extractRecords(null).error);
});

test('определение языка', () => {
  assert.equal(detectLanguage('Қазір қай тарифте тұрмын?'), 'KZ');
  assert.equal(detectLanguage('Где посмотреть тариф?'), 'RU');
  assert.equal(detectLanguage('Where is my tariff?'), 'EN');
});

/* ---------- вставка текстом ---------- */

test('разбор текста: время, роли по-русски и по-английски, многострочные реплики', () => {
  const { turns, error } = parseTextTranscript([
    '00:02 operator: Здравствуйте!',
    '[00:10] Клиент: Хочу вывести деньги',
    'с брокерского счёта',
    'Система: Чат закрыт',
  ].join('\n'));
  assert.equal(error, undefined);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns[0], { timestamp: '00:02', speaker: 'operator', text: 'Здравствуйте!' });
  assert.equal(turns[1].text, 'Хочу вывести деньги\nс брокерского счёта');
  assert.equal(turns[2].timestamp, '');
  assert.equal(turns[2].speaker, 'system');
});

test('разбор текста: понятные ошибки', () => {
  assert.match(parseTextTranscript('').error, /пустой/);
  assert.match(parseTextTranscript('просто текст без роли').error, /Строка 1/);
  // незнакомая роль после времени — ошибка, а не склейка с чужой репликой
  assert.match(parseTextTranscript(['00:01 client: Привет', '00:05 Агентка: Здравствуйте'].join('\n')).error, /Строка 2: незнакомая роль/);
  // казахские и рабочие названия ролей
  const kz = parseTextTranscript(['00:01 Тұтынушы: Сәлем', '00:03 Маман: Сәлеметсіз бе', '00:05 Специалист: Чем помочь?'].join('\n'));
  assert.deepEqual(kz.turns.map((t) => t.speaker), ['client', 'operator', 'operator']);
});

/* ---------- код набора ---------- */

test('код набора проверяется', () => {
  assert.equal(validateGroupId(' DEV ').value, 'DEV');
  assert.equal(validateGroupId('dev').value, 'DEV'); // API организаторов не различает регистр
  assert.ok(validateGroupId('').error);
  assert.ok(validateGroupId('DEV&sig=1').error);
});

/* ---------- сохранение ---------- */

test('сохранение набора, повторная загрузка обновляет, а не дублирует', async () => {
  const { dir, store } = tmpStore();
  const svc = createDialogService(store, { now: () => '2026-11-07T10:00:00.000Z' });

  const first = await svc.saveRecords('DEV', [CHAT, CALL], 'api');
  assert.equal(first.added, 2);
  assert.equal(first.updated, 0);
  assert.deepEqual(first.by_channel, { 'agent chat': 1, 'voice call': 1 });

  const second = await svc.saveRecords('DEV', [CHAT, CALL], 'api');
  assert.equal(second.added, 0);
  assert.equal(second.updated, 2);
  assert.equal(svc.list().length, 2);

  // данные действительно на диске и читаются новым экземпляром
  const reloaded = createDialogService(new JsonStore(dir));
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.get('DEV:p4-ru-003').transcript[0].timestamp, CALL.transcript[0].timestamp);
  assert.equal(reloaded.listDatasets()[0].total, 2);
});

test('контрольный набор с теми же номерами не затирает DEV', async () => {
  const { store } = tmpStore();
  const svc = createDialogService(store);
  await svc.saveRecords('DEV', [CHAT], 'api');
  await svc.saveRecords('CONTROL', [{ ...CHAT, transcript: [{ timestamp: '00:01', speaker: 'client', text: 'другой' }] }], 'api');
  assert.equal(svc.list().length, 2);
  assert.equal(svc.get('DEV:p1-ru-001').transcript.length, 4);
  assert.equal(svc.get('CONTROL:p1-ru-001').transcript.length, 1);
});

test('плохие записи пропускаются, хорошие сохраняются; если все плохие — ошибка', async () => {
  const { store } = tmpStore();
  const svc = createDialogService(store);
  const res = await svc.saveRecords('G', [CHAT, { conversation_id: 'bad' }, CHAT], 'file');
  assert.equal(res.added, 1);
  assert.equal(res.skipped.length, 2);
  await assert.rejects(() => svc.saveRecords('G', [{ foo: 1 }], 'file'), /Ни один диалог/);
});

test('поиск по номеру и по словам из переписки', async () => {
  const { store } = tmpStore();
  const svc = createDialogService(store);
  await svc.saveRecords('DEV', [CHAT, CALL], 'api');
  assert.equal(svc.list({ q: 'P4-RU' }).length, 1);
  assert.equal(svc.list({ q: 'айгерим' }).length, 1);
  assert.equal(svc.list({ q: 'нет такого' }).length, 0);
});

test('диалог из текста сохраняется в набор MANUAL', async () => {
  const { store } = tmpStore();
  const svc = createDialogService(store, { now: () => '2026-11-07T10:20:30.000Z' });
  const res = await svc.saveFromText({ text: '00:01 client: Where is my tariff?\n00:05 operator: Hello!', language: 'auto', channel: 'chat' });
  assert.equal(res.group_id, 'MANUAL');
  const rec = svc.get('MANUAL:manual-20261107102030000');
  assert.equal(rec.language, 'EN');
  assert.equal(rec.source, 'text');
});

test('два диалога из текста в одну секунду не затирают друг друга; занятый номер — 409', async () => {
  const { store } = tmpStore();
  const svc = createDialogService(store, { now: () => '2026-11-07T10:20:30.000Z' });
  const [a, b] = await Promise.all([
    svc.saveFromText({ text: '00:01 client: один' }),
    svc.saveFromText({ text: '00:01 client: два' }),
  ]);
  assert.notEqual(a.keys[0], b.keys[0]);
  assert.equal(svc.list().length, 2);
  await svc.saveFromText({ text: '00:01 client: x', conversation_id: 'my-1' });
  await assert.rejects(() => svc.saveFromText({ text: '00:01 client: y', conversation_id: 'my-1' }), (e) => e.status === 409);
  await svc.saveFromText({ text: '00:01 client: y', conversation_id: 'my-1', overwrite: true });
  assert.equal(svc.get('MANUAL:my-1').transcript[0].text, 'y');
});

test('одновременные импорты разных наборов не теряют данные', async () => {
  const { store } = tmpStore();
  const svc = createDialogService(store);
  await Promise.all([svc.saveRecords('A', [CHAT], 'api'), svc.saveRecords('B', [CALL], 'api')]);
  assert.equal(svc.list().length, 2);
  assert.deepEqual(svc.listDatasets().map((d) => d.group_id).sort(), ['A', 'B']);
});

test('ключи вроде __proto__ не находятся как диалоги', () => {
  const { store } = tmpStore();
  const svc = createDialogService(store);
  assert.equal(svc.get('__proto__'), null);
  assert.equal(svc.get('constructor'), null);
});

test('если запись на диск не удалась — данные не появляются в памяти', async () => {
  const { dir, store } = tmpStore();
  const svc = createDialogService(store);
  await svc.saveRecords('DEV', [CHAT], 'api');
  // Превращаем dialogs.json в папку: переименование поверх неё гарантированно упадёт.
  const target = path.join(dir, 'dialogs.json');
  fs.rmSync(target);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'x'), '1');
  await assert.rejects(() => svc.saveRecords('DEV', [CALL], 'api'), (e) => e.status === 503 && /Не удалось сохранить/.test(e.message));
  assert.equal(svc.list().length, 1, 'неудачный импорт не должен попасть в список');
  assert.equal(fs.existsSync(path.join(dir, 'dialogs.json.tmp')), false, 'временный файл убран');
});
