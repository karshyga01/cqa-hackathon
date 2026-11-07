'use strict';

/* Подсчёт баллов: правила PDF (стр. 2), примеры из макета, крайние случаи и ловушка округления. */

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../frontend/js/scoring');
const M = require('../../frontend/js/checklist-model');
const DEFAULT = M.normalize(require('../defaults/checklist-chat'));

// Все «хорошие» ответы для чек-листа из задания.
const PERFECT = {
  c_contact: 'yes', c_needs: 'yes', c_identity: 'yes', c_consult: 20,
  c_empathy: 'yes', c_manage: 10, c_closing: 'yes', c_gross: 'no',
};
const crit = (r, key) => r.criteria.find((c) => c.key === key);
const sec = (r, key) => r.sections.find((s) => s.key === key);

test('всё выполнено идеально — 100 из 100', () => {
  const r = S.score(DEFAULT, PERFECT);
  assert.equal(r.computable, true);
  assert.equal(r.total, 100);
  assert.equal(r.gross.flagged, false);
  assert.deepEqual(r.errors, []);
});

test('пример из макета: 02 = N/A, 04 = 15 из 20, 07 = Нет → 88,24', () => {
  const r = S.score(DEFAULT, { ...PERFECT, c_needs: 'na', c_consult: 15, c_closing: 'no' });
  assert.equal(r.total, 88.24);
  assert.equal(r.applicable_weight, 85);
  // N/A исключён, вес 15 распределён: множитель 100/85
  assert.equal(crit(r, 'c_needs').applicable, false);
  assert.equal(crit(r, 'c_contact').max_points_rounded, 11.76);
  assert.equal(crit(r, 'c_identity').max_points_rounded, 23.53);
  assert.equal(crit(r, 'c_consult').points_rounded, 17.65);
  assert.equal(crit(r, 'c_consult').max_points_rounded, 23.53);
  assert.equal(crit(r, 'c_closing').points_rounded, 0);
  assert.equal(crit(r, 'c_closing').max_points_rounded, 5.88);
  // разделы
  assert.deepEqual([sec(r, 's_start').points_rounded, sec(r, 's_start').max_rounded], [11.76, 11.76]);
  assert.deepEqual([sec(r, 's_safety').points_rounded, sec(r, 's_safety').max_rounded], [41.18, 47.06]);
  assert.deepEqual([sec(r, 's_flow').points_rounded, sec(r, 's_flow').max_rounded], [35.29, 41.18]);
  assert.equal(sec(r, 's_gross').scored, false, 'раздел только с флагом — без баллов');
  assert.equal(sec(r, 's_start').na_count, 1);
});

test('после апелляции 07 = Да → 94,12', () => {
  const r = S.score(DEFAULT, { ...PERFECT, c_needs: 'na', c_consult: 15, c_closing: 'yes' });
  assert.equal(r.total, 94.12);
});

test('шкала пересчитывается пропорционально весу: 7 из 10 при весе 15 = 10,5', () => {
  const r = S.score(DEFAULT, { ...PERFECT, c_manage: 7 });
  assert.equal(crit(r, 'c_manage').earned, 10.5);
  assert.equal(r.total, 95.5);
  const zero = S.score(DEFAULT, { ...PERFECT, c_manage: 0, c_consult: 0 });
  assert.equal(zero.total, 65);
});

test('максимум всегда 100: сумма разделов совпадает с итогом', () => {
  const r = S.score(DEFAULT, { ...PERFECT, c_needs: 'na', c_identity: 'na', c_closing: 'na', c_consult: 10, c_manage: 4 });
  const maxSum = r.sections.filter((s) => s.max !== null).reduce((a, s) => a + s.max, 0);
  const ptsSum = r.sections.filter((s) => s.points !== null).reduce((a, s) => a + s.points, 0);
  assert.ok(Math.abs(maxSum - 100) < 1e-9);
  assert.ok(Math.abs(ptsSum - r.total_exact) < 1e-9);
});

test('грубая ошибка отмечается отдельно и итог не меняет', () => {
  const r = S.score(DEFAULT, { ...PERFECT, c_gross: 'yes' });
  assert.equal(r.gross.flagged, true);
  assert.equal(r.total, 100);
  assert.deepEqual(r.gross.criteria, [{ key: 'c_gross', name: 'Грубые ошибки', answer: 'yes' }]);
});

test('все критерии с весом N/A — итог не рассчитан (не 0 и не 100)', () => {
  const allNa = M.normalize({
    name: 'X', sections: [{ key: 's_a', name: 'A' }],
    criteria: [
      { key: 'c_a', section: 's_a', name: 'A', description: 'Описание критерия A для ИИ', type: 'yes_no', weight: 50, na_allowed: true, na_condition: 'нет запроса' },
      { key: 'c_b', section: 's_a', name: 'B', description: 'Описание критерия B для ИИ', type: 'yes_no', weight: 50, na_allowed: true, na_condition: 'нет запроса' },
      { key: 'c_f', section: 's_a', name: 'F', description: 'Флаг грубых ошибок для ИИ', type: 'flag' },
    ],
  });
  const r = S.score(allNa, { c_a: 'na', c_b: 'na', c_f: 'no' });
  assert.equal(r.computable, false);
  assert.equal(r.total, null);
  assert.deepEqual(r.errors, []);
  assert.match(r.reason, /не рассчитан/);
  assert.equal(r.sections[0].points, null);
});

test('сумма весов не 100 — итог всё равно из 100', () => {
  const cl = JSON.parse(JSON.stringify(DEFAULT));
  cl.criteria.find((c) => c.key === 'c_closing').weight = 10; // сумма 105
  assert.equal(S.score(cl, PERFECT).total, 100);
  const r = S.score(cl, { ...PERFECT, c_closing: 'no' });
  assert.equal(r.total, S.round2(95 / 105 * 100)); // 90,48
  assert.equal(r.total, 90.48);
});

test('ловушка округления: обычный Math.round ошибается, наш — нет', () => {
  const naive = (x) => Math.round(x * 100) / 100;
  // итог 100 × 1,15 ÷ 8 = 14,375 ровно, но JavaScript получает 14,374999999999998
  const total = 100 * 1.15 / 8;
  assert.equal(total, 14.374999999999998);
  assert.equal(naive(total), 14.37);       // неправильно
  assert.equal(S.round2(total), 14.38);    // правильно
  assert.equal(naive(8.575), 8.57);
  assert.equal(S.round2(8.575), 8.58);
  assert.equal(S.round2(88.235), 88.24);
  assert.equal(S.round2(1.005), 1.01);
  assert.equal(S.round2(2.675), 2.68);
  assert.equal(S.round2(88.2349), 88.23);
  assert.equal(S.round2(-1.005), -1.01);
  assert.equal(S.round2(0), 0);
  assert.ok(!Object.is(S.round2(-0.001), -0));
  // значение чуть меньше половины не округляется вверх (найдено проверкой кода)
  assert.equal(S.round2(50.53499999943771), 50.53);
  assert.equal(S.round2(76.714999999), 76.71);
});

test('«X из Y» с чужим знаменателем — ошибка, а не тихий пересчёт', () => {
  const bad = S.score(DEFAULT, { ...PERFECT, c_consult: '5 из 10', c_manage: '10/15' });
  const byKey = Object.fromEntries(bad.errors.map((e) => [e.key, e.message]));
  assert.match(byKey.c_consult, /шкала критерия 0–20, а в ответе «из 10»/);
  assert.match(byKey.c_manage, /шкала критерия 0–10, а в ответе «из 15»/);
  assert.equal(bad.total, null);
  const ok = S.score(DEFAULT, { ...PERFECT, c_consult: '15 из 20', c_manage: '7/10' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.total, 90.5);
});

test('неверные ответы не считаются, а возвращают понятную ошибку', () => {
  const r = S.score(DEFAULT, { ...PERFECT, c_consult: 12, c_contact: 'na', c_gross: 'na', c_manage: undefined });
  assert.equal(r.computable, false);
  assert.equal(r.total, null);
  const byKey = Object.fromEntries(r.errors.map((e) => [e.key, e.message]));
  assert.match(byKey.c_consult, /ступени 12 нет в шкале \(20, 15, 10, 5, 0\)/);
  assert.match(byKey.c_contact, /N\/A для этого критерия не разрешён/);
  assert.match(byKey.c_gross, /для флага N\/A не бывает/);
  assert.match(byKey.c_manage, /нет ответа/);
});

test('русские и смешанные варианты ответов понимаются', () => {
  const r = S.score(DEFAULT, {
    c_contact: 'Да', c_needs: 'N/A', c_identity: ' нет ', c_consult: '15 из 20',
    c_empathy: true, c_manage: '7', c_closing: { value: 'Нет' }, c_gross: 'НЕТ',
  });
  assert.deepEqual(r.errors, []);
  assert.equal(crit(r, 'c_consult').answer, 15);
  assert.equal(crit(r, 'c_consult').label, '15 из 20');
  assert.equal(crit(r, 'c_needs').label, 'N/A');
  assert.equal(crit(r, 'c_identity').answer, 'no');
});

test('ответ для неизвестного критерия — предупреждение, не ошибка', () => {
  const r = S.score(DEFAULT, { ...PERFECT, c_old: 'yes' });
  assert.equal(r.total, 100);
  assert.equal(r.warnings.length, 1);
});

test('после замены критерия считается по новой версии чек-листа', () => {
  const cl = JSON.parse(JSON.stringify(DEFAULT));
  const i = cl.criteria.findIndex((c) => c.key === 'c_empathy');
  cl.criteria[i] = { ...M.blankCriterion('s_flow', { weight: 15 }), key: 'c_personal', name: 'Персонализация', description: 'Да — обращался к клиенту по имени.' };
  const answers = { ...PERFECT, c_personal: 'no' };
  delete answers.c_empathy;
  const r = S.score(cl, answers);
  assert.equal(r.total, 85);
  assert.equal(crit(r, 'c_personal').max_points_rounded, 15);
});

test('formatPoints: запятая, целые без дробной части', () => {
  assert.equal(S.formatPoints(88.24), '88,24');
  assert.equal(S.formatPoints(94.1), '94,1');
  assert.equal(S.formatPoints(20), '20');
  assert.equal(S.formatPoints(17.647058823529413), '17,65');
  assert.equal(S.formatPoints(null), '—');
});
