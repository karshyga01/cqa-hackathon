'use strict';

/*
 * Распознавание речи ЛОКАЛЬНО (whisper.cpp) — для загрузки своей записи звонка.
 * Звук не покидает компьютер. Нужны программы ffmpeg и whisper-cli и модель whisper
 * (по умолчанию data/models/ggml-large-v3-turbo-q5_0.bin) — см. README.
 *
 *   запись → ffmpeg (16 кГц, моно, wav) → whisper-cli (-oj) → фразы { start, end, text }
 *
 * Кто говорит (оператор / клиент / автоответчик), whisper в моно-записи не различает —
 * роли расставляет текстовый ИИ по смыслу (aiEvaluator.assignRoles), звук при этом никуда не уходит.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function run(cmd, args, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (err) { reject(err); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${path.basename(cmd)}: не уложился в ${Math.round(timeoutMs / 60000)} мин`)); }, timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(stderr) : reject(Object.assign(new Error(`${path.basename(cmd)} завершился с кодом ${code}`), { stderr })); });
  });
}

function createAsr({ cli = 'whisper-cli', ffmpeg = 'ffmpeg', model, language = 'auto', threads = 4 } = {}) {
  /** Что мешает распознаванию (пусто — всё на месте). */
  function problem() {
    if (!model || !fs.existsSync(model)) return `Нет модели whisper (${model || 'WHISPER_MODEL'}). Скачайте ggml-large-v3-turbo-q5_0.bin — см. README.`;
    for (const [bin, hint] of [[cli, 'whisper-cpp'], [ffmpeg, 'ffmpeg']]) {
      const r = spawnSync(bin, ['-h'], { stdio: 'ignore' });
      if (r.error) return `Не найдена программа ${bin}. Установите: brew install ${hint}.`;
    }
    return '';
  }

  /** Распознать файл записи. → { language, segments: [{ start, end, text }], seconds } */
  async function transcribe(inputPath) {
    const why = problem();
    if (why) throw Object.assign(new Error(why), { status: 503 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-asr-'));
    const wav = path.join(dir, 'audio.wav');
    const outBase = path.join(dir, 'out');
    const t0 = Date.now();
    try {
      try {
        await run(ffmpeg, ['-y', '-v', 'error', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { timeoutMs: 5 * 60 * 1000 });
      } catch (err) {
        throw Object.assign(new Error('Не удалось прочитать файл как аудио (поддерживаются mp3, wav, m4a, ogg и др.).'), { status: 422 });
      }
      await run(cli, ['-m', model, '-f', wav, '-l', language, '-oj', '-of', outBase, '-np', '-t', String(threads)]);
      const out = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
      const segments = (out.transcription || [])
        .map((s) => ({ start: (s.offsets && s.offsets.from) / 1000, end: (s.offsets && s.offsets.to) / 1000, text: String(s.text || '').trim() }))
        .filter((s) => s.text && Number.isFinite(s.start) && Number.isFinite(s.end));
      return { language: (out.result && out.result.language) || '', segments, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return { transcribe, problem, model };
}

/** Метка времени как у звонков организаторов: конец фразы (+0,7 с — так устроена сверка со звуком). */
function clock(sec) {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Фразы + роли → реплики: подряд идущие фразы одного говорящего с паузой меньше 1,5 с склеиваются.
 * @param segments [{ start, end, text }]
 * @param roles    ['operator' | 'client' | 'bot', ...] — по одной на фразу
 */
function toTurns(segments, roles) {
  const turns = [];
  segments.forEach((s, i) => {
    const speaker = roles[i] || 'client';
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker && s.start - last._end < 1.5) {
      last.text += ' ' + s.text;
      last._end = s.end;
    } else {
      turns.push({ speaker, text: s.text, _end: s.end });
    }
  });
  return turns.map((t) => ({ timestamp: clock(t._end + 0.7), speaker: t.speaker, text: t.text }));
}

const LANG = { ru: 'RU', kk: 'KZ', kz: 'KZ', en: 'EN' };

module.exports = { createAsr, toTurns, clock, LANG };
