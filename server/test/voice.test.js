'use strict';

/* Голос оператора в звонке: замер по записи без ИИ (frontend/js/voice.js). */

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../../frontend/js/voice');

const SR = 8000;

/** Синтетическая запись: отрезки «речи» синусом заданной высоты и громкости, остальное — тихий шум. */
function signal(total, parts) {
  const x = new Float32Array(Math.round(total * SR));
  let seed = 1;
  for (let i = 0; i < x.length; i++) { seed = (seed * 16807) % 2147483647; x[i] = ((seed / 2147483647) - 0.5) * 0.002; }
  for (const p of parts) {
    for (let i = Math.round(p.start * SR); i < Math.round(p.end * SR); i++) x[i] += p.amp * Math.sin(2 * Math.PI * p.f0 * (i / SR));
  }
  return x;
}

const words = (n) => Array.from({ length: n }, (_, i) => 'слово' + i).join(' ');

test('высота голоса: автокорреляция находит основной тон', () => {
  const x = signal(1, [{ start: 0, end: 1, f0: 150, amp: 0.3 }]);
  const f = V._pitchAt(x, SR, 1000, 320);
  assert.ok(Math.abs(f - 150) < 6, `найдено ${f} Гц`);
});

test('громче и выше обычного → «напряжённо»; ровные реплики не отмечаются; пауза перед ответом', () => {
  // 5 реплик оператора по 3 с: обычные — 120 Гц, тихо; №4 (индекс 6) — громче в 3 раза и 160 Гц
  const parts = [];
  const transcript = [];
  const spans = [];
  let t = 1;
  for (let k = 0; k < 5; k++) {
    // клиент
    parts.push({ start: t, end: t + 1.5, f0: 200, amp: 0.1 });
    transcript.push({ speaker: 'client', text: 'вопрос клиента' });
    spans.push({ start: t, end: t + 1.5 });
    t += 1.5 + (k === 2 ? 10 : 0.5);            // перед ответом №3 — пауза 10 с
    const loud = k === 3;
    parts.push({ start: t, end: t + 3, f0: loud ? 160 : 120, amp: loud ? 0.3 : 0.1 });
    transcript.push({ speaker: 'operator', text: words(8) });
    spans.push({ start: t, end: t + 3 });
    t += 3.5;
  }
  const v = V.analyze(signal(t + 1, parts), SR, transcript, spans, {});
  assert.equal(v.enough, true);
  assert.ok(Math.abs(v.baseline.f0 - 120) < 8, `обычная высота ${v.baseline.f0}`);
  const loud = v.turns[7];
  assert.ok(loud.flags.some((f) => f.type === 'loud'), 'громче');
  assert.ok(loud.flags.some((f) => f.type === 'high'), 'выше');
  assert.equal(loud.tense, true);
  const paused = v.turns[5];
  assert.ok(paused.flags.some((f) => f.type === 'pause'), 'пауза 10 с перед ответом');
  assert.deepEqual(v.turns[1].flags, [], 'обычная реплика без отметок');
  assert.deepEqual(v.flagged.sort((a, b) => a - b), [5, 7]);
});

test('удержание, бот между клиентом и оператором, скрытые данные — без ложных отметок', () => {
  const parts = [{ start: 1, end: 2, f0: 200, amp: 0.1 }, { start: 15, end: 18, f0: 120, amp: 0.1 }, { start: 20, end: 23, f0: 160, amp: 0.4 }];
  const transcript = [
    { speaker: 'client', text: 'алло' },
    { speaker: 'bot', text: 'ожидайте ответа оператора' },
    { speaker: 'operator', text: 'Здравствуйте, меня зовут [Имя скрыто], чем помочь?' },
    { speaker: 'operator', text: words(8) },
  ];
  const spans = [{ start: 1, end: 2 }, null, { start: 15, end: 18 }, { start: 20, end: 23 }];
  const v = V.analyze(signal(25, parts), SR, transcript, spans, { holds: [[19.5, 23.5]] });
  assert.equal(v.turns[2].gap, null, 'ожидание после бота — не пауза оператора');
  assert.equal(v.turns[2].rate, null, 'в тексте скрытое имя — темп не считаем');
  assert.equal(v.turns[3].on_hold, true);
  assert.deepEqual(v.turns[3].flags, [], 'реплика во время удержания не сравнивается');
});

test('мало реплик — без сравнения; невозможный темп отбрасывается', () => {
  const parts = [{ start: 1, end: 1.9, f0: 120, amp: 0.1 }];
  const v = V.analyze(signal(3, parts), SR, [{ speaker: 'operator', text: words(30) }], [{ start: 1, end: 1.9 }], {});
  assert.equal(v.enough, false);
  assert.equal(v.turns[0].rate, null, '30 слов за 0,9 с — реплика неточно легла на запись');
  assert.deepEqual(v.flagged, []);
});
