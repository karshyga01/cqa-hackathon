'use strict';

/*
 * Метки времени в данных организаторов бывают двух видов:
 *   чаты   — "MM:SS" (иногда может прийти "H:MM:SS");
 *   звонки — ISO 8601 с часовым поясом и 7 знаками долей секунды:
 *            "2026-11-03T15:49:13.1900670+00:00".
 * Исходную строку мы всегда сохраняем как есть. Здесь только вычисляем
 * смещение от начала разговора в секундах — для показа и для плеера.
 */

const CLOCK_RE = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function parseTimestamp(ts) {
  if (ts === null || ts === undefined) return { kind: 'none' };
  const s = String(ts).trim();
  if (!s) return { kind: 'none' };

  const m = CLOCK_RE.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const seconds = m[3] === undefined ? a * 60 + b : a * 3600 + b * 60 + Number(m[3]);
    return { kind: 'clock', seconds };
  }

  if (ISO_RE.test(s)) {
    // Date.parse надёжно понимает только до 3 знаков долей секунды.
    const ms = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
    if (!Number.isNaN(ms)) return { kind: 'iso', ms };
  }

  return { kind: 'unknown' };
}

/** Смещения (в секундах от начала) для каждой реплики. null — если время не распознано. */
function computeOffsets(turns) {
  const parsed = turns.map((t) => parseTimestamp(t && t.timestamp));
  const firstIso = parsed.find((p) => p.kind === 'iso');
  const base = firstIso ? firstIso.ms : null;
  return parsed.map((p) => {
    if (p.kind === 'clock') return p.seconds;
    if (p.kind === 'iso' && base !== null) return Math.max(0, Math.round(p.ms - base) / 1000); // с точностью до мс
    return null;
  });
}

function formatClock(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return '';
  const sec = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

module.exports = { parseTimestamp, computeOffsets, formatClock };
