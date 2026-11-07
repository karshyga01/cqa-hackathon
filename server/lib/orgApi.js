'use strict';

const { extractRecords } = require('./normalize');

const GROUP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/*
 * API организаторов не различает регистр (dev = DEV), поэтому код набора
 * всегда приводим к верхнему регистру — иначе «dev» стал бы вторым набором-копией.
 */
function validateGroupId(groupId) {
  const s = String(groupId || '').trim().toUpperCase();
  if (!s) return { error: 'Укажите код набора (group_id), например DEV.' };
  if (!GROUP_ID_RE.test(s)) return { error: 'Код набора может содержать только латинские буквы, цифры, точку, дефис и подчёркивание.' };
  return { value: s };
}

/**
 * Запрашивает набор у API организаторов.
 * @returns {Promise<{ groupId: string, records: object[] }>} либо бросает Error с понятным текстом.
 */
async function fetchDataset(baseUrl, groupId, { timeoutMs = 90000 } = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('group_id', groupId);

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? 'нет ответа дольше 90 секунд' : (err && err.cause && err.cause.code) || err.message;
    throw new Error(`Не удалось связаться с API организаторов: ${reason}. Проверьте интернет и попробуйте ещё раз.`);
  }

  const body = await res.text();
  let payload = null;
  try { payload = JSON.parse(body); } catch (_) { /* разберём ниже */ }

  if (!res.ok) {
    // Организаторы присылают ошибку в JSON: {"error":"по данному group_id:X данные не найдены","isSuccess":false}
    const reason = payload && payload.error ? String(payload.error) : body.slice(0, 200);
    if (res.status === 404) throw new Error(`Набор «${groupId}» не найден у организаторов. Проверьте код набора. (${reason})`);
    throw new Error(`API организаторов ответил ошибкой ${res.status}. ${reason}`.trim());
  }
  if (payload === null) {
    throw new Error('API организаторов вернул не JSON. Возможно, ссылка устарела.');
  }

  const extracted = extractRecords(payload);
  if (extracted.error) throw new Error(extracted.error);
  if (!extracted.records.length) throw new Error(`В наборе «${groupId}» нет диалогов. Проверьте код набора.`);
  return { groupId: extracted.groupId || groupId, records: extracted.records };
}

module.exports = { fetchDataset, validateGroupId };
