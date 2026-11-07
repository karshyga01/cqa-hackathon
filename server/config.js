'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Читаем .env без сторонних библиотек: строки вида KEY=value, # — комментарий.
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

// Адрес API организаторов из задания (кнопка «Открыть GET для DEV»).
// group_id подставляется при запросе.
const DEFAULT_ORG_API_URL =
  'https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/11/workflows/b3d2a68006a24662be2b721454cb4e00/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=5Sog2MThgCRTlk3HObv70LRmRk6u7IOwzlwMpe804qo';

module.exports = {
  ROOT,
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '127.0.0.1',
  ORG_API_URL: process.env.ORG_API_URL || DEFAULT_ORG_API_URL,
  DATA_DIR: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  // Адреса других сайтов, которым можно обращаться к API (например, Dynamics 365), через запятую.
  ALLOWED_ORIGINS: String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Домены, с которых сервер может скачивать записи звонков (через запятую, *.домен — с поддоменами).
  AUDIO_ALLOWED_HOSTS: process.env.AUDIO_ALLOWED_HOSTS
    ? process.env.AUDIO_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['*.api.powerplatform.com', '*.dynamics.com'],
  FRONTEND_DIR: path.join(ROOT, 'frontend'),
  // Выгрузка результатов для организаторов: results/dev/results.json и results/prod/results.json.
  RESULTS_DIR: path.join(ROOT, 'results'),
  TEAM_NAME: process.env.TEAM_NAME || '',
  // Загрузка своей записи звонка: распознавание речи локально (whisper.cpp), звук никуда не уходит.
  ASR: {
    cli: process.env.WHISPER_CLI || 'whisper-cli',
    ffmpeg: process.env.FFMPEG || 'ffmpeg',
    model: path.resolve(ROOT, process.env.WHISPER_MODEL || 'data/models/ggml-large-v3-turbo-q5_0.bin'),
    language: process.env.WHISPER_LANG || 'auto',
  },
  // Оценка ИИ через OpenRouter (шаг 5). Без ключа доступна только подставная оценка.
  AI: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash-1017',
    provider: process.env.OPENROUTER_PROVIDER === undefined ? 'together' : process.env.OPENROUTER_PROVIDER,
    reasoningEffort: process.env.OPENROUTER_REASONING || 'medium',
    concurrency: Math.min(16, Math.max(1, Number(process.env.OPENROUTER_CONCURRENCY) || 8)),
  },
};
