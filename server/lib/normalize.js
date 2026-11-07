'use strict';

const { computeOffsets } = require('./time');

/*
 * Приводим любые входные данные (API организаторов, JSON-файл, вставленный текст)
 * к одному виду записи. Исходные поля сохраняются без изменений — добавляем
 * только служебные: key, group_id, source, imported_at и offset_sec у реплик.
 */

const CHANNELS = { CHAT: 'agent chat', CALL: 'voice call' };
const LANGUAGES = ['RU', 'KZ', 'EN'];
const ROLES = ['client', 'operator', 'bot', 'system'];

const ROLE_ALIASES = {
  client: 'client', customer: 'client', user: 'client', клиент: 'client', клиентка: 'client',
  тұтынушы: 'client', пайдаланушы: 'client', покупатель: 'client',
  operator: 'operator', agent: 'operator', manager: 'operator', consultant: 'operator', specialist: 'operator',
  оператор: 'operator', менеджер: 'operator', сотрудник: 'operator', специалист: 'operator', консультант: 'operator',
  маман: 'operator', кеңесші: 'operator', қызметкер: 'operator',
  bot: 'bot', бот: 'bot', assistant: 'bot', ассистент: 'bot',
  system: 'system', система: 'system', жүйе: 'system', системное: 'system',
};

const KZ_LETTERS = /[әғқңөұүһі]/i;
const CYRILLIC = /[а-яё]/i;

function detectLanguage(text) {
  const s = String(text || '');
  if (KZ_LETTERS.test(s)) return 'KZ';
  if (CYRILLIC.test(s)) return 'RU';
  return 'EN';
}

function normalizeRole(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return ROLE_ALIASES[s] || null;
}

function normalizeChannel(raw, hasAudio) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === CHANNELS.CHAT || s === 'chat' || s === 'чат') return { value: CHANNELS.CHAT };
  if (s === CHANNELS.CALL || s === 'call' || s === 'voice' || s === 'звонок') return { value: CHANNELS.CALL };
  return {
    value: hasAudio ? CHANNELS.CALL : CHANNELS.CHAT,
    warning: `канал «${raw ?? ''}» не распознан, принят как ${hasAudio ? 'звонок' : 'чат'}`,
  };
}

function normalizeLanguage(raw, transcript) {
  const s = String(raw || '').trim().toUpperCase();
  if (LANGUAGES.includes(s)) return { value: s };
  if (s === 'KK' || s === 'KAZ') return { value: 'KZ' };
  if (s === 'RUS') return { value: 'RU' };
  if (s === 'ENG') return { value: 'EN' };
  const sample = transcript.filter((t) => t.speaker === 'client' || t.speaker === 'operator').map((t) => t.text).join(' ');
  const detected = detectLanguage(sample);
  return { value: detected, warning: `язык «${raw ?? ''}» не распознан, определён по тексту как ${detected}` };
}

function makeKey(groupId, conversationId) {
  return `${groupId}:${conversationId}`;
}

/**
 * @returns {{ record?: object, warnings: string[], error?: string }}
 */
function normalizeRecord(raw, { groupId, source, importedAt, order = 0 }) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') return { warnings, error: 'запись не является объектом' };

  const conversationId = raw.conversation_id === undefined || raw.conversation_id === null ? '' : String(raw.conversation_id).trim();
  if (!conversationId) return { warnings, error: 'нет conversation_id' };
  if (conversationId.includes(':')) return { warnings, error: 'conversation_id не должен содержать двоеточие' };

  let transcript = raw.transcript;
  if (typeof transcript === 'string') {
    try { transcript = JSON.parse(transcript); } catch (_) { /* ниже будет ошибка */ }
  }
  if (!Array.isArray(transcript)) return { warnings, error: 'transcript не является массивом реплик' };
  if (transcript.length === 0) return { warnings, error: 'в транскрипте нет реплик' };

  const turns = [];
  transcript.forEach((t, i) => {
    if (!t || typeof t !== 'object') { warnings.push(`реплика ${i + 1} пропущена: не объект`); return; }
    const role = normalizeRole(t.speaker);
    if (!role) warnings.push(`реплика ${i + 1}: неизвестная роль «${t.speaker}», принята как system`);
    turns.push({
      timestamp: t.timestamp === undefined || t.timestamp === null ? '' : String(t.timestamp),
      speaker: role || 'system',
      text: t.text === undefined || t.text === null ? '' : String(t.text),
    });
  });

  const offsets = computeOffsets(turns);
  turns.forEach((t, i) => { t.offset_sec = offsets[i]; });

  const audioUrl = typeof raw.audio_url === 'string' && raw.audio_url.trim() ? raw.audio_url.trim() : null;
  const channel = normalizeChannel(raw.channel, Boolean(audioUrl));
  if (channel.warning) warnings.push(channel.warning);
  const language = normalizeLanguage(raw.language, turns);
  if (language.warning) warnings.push(language.warning);

  return {
    warnings,
    record: {
      key: makeKey(groupId, conversationId),
      group_id: groupId,
      conversation_id: conversationId,
      channel: channel.value,
      language: language.value,
      transcript: turns,
      audio_url: audioUrl,
      source,
      imported_at: importedAt,
      order,
    },
  };
}

/**
 * Достаёт массив записей из любого поддерживаемого формата:
 * ответ API организаторов, { records: [...] }, массив записей или одна запись.
 */
function extractRecords(payload) {
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return { error: 'Данные пустые или это не JSON-объект.' };
  }
  if (payload.isSuccess === false) {
    return { error: `API вернул ошибку: ${payload.error || 'без описания'}` };
  }
  if (payload.data && Array.isArray(payload.data.records)) {
    return { groupId: payload.data.dataset_group_id ? String(payload.data.dataset_group_id) : null, records: payload.data.records };
  }
  if (Array.isArray(payload.records)) {
    return { groupId: payload.dataset_group_id ? String(payload.dataset_group_id) : null, records: payload.records };
  }
  if (Array.isArray(payload)) return { groupId: null, records: payload };
  if (payload.conversation_id !== undefined) return { groupId: null, records: [payload] };
  return { error: 'Не нашёл диалоги: ожидается ответ API организаторов, массив записей или одна запись с conversation_id и transcript.' };
}

/** Короткая сводка для списка диалогов (без текста реплик). */
function summarize(record) {
  const roles = { client: 0, operator: 0, bot: 0, system: 0 };
  let duration = null;
  for (const t of record.transcript) {
    roles[t.speaker] = (roles[t.speaker] || 0) + 1;
    if (typeof t.offset_sec === 'number') duration = Math.max(duration || 0, t.offset_sec);
  }
  return {
    key: record.key,
    group_id: record.group_id,
    conversation_id: record.conversation_id,
    channel: record.channel,
    language: record.language,
    turns: record.transcript.length,
    roles,
    duration_sec: duration,
    has_audio: Boolean(record.audio_url),
    source: record.source,
    imported_at: record.imported_at,
    order: record.order || 0,
  };
}

/* ---------- Транскрипт, вставленный текстом ---------- */

const LINE_RE = /^\s*(?:\[?\s*(\d{1,3}:\d{2}(?::\d{2})?|\d{4}-\d{2}-\d{2}T[^\s\]]+)\s*\]?\s*[-–—]?\s*)?([A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]+)\s*:\s?(.*)$/;

/**
 * Строки вида «00:02 operator: Здравствуйте!», «[00:02] Оператор: …» или «Клиент: …».
 * Строка без роли считается продолжением предыдущей реплики.
 * @returns {{ turns?: object[], error?: string }}
 */
function parseTextTranscript(text) {
  const lines = String(text || '').split(/\r?\n/);
  const turns = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = LINE_RE.exec(line);
    const role = m ? normalizeRole(m[2]) : null;
    if (m && role) {
      turns.push({ timestamp: m[1] || '', speaker: role, text: m[3].trim() });
    } else if (m && m[1]) {
      // Есть время и «слово:», но роль незнакомая — не приклеиваем к чужой реплике, а говорим об ошибке.
      return { error: `Строка ${i + 1}: незнакомая роль «${m[2]}». Используйте client, operator, bot или system (можно по-русски: клиент, оператор, бот, система).` };
    } else if (turns.length) {
      turns[turns.length - 1].text += '\n' + line.trim();
    } else {
      return { error: `Строка ${i + 1}: не понял, кто говорит. Начните строку с роли: client, operator, bot или system (можно по-русски).` };
    }
  }
  if (!turns.length) return { error: 'Текст пустой. Вставьте хотя бы одну реплику.' };
  return { turns };
}

module.exports = {
  CHANNELS, LANGUAGES, ROLES,
  detectLanguage, normalizeRole, normalizeRecord, extractRecords, summarize, parseTextTranscript, makeKey,
};
