'use strict';

const { normalizeRecord, summarize, parseTextTranscript, detectLanguage, CHANNELS } = require('./normalize');
const { validateGroupId } = require('./orgApi');

/*
 * Работа с диалогами поверх хранилища.
 * dialogs.json: { "<group_id>:<conversation_id>": record }
 * Список наборов вычисляется из самих диалогов — отдельного файла нет,
 * поэтому сводка по наборам никогда не расходится с данными.
 *
 * Ключ включает group_id, чтобы контрольный набор не затёр DEV,
 * даже если номера диалогов совпадут.
 */

function countBy(items, fn) {
  const out = {};
  for (const it of items) {
    const k = fn(it);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function createDialogService(store, { now = () => new Date().toISOString() } = {}) {
  const all = () => store.get('dialogs', {});
  const has = (key) => Object.prototype.hasOwnProperty.call(all(), key);

  // Импорты выполняются строго по очереди: иначе два одновременных импорта
  // прочитали бы один и тот же снимок и второй затёр бы первый.
  let lock = Promise.resolve();
  function exclusive(fn) {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  }

  function list({ q } = {}) {
    let items = Object.values(all());
    const query = String(q || '').trim().toLocaleLowerCase('ru');
    if (query) {
      items = items.filter((r) =>
        r.conversation_id.toLocaleLowerCase('ru').includes(query) ||
        r.transcript.some((t) => t.text.toLocaleLowerCase('ru').includes(query)));
    }
    return items.map(summarize);
  }

  function get(key) {
    return has(key) ? all()[key] : null;
  }

  function datasetMeta(groupId, records) {
    const latest = records.reduce((a, r) => (String(r.imported_at) > String(a.imported_at) ? r : a), records[0]);
    return {
      group_id: groupId,
      source: latest.source,
      total: records.length,
      by_channel: countBy(records, (r) => r.channel),
      by_language: countBy(records, (r) => r.language),
      imported_at: latest.imported_at,
    };
  }

  function listDatasets() {
    const groups = {};
    for (const r of Object.values(all())) (groups[r.group_id] = groups[r.group_id] || []).push(r);
    return Object.keys(groups)
      .map((g) => datasetMeta(g, groups[g]))
      .sort((a, b) => String(a.imported_at).localeCompare(String(b.imported_at)));
  }

  /** Сохраняет набор записей. Невалидные записи пропускаются с причиной. */
  function saveRecords(groupId, rawRecords, source) {
    return exclusive(() => saveRecordsNow(groupId, rawRecords, source));
  }

  async function saveRecordsNow(groupId, rawRecords, source) {
    const importedAt = now();
    const store_ = { ...all() };
    const result = { group_id: groupId, added: 0, updated: 0, skipped: [], warnings: [], total: 0, keys: [] };
    const saved = [];
    const seen = new Set();

    rawRecords.forEach((raw, i) => {
      const { record, warnings, error } = normalizeRecord(raw, { groupId, source, importedAt, order: i });
      const label = (raw && raw.conversation_id) || `запись ${i + 1}`;
      if (error) { result.skipped.push({ id: String(label), reason: error }); return; }
      if (seen.has(record.key)) { result.skipped.push({ id: record.conversation_id, reason: 'повтор conversation_id в этом наборе' }); return; }
      seen.add(record.key);
      warnings.forEach((w) => result.warnings.push(`${record.conversation_id}: ${w}`));
      if (Object.prototype.hasOwnProperty.call(store_, record.key)) result.updated++; else result.added++;
      store_[record.key] = record;
      saved.push(record);
    });

    if (!saved.length) {
      const why = result.skipped.slice(0, 3).map((s) => `${s.id} — ${s.reason}`).join('; ');
      const err = new Error(`Ни один диалог не загружен. ${why}`);
      err.status = 422;
      throw err;
    }

    await store.set('dialogs', store_);
    const meta = datasetMeta(groupId, Object.values(store_).filter((r) => r.group_id === groupId));
    result.keys = saved.map((r) => r.key);

    result.total = meta.total;
    result.by_channel = meta.by_channel;
    result.by_language = meta.by_language;
    return result;
  }

  /** Сводка по сырым записям до сохранения — для кнопки «Проверить». */
  function preview(groupId, rawRecords) {
    const ok = [];
    const skipped = [];
    rawRecords.forEach((raw, i) => {
      const { record, error } = normalizeRecord(raw, { groupId, source: 'preview', importedAt: '' });
      if (error) skipped.push({ id: String((raw && raw.conversation_id) || `запись ${i + 1}`), reason: error });
      else ok.push(record);
    });
    const existing = all();
    return {
      group_id: groupId,
      total: ok.length,
      by_channel: countBy(ok, (r) => r.channel),
      by_language: countBy(ok, (r) => r.language),
      already_loaded: ok.filter((r) => Object.prototype.hasOwnProperty.call(existing, r.key)).length,
      skipped,
    };
  }

  function resolveGroupId(candidate, fallback) {
    const v = validateGroupId(candidate);
    if (!v.error) return v.value;
    return fallback;
  }

  /** Один диалог, вставленный текстом. */
  async function saveFromText({ text, conversation_id: conversationId, language, channel, overwrite }) {
    const parsed = parseTextTranscript(text);
    if (parsed.error) {
      const err = new Error(parsed.error);
      err.status = 422;
      throw err;
    }
    const sample = parsed.turns.filter((t) => t.speaker === 'client' || t.speaker === 'operator').map((t) => t.text).join(' ');

    // Номер выбираем внутри очереди импортов, чтобы два одновременных запроса не взяли один и тот же.
    return exclusive(() => {
      let id = String(conversationId || '').trim();
      if (id) {
        if (has(`MANUAL:${id}`) && !overwrite) {
          const err = new Error(`Диалог с номером «${id}» уже есть в наборе MANUAL. Укажите другой номер или оставьте поле пустым.`);
          err.status = 409;
          throw err;
        }
      } else {
        // Номер из даты и времени с миллисекундами; при совпадении добавляем счётчик.
        const base = `manual-${now().replace(/\D/g, '').slice(0, 17)}`;
        id = base;
        for (let n = 2; has(`MANUAL:${id}`); n++) id = `${base}-${n}`;
      }
      const raw = {
        conversation_id: id,
        channel: channel === 'call' ? CHANNELS.CALL : CHANNELS.CHAT,
        language: language && language !== 'auto' ? language : detectLanguage(sample),
        transcript: parsed.turns,
        audio_url: null,
      };
      return saveRecordsNow('MANUAL', [raw], 'text');
    });
  }

  /** Удалить диалоги (по очереди с импортами). Возвращает ключи, которые реально были. */
  function remove(keys) {
    return exclusive(async () => {
      const wanted = new Set((keys || []).map(String));
      let removed = [];
      await store.update('dialogs', (cur) => {
        const next = { ...cur };
        removed = Object.keys(next).filter((k) => wanted.has(k));
        removed.forEach((k) => { delete next[k]; });
        return next;
      });
      return removed;
    });
  }

  return { list, get, listDatasets, saveRecords, preview, resolveGroupId, saveFromText, remove };
}

module.exports = { createDialogService };
