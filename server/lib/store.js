'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Простое хранилище: каждая коллекция — отдельный JSON-файл в папке data/.
 * Данные держим в памяти, на диск пишем атомарно (во временный файл, затем
 * переименование), чтобы файл не испортился, если сервер упадёт во время записи.
 *
 * Важно: значение попадает в память только ПОСЛЕ успешной записи на диск.
 * Иначе при ошибке записи интерфейс показал бы данные, которые пропадут после перезапуска.
 * Записи в один файл выполняются строго по очереди.
 */

// На Windows переименование может временно не пройти, если файл держит
// антивирус, резервное копирование или редактор. Повторяем с паузой.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRIES = 10;
const RETRY_DELAY_MS = 80;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || attempt >= RETRIES) throw err;
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

class StoreWriteError extends Error {
  constructor(name, cause) {
    super('Не удалось сохранить данные на диск: файл занят другой программой или нет доступа к папке data. Повторите через несколько секунд.');
    this.status = 503;
    this.collection = name;
    this.cause = cause;
  }
}

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    this.queues = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  file(name) {
    return path.join(this.dir, `${name}.json`);
  }

  get(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let value = fallback;
    try {
      value = JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Повреждённый файл не затираем молча — откладываем копию рядом.
        const broken = `${this.file(name)}.broken-${Date.now()}`;
        try { fs.copyFileSync(this.file(name), broken); } catch (_) { /* ignore */ }
        console.error(`[store] не удалось прочитать ${name}.json, копия: ${broken}`, err.message);
      }
    }
    this.cache.set(name, value);
    return value;
  }

  /** Записывает на диск и только потом обновляет память. Бросает StoreWriteError. */
  set(name, value) {
    return this.update(name, () => value);
  }

  /**
   * Изменение «на месте»: fn получает САМОЕ СВЕЖЕЕ значение уже внутри очереди записи.
   * Так два одновременных изменения не затирают друг друга.
   */
  update(name, fn, fallback = {}) {
    const prev = this.queues.get(name) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const value = fn(this.get(name, fallback));
      const target = this.file(name);
      const tmp = `${target}.tmp`;
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
        await renameWithRetry(tmp, target);
      } catch (err) {
        try { await fs.promises.unlink(tmp); } catch (_) { /* ignore */ }
        console.error(`[store] запись ${name}.json не удалась:`, err.code || err.message);
        throw new StoreWriteError(name, err);
      }
      this.cache.set(name, value);
    });
    this.queues.set(name, next);
    return next;
  }
}

module.exports = { JsonStore, StoreWriteError, renameWithRetry };
