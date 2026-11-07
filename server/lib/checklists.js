'use strict';

const model = require('../../frontend/js/checklist-model');
const DEFAULT_CHECKLIST = require('../defaults/checklist-chat');

/*
 * Чек-листы с версиями.
 * checklists.json: {
 *   "<id>": { id, active, created_at, versions: [ { version, saved_at, name, instructions, sections, criteria, changes } ] }
 * }
 * Версии только добавляются: оценка запоминает «чек-лист + версия», и старые результаты
 * всегда можно объяснить тем чек-листом, по которому их считали.
 */

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function createChecklistService(store, { now = () => new Date().toISOString(), newId } = {}) {
  const all = () => store.get('checklists', {});
  // Удалённый чек-лист не пропадает совсем: он скрыт из списка, но его версии читаются через getArchived —
  // иначе прежние оценки по нему нельзя было бы объяснить.
  const live = (cur, id) => Object.prototype.hasOwnProperty.call(cur, id) && !cur[id].deleted;
  const has = (id) => live(all(), id);
  const makeId = newId || (() => `cl-${model.newKey('x').slice(2)}`);

  function latest(entry) { return entry.versions[entry.versions.length - 1]; }

  function summary(entry) {
    const v = latest(entry);
    const scored = v.criteria.filter((c) => model.isScored(c));
    return {
      id: entry.id,
      name: v.name,
      active: Boolean(entry.active),
      version: v.version,
      saved_at: v.saved_at,
      criteria_count: v.criteria.length,
      weight_total: scored.reduce((a, c) => a + c.weight, 0),
    };
  }

  function full(entry, version) {
    const v = version ? entry.versions.find((x) => x.version === Number(version)) : latest(entry);
    if (!v) throw httpError(404, `Версии ${version} у этого чек-листа нет.`);
    return {
      id: entry.id,
      active: Boolean(entry.active),
      latest_version: latest(entry).version,
      versions: entry.versions.map((x) => ({ version: x.version, saved_at: x.saved_at, changes: x.changes || [] })),
      ...v,
    };
  }

  function checkOrThrow(input) {
    const { errors, warnings, normalized } = model.validate(input);
    if (errors.length) {
      throw httpError(422, `Чек-лист не сохранён: ${errors[0].message}${errors.length > 1 ? ` (и ещё ${errors.length - 1})` : ''}`, { errors });
    }
    return { normalized, warnings };
  }

  /** При первом запуске создаём чек-лист из задания. */
  async function seed() {
    if (Object.keys(all()).length) return false;
    const { normalized } = checkOrThrow(DEFAULT_CHECKLIST);
    const entry = {
      id: DEFAULT_CHECKLIST.id,
      active: true,
      created_at: now(),
      versions: [{ version: 1, saved_at: now(), ...normalized, changes: ['Создан из чек-листа задания (PDF)'] }],
    };
    await store.update('checklists', (cur) => (Object.keys(cur).length ? cur : { [entry.id]: entry }));
    return true;
  }

  function list() {
    return Object.values(all()).filter((e) => !e.deleted).map(summary).sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'ru'));
  }

  function get(id, version) {
    if (!has(id)) throw httpError(404, 'Чек-лист не найден.');
    return full(all()[id], version);
  }

  /** Версия чек-листа для показа старой оценки — работает и для удалённого. */
  function getArchived(id, version) {
    if (!Object.prototype.hasOwnProperty.call(all(), id)) throw httpError(404, 'Чек-лист не найден.');
    return { ...full(all()[id], version), deleted: Boolean(all()[id].deleted) };
  }

  function getActive() {
    const alive = Object.values(all()).filter((e) => !e.deleted);
    const entry = alive.find((e) => e.active) || alive[0];
    return entry ? full(entry) : null;
  }

  /** Новый чек-лист: копия существующего (from) или из чек-листа задания. */
  async function create({ from, name } = {}) {
    let base;
    if (from) {
      if (!has(from)) throw httpError(404, 'Чек-лист для копии не найден.');
      base = latest(all()[from]);
    } else {
      base = DEFAULT_CHECKLIST;
    }
    const copyName = String(name || '').trim() || `${base.name} (копия)`;
    const { normalized } = checkOrThrow({ ...base, name: copyName });
    const id = makeId();
    const entry = {
      id,
      active: false,
      created_at: now(),
      versions: [{ version: 1, saved_at: now(), ...normalized, changes: [from ? `Копия чек-листа «${base.name}»` : 'Создан из чек-листа задания (PDF)'] }],
    };
    await store.update('checklists', (cur) => ({ ...cur, [id]: entry }));
    return full(entry);
  }

  /**
   * Сохранить как новую версию. base_version — версия, которую редактировали:
   * если с тех пор кто-то сохранил новую, отвечаем 409, чтобы правки не затёрлись молча.
   */
  async function save(id, { base_version: baseVersion, checklist } = {}) {
    if (!has(id)) throw httpError(404, 'Чек-лист не найден.');
    const { normalized, warnings } = checkOrThrow(checklist);
    let saved;
    await store.update('checklists', (cur) => {
      const entry = cur[id];
      if (!entry || entry.deleted) throw httpError(404, 'Чек-лист не найден.');
      const last = latest(entry);
      if (Number(baseVersion) !== last.version) {
        throw httpError(409, `Чек-лист уже изменён (сейчас версия ${last.version}). Обновите страницу, чтобы увидеть изменения.`, { latest_version: last.version });
      }
      // «Без изменений» решаем по содержанию, а не по списку фраз: так не потеряется даже то, что diff не описывает.
      if (model.sameContent(last, normalized)) { saved = null; return cur; }
      const changes = model.diff(last, normalized);
      saved = { version: last.version + 1, saved_at: now(), ...normalized, changes: changes.length ? changes : ['Мелкие правки'] };
      return { ...cur, [id]: { ...entry, versions: [...entry.versions, saved] } };
    });
    if (!saved) return { ...get(id), unchanged: true, warnings };
    return { ...get(id), warnings };
  }

  /** Сделать «используемым» (по нему оценивают по умолчанию). */
  // Проверки «есть ли чек-лист» и «используется ли он» делаем ВНУТРИ очереди записи,
  // по самому свежему состоянию — иначе одновременные «удалить» и «сделать используемым»
  // могли бы оставить систему вообще без используемого чек-листа.
  async function activate(id) {
    await store.update('checklists', (cur) => {
      if (!live(cur, id)) throw httpError(404, 'Чек-лист не найден.');
      const next = {};
      Object.keys(cur).forEach((k) => { next[k] = { ...cur[k], active: k === id }; });
      return next;
    });
    return get(id);
  }

  async function remove(id) {
    await store.update('checklists', (cur) => {
      if (!live(cur, id)) throw httpError(404, 'Чек-лист не найден.');
      if (cur[id].active) throw httpError(409, 'Нельзя удалить используемый чек-лист. Сначала сделайте используемым другой.');
      return { ...cur, [id]: { ...cur[id], active: false, deleted: true, deleted_at: now() } };
    });
    return { ok: true };
  }

  return { seed, list, get, getArchived, getActive, create, save, activate, remove, ID_RE };
}

module.exports = { createChecklistService };
