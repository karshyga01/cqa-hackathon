'use strict';

/*
 * Сервер CQA без сторонних библиотек (нужен только Node.js 18+).
 *  - показывает сайт из папки frontend/;
 *  - отвечает на запросы /api/*;
 *  - сам ходит в API организаторов (из браузера мешает CORS).
 *
 * Безопасность: сайт и API живут на одном адресе, поэтому чужим сайтам доступ
 * к API закрыт (нет Access-Control-Allow-Origin: *, проверяется Origin,
 * POST принимается только как application/json). Для встраивания в Dynamics 365
 * разрешённые адреса задаются в ALLOWED_ORIGINS.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const config = require('./config');
const { JsonStore } = require('./lib/store');
const { createDialogService } = require('./lib/dialogs');
const { fetchDataset, validateGroupId } = require('./lib/orgApi');
const { extractRecords } = require('./lib/normalize');
const { createAudioService } = require('./lib/audio');
const { createChecklistService } = require('./lib/checklists');
const { createEvaluationService } = require('./lib/evaluations');
const { mockEvaluate } = require('./lib/mockEvaluator');
const { createAiEvaluator } = require('./lib/aiEvaluator');
const { createAppealService, totalWith } = require('./lib/appeals');
const results = require('./lib/results');
const { computeStats } = require('./lib/stats');

/* ---------- утилиты ---------- */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Тело запроса: файл до 25 МБ плюс обёртка JSON.
const MAX_BODY = 30 * 1024 * 1024;
// Чек-лист — это текст: 2 МБ с огромным запасом.
const CHECKLIST_MAX_BODY = 2 * 1024 * 1024;

function tooBigText(maxBytes) {
  return maxBytes === MAX_BODY ? 'Файл слишком большой: можно до 25 МБ.' : 'Запрос слишком большой (больше ' + Math.round(maxBytes / 1048576) + ' МБ).';
}

function readJsonBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > maxBytes) {
      req.resume(); // дочитываем и выбрасываем, чтобы ответ дошёл до браузера
      reject(new HttpError(413, tooBigText(maxBytes)));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > maxBytes) { tooBig = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) { reject(new HttpError(413, tooBigText(maxBytes))); return; }
      if (!chunks.length) { resolve({}); return; }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_) { reject(new HttpError(400, 'Тело запроса — не JSON.')); return; }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        reject(new HttpError(400, 'Тело запроса должно быть JSON-объектом.'));
        return;
      }
      resolve(data);
    });
    req.on('error', reject);
  });
}

function requireGroupId(value) {
  const v = validateGroupId(value);
  if (v.error) throw new HttpError(400, v.error);
  return v.value;
}

function decodeKey(raw) {
  try { return decodeURIComponent(raw); } catch (_) { throw new HttpError(404, 'Диалог не найден.'); }
}

/* ---------- приложение ---------- */

function createApp({
  dataDir = config.DATA_DIR,
  orgApiUrl = config.ORG_API_URL,
  allowedOrigins = config.ALLOWED_ORIGINS,
  fetchImpl = fetch,
  autoDownloadAudio = true,
  audioAllowedHosts = config.AUDIO_ALLOWED_HOSTS,
  ai: aiOptions = config.AI,
  aiFetch,
  resultsDir = config.RESULTS_DIR,
  teamName = config.TEAM_NAME,
} = {}) {
  const store = new JsonStore(dataDir);
  const dialogs = createDialogService(store);
  const audio = createAudioService({ store, dialogs, dir: path.join(dataDir, 'audio'), fetchImpl, allowedHosts: audioAllowedHosts });

  // Записи, которые ещё не скачаны (например, сервер перезапустили), докачиваем в фоне.
  if (autoDownloadAudio) audio.enqueue(dialogs.list().filter((d) => d.has_audio).map((d) => d.key));

  // Чек-листы: при первом запуске создаётся чек-лист из задания. Запросы ждут, пока он появится.
  const checklists = createChecklistService(store);
  const checklistsReady = checklists.seed().catch((err) => { console.error('[checklists] не удалось создать чек-лист по умолчанию:', err.message); });

  // Оценки: подставная (mode: 'mock', правила по ключевым словам) и ИИ (mode: 'ai', OpenRouter).
  const evaluations = createEvaluationService(store);
  const ai = createAiEvaluator({ ...aiOptions, ...(aiFetch ? { fetchImpl: aiFetch } : {}) });

  // Апелляции: решения хранятся отдельно, оценка ИИ не меняется; финальный итог считается с их учётом.
  const appeals = createAppealService(store);

  /** Версия чек-листа, по которой поставлена оценка (null, если её нет). */
  function checklistOf(evaluation) {
    try { return checklists.getArchived(evaluation.checklist.id, evaluation.checklist.version); } catch (_) { return null; }
  }

  /** Итог с учётом решённых апелляций — для списка диалогов. */
  function finalSummary(key) {
    const s = evaluations.summary(key);
    if (!s) return null;
    const mine = appeals.list({ dialogKey: key }).filter((a) => a.evaluation_id === s.id);
    const open = mine.filter((a) => a.status === 'open').length;
    const decided = mine.filter((a) => a.status === 'kept' || a.status === 'changed');
    const changed = decided.filter((a) => a.status === 'changed');
    let total = s.total; let computable = s.computable; let gross = s.gross_flagged;
    if (changed.length) {
      const e = evaluations.latest(key);
      const cl = checklistOf(e);
      if (cl) {
        const r = totalWith(cl, e.answers, appeals.overridesFor(e.id));
        total = r.total; computable = r.computable; gross = r.gross.flagged;
      }
    }
    return {
      ...s,
      ai_total: s.total, total, computable, gross_flagged: gross,
      appeals: { open, decided: decided.length, changed: changed.length },
    };
  }

  /** Последняя оценка ИИ этого диалога (для повторного использования неизменившихся критериев). */
  function lastAiEvaluation(key) {
    const h = evaluations.history(key);
    for (let i = h.length - 1; i >= 0; i--) if (h[i].source === 'ai') return h[i];
    return null;
  }

  async function evaluateDialog(key, { mode = 'mock', checklistId, force = false } = {}) {
    await checklistsReady;
    const record = dialogs.get(key);
    if (!record) throw new HttpError(404, `Диалог ${key} не найден.`);
    if (mode !== 'mock' && mode !== 'ai') throw new HttpError(400, 'mode: "ai" или "mock".');
    const cl = checklistId ? checklists.get(checklistId) : checklists.getActive();
    if (!cl) throw new HttpError(409, 'Нет чек-листа для оценки.');
    const checklistRef = { id: cl.id, version: cl.version, name: cl.name };
    if (mode === 'mock') {
      const { answers, summary } = mockEvaluate(record, cl);
      return withStaleAppeals(key, await evaluations.save(key, { record, checklist: cl, checklistRef, answers, source: 'mock', model: 'mock-rules', summary, usage: null }));
    }
    if (!ai.available) throw new HttpError(503, ai.keyProblem || 'ИИ не подключён: добавьте OPENROUTER_API_KEY в .env и перезапустите сервер.');
    const prev = lastAiEvaluation(key);
    let out;
    try {
      out = await ai.evaluate(record, cl, { previous: prev && prev.answers, previousSummary: prev && prev.summary, force });
    } catch (err) {
      if (err.cause) console.error('[ai] причина:', err.cause);   // только код ошибки, без ключа
      const e = new HttpError(err.status || 502, err.message);
      e.fatal = Boolean(err.fatal);
      e.usage = err.usage || null;   // сколько потрачено на неудачные попытки
      throw e;
    }
    return withStaleAppeals(key, await evaluations.save(key, {
      record, checklist: cl, checklistRef, answers: out.answers, source: 'ai', model: out.model, summary: out.summary,
      usage: { ...out.usage, provider: out.served_by || ai.provider || null, reused: out.reused, asked: out.asked, retried: out.retried },
    }));
  }

  /** Новая оценка: открытые апелляции прежней оценки закрываются (решать уже нечего). */
  async function withStaleAppeals(key, saved) {
    // Оценка уже сохранена (и, может быть, оплачена) — сбой записи апелляций её не отменяет.
    // Даже если закрыть не удалось, решить такую апелляцию нельзя: решение принимается только по текущей оценке.
    try {
      saved.appeals_closed = await appeals.closeStale(key, saved.evaluation.id);
    } catch (err) {
      console.error('[appeals] не удалось закрыть апелляции прежней оценки:', err.message);
      saved.appeals_closed = 0;
    }
    return saved;
  }

  /** Апелляция → контекст: её оценка и версия чек-листа. */
  function appealContext(a) {
    const e = evaluations.history(a.dialog_key).find((x) => x.id === a.evaluation_id);
    if (!e) throw new HttpError(409, 'Оценка, к которой относится апелляция, не найдена.');
    const cl = checklistOf(e);
    if (!cl) throw new HttpError(409, 'Чек-лист этой оценки не найден.');
    return { evaluation: e, checklist: cl };
  }

  function appealView(a) {
    const d = dialogs.get(a.dialog_key);
    return { ...a, dialog: d ? { key: d.key, conversation_id: d.conversation_id, channel: d.channel, language: d.language } : null };
  }

  /** После импорта ставим записи звонков в очередь на скачивание. */
  function withAudio(result) {
    result.audio_queued = autoDownloadAudio ? audio.enqueue(result.keys || []) : 0;
    return result;
  }

  /* ---------- выгрузка результатов (results/<dev|prod>/results.json) ---------- */

  const RESULT_TARGETS = { dev: null, prod: 10 };   // сколько записей должно быть (prod — ровно 10)

  function resultTarget(groupId, raw) {
    const t = String(raw || '').trim().toLowerCase() || (groupId === 'DEV' ? 'dev' : 'prod');
    if (!Object.prototype.hasOwnProperty.call(RESULT_TARGETS, t)) throw new HttpError(400, 'Папка выгрузки: "dev" или "prod".');
    return t;
  }

  /** Диалоги набора (пустой groupId — все) в исходном порядке. */
  function recordsOf(groupId) {
    return Object.values(store.get('dialogs', {}))
      .filter((r) => !groupId || r.group_id === groupId)
      .sort((a, b) => String(a.group_id).localeCompare(String(b.group_id)) || (a.order ?? 0) - (b.order ?? 0) || String(a.conversation_id).localeCompare(String(b.conversation_id)));
  }

  /** Диалог → последняя оценка, её версия чек-листа и апелляции этой оценки. */
  function evaluatedItem(record) {
    const evaluation = evaluations.latest(record.key);
    const checklist = evaluation ? checklistOf(evaluation) : null;
    const decided = evaluation ? appeals.list({ dialogKey: record.key }).filter((a) => a.evaluation_id === evaluation.id) : [];
    return { record, evaluation, checklist, appeals: decided };
  }

  /** Файл результатов по набору + предупреждения (не попадают в файл). */
  async function buildResultsFor(groupId, team) {
    await checklistsReady;
    const records = recordsOf(groupId);
    if (!records.length) throw new HttpError(404, `Набор ${groupId} не загружен.`);
    const active = checklists.getActive();
    const warnings = [];
    const oldChecklist = [];
    const notAi = [];
    const review = [];
    let defaultKeys = true;
    const defaults = new Set(results.ORG_CRITERIA.map((x) => x.key));
    const items = records.map((record) => {
      const item = evaluatedItem(record);
      const { evaluation, checklist } = item;
      if (evaluation) {
        if (active && (evaluation.checklist.id !== active.id || evaluation.checklist.version !== active.version)) oldChecklist.push(record.conversation_id);
        if (evaluation.source !== 'ai') notAi.push(record.conversation_id);
        if (evaluation.result && evaluation.result.needs_review) review.push(record.conversation_id);
      }
      if (checklist && checklist.criteria.some((c) => !defaults.has(c.key))) defaultKeys = false;
      return item;
    });
    const doc = results.buildResults(items, { teamName: team || teamName, fallbackModel: ai.model });
    const errors = doc.results.filter((r) => r.status === 'error');
    if (errors.length) warnings.push(`Без оценки или с ошибкой (status "error"): ${errors.length} — ${errors.map((r) => r.conversation_id).join(', ')}.`);
    if (oldChecklist.length) warnings.push(`Оценены не по действующему чек-листу${active ? ` («${active.name}», версия ${active.version})` : ''}: ${oldChecklist.length} — ${oldChecklist.join(', ')}. Оцените их заново.`);
    if (notAi.length) warnings.push(`Подставная оценка, не ИИ: ${notAi.length} — ${notAi.join(', ')}.`);
    if (review.length) warnings.push(`Помечены «нужна проверка человеком»: ${review.length} — ${review.join(', ')}.`);
    return { doc, warnings, defaultKeys };
  }

  // Ответ API организаторов после «Проверить» держим 5 минут,
  // чтобы «Загрузить» не скачивал набор второй раз.
  const previewCache = new Map();
  const PREVIEW_TTL_MS = 5 * 60 * 1000;

  async function getDataset(groupId) {
    const cached = previewCache.get(groupId);
    if (cached && Date.now() - cached.at < PREVIEW_TTL_MS) return cached;
    let fetched;
    try { fetched = await fetchDataset(orgApiUrl, groupId); } catch (err) { throw new HttpError(502, err.message); }
    // Ключ набора — код, который ввёл пользователь (уже в верхнем регистре).
    const entry = { at: Date.now(), groupId, records: fetched.records };
    previewCache.set(groupId, entry);
    return entry;
  }

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, dialogs: dialogs.list().length })],

    // Подключён ли ИИ (ключ не отдаётся — только факт и модель).
    ['GET', /^\/api\/ai$/, () => ({ available: ai.available, problem: ai.keyProblem || null, model: ai.model, provider: ai.provider || null, reasoning: ai.reasoningEffort })],

    ['GET', /^\/api\/datasets$/, () => ({ items: dialogs.listDatasets() })],

    ['GET', /^\/api\/dialogs$/, (req, url) => ({
      items: dialogs.list({ q: url.searchParams.get('q') }).map((d) => ({ ...d, evaluation: finalSummary(d.key) })),
    })],

    // Оценка диалога: последняя оценка + версия чек-листа, по которой её считали (для пересчёта баллов в браузере).
    ['GET', /^\/api\/dialogs\/([^/]+)\/evaluation$/, async (req, url, m) => {
      await checklistsReady;
      const key = decodeKey(m[1]);
      if (!dialogs.get(key)) throw new HttpError(404, `Диалог ${key} не найден.`);
      const e = evaluations.latest(key);
      if (!e) throw new HttpError(404, 'Диалог ещё не оценён.');
      let checklist;
      try { checklist = checklists.getArchived(e.checklist.id, e.checklist.version); } catch (_) {
        throw new HttpError(410, 'Чек-лист, по которому была оценка, не найден. Оцените диалог заново.');
      }
      return {
        evaluation: e,
        checklist,
        history: evaluations.history(key).map((x) => ({ id: x.id, created_at: x.created_at, source: x.source, checklist: x.checklist, total: x.result.total })),
        appeals: appeals.list({ dialogKey: key }).filter((a) => a.evaluation_id === e.id).sort((a, b) => a.no - b.no),
      };
    }],

    // Апелляции
    ['POST', /^\/api\/dialogs\/([^/]+)\/appeals$/, async (req, url, m) => {
      await checklistsReady;
      const body = await readJsonBody(req);
      const key = decodeKey(m[1]);
      const record = dialogs.get(key);
      if (!record) throw new HttpError(404, `Диалог ${key} не найден.`);
      if (body.role && body.role !== 'analyst') throw new HttpError(403, 'Апелляцию подаёт аналитик. Переключите роль на «Аналитик».');
      const e = evaluations.latest(key);
      const cl = e ? checklistOf(e) : null;
      if (e && !cl) throw new HttpError(409, 'Чек-лист этой оценки не найден.');
      const appeal = await appeals.create({ dialogKey: key, evaluation: e, checklist: cl, record }, body);
      return { appeal: appealView(appeal), counts: appeals.counts() };
    }],

    ['GET', /^\/api\/appeals$/, (req, url) => {
      const status = ['open', 'decided', 'all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'all';
      return { items: appeals.list({ status }).map(appealView), counts: appeals.counts() };
    }],

    ['GET', /^\/api\/appeals\/(ap_[a-z0-9]{4,40})$/, async (req, url, m) => {
      await checklistsReady;
      const a = appeals.get(m[1]);
      let ctx = null;
      try { ctx = appealContext(a); } catch (_) { /* оценку удалили — покажем снимки из апелляции */ }
      const latest = evaluations.latest(a.dialog_key);
      return {
        appeal: appealView(a),
        checklist: ctx ? ctx.checklist : null,
        evaluation: ctx ? { id: ctx.evaluation.id, source: ctx.evaluation.source, model: ctx.evaluation.model, answers: ctx.evaluation.answers } : null,
        overrides: appeals.overridesFor(a.evaluation_id),
        is_current: Boolean(latest && latest.id === a.evaluation_id),
      };
    }],

    ['POST', /^\/api\/appeals\/(ap_[a-z0-9]{4,40})\/decision$/, async (req, url, m) => {
      await checklistsReady;
      const body = await readJsonBody(req);
      if (body.role !== 'reviewer') throw new HttpError(403, 'Решение принимает проверяющий. Переключите роль на «Проверяющий».');
      const a = appeals.get(m[1]);
      const latest = evaluations.latest(a.dialog_key);
      if (a.status === 'open' && (!latest || latest.id !== a.evaluation_id)) {
        await appeals.closeStale(a.dialog_key, latest ? latest.id : null).catch(() => {});
        throw new HttpError(409, 'Апелляция закрыта: по диалогу сделана новая оценка.');
      }
      const appeal = await appeals.decide(a.id, appealContext(a), body);
      return { appeal: appealView(appeal), counts: appeals.counts() };
    }],

    // Удалить все апелляции — для репетиции демо (сайт локальный, входа нет).
    ['POST', /^\/api\/appeals\/reset$/, async (req) => {
      const body = await readJsonBody(req);
      if (body.confirm !== true) throw new HttpError(400, 'Нужно подтверждение: { "confirm": true }.');
      await appeals.reset();
      return { ok: true, counts: appeals.counts() };
    }],

    ['POST', /^\/api\/dialogs\/([^/]+)\/evaluate$/, async (req, url, m) => {
      const body = await readJsonBody(req);
      const { evaluation, problems } = await evaluateDialog(decodeKey(m[1]), { mode: body.mode || 'mock', checklistId: body.checklist_id, force: body.force === true });
      return { evaluation, problems };
    }],

    // Оценить несколько диалогов (кнопка «Оценить выбранные»).
    ['POST', /^\/api\/evaluate$/, async (req) => {
      const body = await readJsonBody(req);
      const keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === 'string').slice(0, 500) : [];
      if (!keys.length) throw new HttpError(400, 'Не выбраны диалоги для оценки.');
      const mode = body.mode || 'mock';
      if (mode !== 'mock' && mode !== 'ai') throw new HttpError(400, 'mode: "ai" или "mock".');
      if (mode === 'ai' && !ai.available) throw new HttpError(503, 'ИИ не подключён: добавьте OPENROUTER_API_KEY в .env и перезапустите сервер.');
      const done = [];
      const failed = [];
      let fatal = null;
      let cost = 0;
      // ИИ — по несколько диалогов одновременно; подставная — по очереди (она мгновенная).
      const queue = keys.slice();
      const worker = async () => {
        while (queue.length && !fatal) {
          const key = queue.shift();
          try {
            const { evaluation } = await evaluateDialog(key, { mode, checklistId: body.checklist_id, force: body.force === true });
            done.push({ key, total: evaluation.result.total, reused: evaluation.usage ? (evaluation.usage.reused || []).length : 0 });
            if (evaluation.usage) cost += evaluation.usage.cost_usd || 0;
          } catch (err) {
            if (err.usage) cost += err.usage.cost_usd || 0;   // неудачные попытки тоже списываются
            failed.push({ key, error: err.message, ...(err.fatal ? { fatal: true } : {}) });
            if (err.fatal && !fatal) fatal = err;   // нет денег или неверный ключ — новые не начинаем
          }
        }
      };
      const n = mode === 'ai' ? Math.min(aiOptions.concurrency || 8, keys.length) : 1;
      await Promise.all(Array.from({ length: n }, worker));
      return {
        done: done.length, failed, items: done,
        stopped: fatal ? fatal.message : null,
        not_started: queue.length,
        not_started_keys: queue.slice(),
        cost_usd: Math.round(cost * 1e6) / 1e6,
      };
    }],

    ['GET', /^\/api\/dialogs\/([^/]+)$/, (req, url, m) => {
      const key = decodeKey(m[1]);
      const record = dialogs.get(key);
      if (!record) throw new HttpError(404, `Диалог ${key} не найден.`);
      return record;
    }],

    // Чек-листы (версии только добавляются; PUT сохраняет новую версию).
    ['GET', /^\/api\/checklists$/, async () => { await checklistsReady; return { items: checklists.list() }; }],
    ['GET', /^\/api\/checklists\/active$/, async () => {
      await checklistsReady;
      const cl = checklists.getActive();
      if (!cl) throw new HttpError(404, 'Чек-листов нет.');
      return cl;
    }],
    ['GET', /^\/api\/checklists\/([a-z][a-z0-9-]{1,40})$/, async (req, url, m) => { await checklistsReady; return checklists.get(m[1]); }],
    ['GET', /^\/api\/checklists\/([a-z][a-z0-9-]{1,40})\/versions\/(\d{1,6})$/, async (req, url, m) => { await checklistsReady; return checklists.get(m[1], m[2]); }],
    ['POST', /^\/api\/checklists$/, async (req) => { await checklistsReady; return checklists.create(await readJsonBody(req, CHECKLIST_MAX_BODY)); }],
    ['PUT', /^\/api\/checklists\/([a-z][a-z0-9-]{1,40})$/, async (req, url, m) => { await checklistsReady; return checklists.save(m[1], await readJsonBody(req, CHECKLIST_MAX_BODY)); }],
    ['POST', /^\/api\/checklists\/([a-z][a-z0-9-]{1,40})\/activate$/, async (req, url, m) => { req.resume(); await checklistsReady; return checklists.activate(m[1]); }],
    ['DELETE', /^\/api\/checklists\/([a-z][a-z0-9-]{1,40})$/, async (req, url, m) => { req.resume(); await checklistsReady; return checklists.remove(m[1]); }],

    // Статистика (вкладка «Статистика»): по набору или по всем; фильтры канала и языка.
    ['GET', /^\/api\/stats$/, async (req, url) => {
      await checklistsReady;
      const raw = url.searchParams.get('group_id') || '';
      const groupId = raw ? requireGroupId(raw) : '';
      const items = recordsOf(groupId).map((r) => ({ ...evaluatedItem(r), history: evaluations.history(r.key) }));
      return { group_id: groupId || null, ...computeStats(items, { channel: url.searchParams.get('channel') || '', language: url.searchParams.get('language') || '' }) };
    }],

    // Выгрузка результатов в формате организаторов: посмотреть и записать в results/<dev|prod>/results.json.
    ['GET', /^\/api\/results$/, async (req, url) => {
      const groupId = requireGroupId(url.searchParams.get('group_id'));
      const target = resultTarget(groupId, url.searchParams.get('target'));
      const { doc, warnings, defaultKeys } = await buildResultsFor(groupId, url.searchParams.get('team_name'));
      const problems = results.validateResults(doc, { expectedCount: RESULT_TARGETS[target], strictValues: defaultKeys });
      return { target, file: `results/${target}/results.json`, problems, warnings, document: doc };
    }],

    ['POST', /^\/api\/results\/export$/, async (req) => {
      const body = await readJsonBody(req);
      const groupId = requireGroupId(body.group_id);
      const target = resultTarget(groupId, body.target);
      const { doc, warnings, defaultKeys } = await buildResultsFor(groupId, body.team_name);
      const problems = results.validateResults(doc, { expectedCount: RESULT_TARGETS[target], strictValues: defaultKeys });
      const dir = path.join(resultsDir, target);
      const file = path.join(dir, 'results.json');
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      await fs.promises.rename(tmp, file);
      const ok = doc.results.filter((r) => r.status === 'ok').length;
      return {
        target, file: `results/${target}/results.json`,
        total: doc.results.length, ok, errors: doc.results.length - ok,
        team_name: doc.team_name, model: doc.model, problems, warnings,
      };
    }],

    // Запись звонка: состояние, скачать сейчас, сам файл (с поддержкой перемотки).
    ['GET', /^\/api\/dialogs\/([^/]+)\/audio\/status$/, (req, url, m) => {
      const st = audio.status(decodeKey(m[1]));
      if (!st) throw new HttpError(404, 'Диалог не найден.');
      return st;
    }],

    ['POST', /^\/api\/dialogs\/([^/]+)\/audio\/fetch$/, async (req, url, m) => {
      req.resume();
      return audio.ensure(decodeKey(m[1]));
    }],

    ['GET', /^\/api\/dialogs\/([^/]+)\/audio$/, (req, url, m) => {
      const key = decodeKey(m[1]);
      const st = audio.status(key);
      if (!st) throw new HttpError(404, 'Диалог не найден.');
      if (st.state !== 'ready') throw new HttpError(404, 'Запись ещё не скачана.');
      return { __raw: (res) => sendFileRange(req, res, audio.filePath(key), 'audio/mpeg') };
    }],

    // «Проверить»: скачать набор и показать, что в нём, без сохранения.
    ['POST', /^\/api\/import\/preview$/, async (req) => {
      const body = await readJsonBody(req);
      const ds = await getDataset(requireGroupId(body.group_id));
      return dialogs.preview(ds.groupId, ds.records);
    }],

    // «Загрузить» из API организаторов.
    ['POST', /^\/api\/import\/api$/, async (req) => {
      const body = await readJsonBody(req);
      const groupId = requireGroupId(body.group_id);
      const ds = await getDataset(groupId);
      const result = await dialogs.saveRecords(ds.groupId, ds.records, 'api');
      previewCache.delete(groupId);
      return withAudio(result);
    }],

    // JSON-файл: формат API организаторов, массив записей или одна запись.
    ['POST', /^\/api\/import\/json$/, async (req) => {
      const body = await readJsonBody(req);
      const extracted = extractRecords(body.payload);
      if (extracted.error) throw new HttpError(422, extracted.error);
      if (!extracted.records.length) throw new HttpError(422, 'В файле нет диалогов.');
      const groupId = dialogs.resolveGroupId(body.group_id, null) || dialogs.resolveGroupId(extracted.groupId, 'FILE');
      return withAudio(await dialogs.saveRecords(groupId, extracted.records, 'file'));
    }],

    // Транскрипт, вставленный текстом.
    ['POST', /^\/api\/import\/text$/, async (req) => {
      const body = await readJsonBody(req);
      return dialogs.saveFromText(body);
    }],
  ];

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // запрос не из браузера (curl, сервер) или с того же адреса
    if (allowedOrigins.includes(origin)) return true;
    try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
  }

  function sendJson(req, res, status, data, extraHeaders) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    };
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  }

  async function handleApi(req, res, url) {
    if (!originAllowed(req)) {
      sendJson(req, res, 403, { error: 'Запрос с чужого сайта запрещён.' });
      req.resume();
      return;
    }
    if (req.method === 'OPTIONS') {
      const headers = { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
      if (req.headers.origin && allowedOrigins.includes(req.headers.origin)) {
        headers['Access-Control-Allow-Origin'] = req.headers.origin;
        headers.Vary = 'Origin';
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if ((req.method === 'POST' || req.method === 'PUT') && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      req.resume();
      sendJson(req, res, 415, { error: 'Нужен Content-Type: application/json.' });
      return;
    }

    // HEAD обрабатываем как GET (плеер и проверки иногда спрашивают только заголовки).
    const wanted = req.method === 'HEAD' ? 'GET' : req.method;
    const route = routes.find(([method, re]) => method === wanted && re.test(url.pathname));
    if (!route) {
      req.resume();
      const known = routes.some(([, re]) => re.test(url.pathname));
      sendJson(req, res, known ? 405 : 404, { error: known ? 'Этот метод здесь не поддерживается.' : 'Такого адреса API нет.' });
      return;
    }
    const [, re, handler] = route;
    try {
      const result = await handler(req, url, re.exec(url.pathname));
      if (result && typeof result.__raw === 'function') { result.__raw(res); return; }
      sendJson(req, res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[api]', req.method, url.pathname, err.cause || err);
      const message = status === 500 ? 'Внутренняя ошибка сервера. Подробности — в окне, где запущен сервер.' : err.message;
      sendJson(req, res, status, { error: message }, status === 413 ? { Connection: 'close' } : undefined);
    }
  }

  return { handleApi, dialogs, audio, checklists, checklistsReady, evaluations };
}

/* ---------- отдача файла с поддержкой Range (перемотка в плеере) ---------- */

/**
 * Отдаёт файл; поддерживает один диапазон «bytes=a-b», «bytes=a-», «bytes=-n» и HEAD.
 * Поток читается через pipeline: если браузер оборвал запрос (перемотка, переход
 * к другому диалогу), файл закрывается; ошибка чтения не роняет сервер.
 */
function sendFileRange(req, res, file, contentType) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Файл записи не найден.' }));
      return;
    }
    const size = stat.size;
    const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };

    let start = 0;
    let end = size - 1;
    let status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    // Непонятный или составной Range по стандарту игнорируем и отдаём файл целиком.
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] !== '') {
        start = Number(m[1]);
        end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(m[2]));
      }
      if (start >= size || start > end) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    pipeline(fs.createReadStream(file, { start, end }), res, () => { /* обрыв клиентом или ошибка чтения — поток уже закрыт */ });
  });
}

/* ---------- статика (сайт) ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (_) { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(config.FRONTEND_DIR, '.' + rel);
  if (!file.startsWith(config.FRONTEND_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
      return;
    }
    // no-cache: браузер всегда проверяет свежесть, правки видны сразу.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* ---------- запуск ---------- */

function createServer(options) {
  const app = createApp(options);
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) app.handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else { res.writeHead(405); res.end(); }
  });
}

if (require.main === module) {
  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Порт ${config.PORT} уже занят — скорее всего, CQA уже запущен. Откройте http://localhost:${config.PORT} или запустите на другом порту: PORT=3001 npm start`);
    } else {
      console.error('Не удалось запустить сервер:', err.message);
    }
    process.exit(1);
  });
  server.listen(config.PORT, config.HOST, () => {
    console.log(`CQA запущен: http://localhost:${config.PORT}`);
    console.log(`Данные хранятся в ${config.DATA_DIR}`);
  });
}

module.exports = { createServer, createApp };
