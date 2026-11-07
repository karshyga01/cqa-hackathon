'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renameWithRetry } = require('./store');

/*
 * Записи звонков.
 *
 * У организаторов audio_url ведёт не на mp3, а на HTML-страницу с плеером;
 * внутри неё — ссылка на mp3, которая работает около часа. Поэтому мы
 * скачиваем mp3 к себе (data/audio/) сразу после загрузки набора и дальше
 * играем свой файл: без истекающих ссылок и без зависимости от сети на показе.
 *
 * Состояние записей — коллекция audio.json: { "<key>": { file, bytes, downloaded_at } }.
 */

const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;   // HTML-страница плеера не бывает большой
const FETCH_TIMEOUT_MS = 120000;
const MAX_REDIRECTS = 5;

/*
 * Откуда можно скачивать записи. Ссылки приходят из загруженных данных, поэтому
 * без списка сервер можно было бы заставить ходить на любые адреса (в том числе
 * внутренние). По умолчанию — только домены организаторов (Power Automate и Dynamics).
 */
const DEFAULT_ALLOWED_HOSTS = ['*.api.powerplatform.com', '*.dynamics.com'];

function hostAllowed(url, patterns) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    return pat.startsWith('*.') ? host.endsWith(pat.slice(1)) && host.length > pat.length - 1 : host === pat;
  });
}

function safeFileName(key) {
  const readable = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
  return `${readable}-${hash}.mp3`;
}

function decodeHtmlAttr(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Достаёт ссылку на звук из HTML-страницы плеера: <source src> или <audio src>. */
function extractAudioSrc(html, baseUrl) {
  const m = /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html) || /<audio\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html);
  if (!m) return null;
  try {
    const url = new URL(decodeHtmlAttr(m[1]), baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (_) {
    return null;
  }
}

function looksLikeAudio(buf, contentType) {
  if (/^audio\//i.test(contentType || '')) return true;
  if (buf.length < 3) return false;
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return true;   // mp3 с тегами
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;    // кадр mp3
  if (buf.slice(0, 4).toString('latin1') === 'RIFF') return true;  // wav
  if (buf.slice(0, 4).toString('latin1') === 'OggS') return true;  // ogg
  return false;
}

function friendlyFetchError(err) {
  if (err && err.name === 'TimeoutError') return 'нет ответа дольше 2 минут';
  return (err && err.cause && err.cause.code) || (err && err.message) || 'неизвестная ошибка';
}

function createAudioService({ store, dialogs, dir, fetchImpl = fetch, now = () => new Date().toISOString(), allowedHosts = DEFAULT_ALLOWED_HOSTS }) {
  fs.mkdirSync(dir, { recursive: true });
  const meta = () => store.get('audio', {});
  const inflight = new Map();   // key -> Promise
  const errors = new Map();     // key -> текст последней ошибки (только в памяти)

  function filePath(key) {
    const m = meta()[key];
    return m ? path.join(dir, m.file) : null;
  }

  function status(key) {
    const record = dialogs.get(key);
    if (!record) return null;
    if (!record.audio_url) return { state: 'none' };
    const m = Object.prototype.hasOwnProperty.call(meta(), key) ? meta()[key] : null;
    if (m && fs.existsSync(path.join(dir, m.file))) {
      return { state: 'ready', bytes: m.bytes, downloaded_at: m.downloaded_at, fallback_url: record.audio_url };
    }
    if (inflight.has(key)) return { state: 'downloading', fallback_url: record.audio_url };
    if (errors.has(key)) return { state: 'error', error: errors.get(key), fallback_url: record.audio_url };
    return { state: 'missing', fallback_url: record.audio_url };
  }

  /**
   * Скачивает по ссылке с проверкой домена на КАЖДОМ шаге переадресации
   * и с ограничением размера во время чтения (а не после).
   */
  async function fetchBuffer(startUrl, maxBytes) {
    let url = startUrl;
    for (let hop = 0; ; hop++) {
      if (!hostAllowed(url, allowedHosts)) {
        throw new Error('адрес записи не из разрешённых доменов (настройка AUDIO_ALLOWED_HOSTS)');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), FETCH_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          if (hop >= MAX_REDIRECTS) throw new Error('слишком много переадресаций');
          url = new URL(res.headers.get('location'), url).href;
          if (res.body && res.body.cancel) await res.body.cancel().catch(() => {});
          continue;
        }
        if (!res.ok) throw new Error(`ответ ${res.status}`);
        const declared = Number(res.headers.get('content-length'));
        if (declared > maxBytes) throw new Error(`файл больше ${Math.round(maxBytes / 1048576)} МБ`);
        const chunks = [];
        let size = 0;
        if (res.body && res.body.getReader) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > maxBytes) {
              controller.abort();
              throw new Error(`файл больше ${Math.round(maxBytes / 1048576)} МБ`);
            }
            chunks.push(Buffer.from(value));
          }
        }
        return { buf: Buffer.concat(chunks), contentType: res.headers.get('content-type') || '', url };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function download(key) {
    const record = dialogs.get(key);
    if (!record || !record.audio_url) throw new Error('у диалога нет ссылки на запись');

    // 1) Ссылка может вести сразу на звук или на страницу с плеером.
    let first;
    try { first = await fetchBuffer(record.audio_url, MAX_AUDIO_BYTES); } catch (err) {
      throw new Error(`не удалось открыть ссылку на запись: ${friendlyFetchError(err)}`);
    }
    let audio = first;
    if (!looksLikeAudio(first.buf, first.contentType)) {
      if (first.buf.length > MAX_PAGE_BYTES) throw new Error('по ссылке пришёл не звук и не страница плеера');
      const src = extractAudioSrc(first.buf.toString('utf8'), first.url);
      if (!src) throw new Error('на странице записи не нашлась ссылка на звук — возможно, организаторы поменяли страницу');
      try { audio = await fetchBuffer(src, MAX_AUDIO_BYTES); } catch (err) {
        throw new Error(`не удалось скачать звук: ${friendlyFetchError(err)}`);
      }
      if (!looksLikeAudio(audio.buf, audio.contentType)) throw new Error('по ссылке пришёл не звуковой файл');
    }

    // 2) Атомарная запись файла, затем — запись в audio.json.
    const file = safeFileName(key);
    const target = path.join(dir, file);
    const tmp = `${target}.tmp`;
    await fs.promises.writeFile(tmp, audio.buf);
    try { await renameWithRetry(tmp, target); } catch (err) {
      try { await fs.promises.unlink(tmp); } catch (_) { /* ignore */ }
      throw new Error('не удалось сохранить файл записи на диск');
    }
    // update: запись в audio.json сливается со свежим значением внутри очереди — параллельные загрузки не теряются.
    const entry = { file, bytes: audio.buf.length, downloaded_at: now() };
    await store.update('audio', (cur) => ({ ...cur, [key]: entry }));
    return status(key);
  }

  /** Скачивает запись, если её ещё нет. Повторные вызовы ждут тот же процесс. */
  function ensure(key) {
    const st = status(key);
    if (!st) return Promise.reject(Object.assign(new Error('Диалог не найден.'), { status: 404 }));
    if (st.state === 'none' || st.state === 'ready') return Promise.resolve(st);
    if (inflight.has(key)) return inflight.get(key);
    errors.delete(key);
    // Сначала снимаем отметку «скачивается», потом считаем состояние — иначе вернулось бы «downloading».
    const p = download(key).then(
      () => { inflight.delete(key); return status(key); },
      (err) => { inflight.delete(key); errors.set(key, err.message); return status(key); },
    );
    inflight.set(key, p);
    return p;
  }

  // Фоновая очередь: по одному файлу за раз, чтобы не перегружать сеть.
  let queue = Promise.resolve();
  function enqueue(keys) {
    const todo = keys.filter((k) => { const s = status(k); return s && (s.state === 'missing' || s.state === 'error'); });
    todo.forEach((k) => { queue = queue.then(() => ensure(k)).catch(() => {}); });
    return todo.length;
  }

  function idle() { return queue; }

  return { status, ensure, enqueue, filePath, idle };
}

module.exports = { createAudioService, extractAudioSrc, looksLikeAudio, safeFileName, hostAllowed, DEFAULT_ALLOWED_HOSTS };
