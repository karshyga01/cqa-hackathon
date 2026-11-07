'use strict';

/*
 * ПОДСТАВНАЯ оценка (не ИИ) — простые правила по ключевым словам на русском, казахском и английском.
 * Нужна, чтобы проверить экран результата и переходы к репликам до подключения ИИ (шаг 5).
 * Выдаёт ответы ровно в том формате, который потом будет выдавать ИИ:
 *   { [ключ критерия]: { answer, explanation, evidence: [{turn, quote}], checked_range, na_reason, confidence } }
 * Номера реплик (turn) начинаются с 1. Цитаты — дословные куски реплик.
 */

const TL = require('../../frontend/js/timeline');

const RE = {
  greet: /здравствуй|добрый (день|вечер|утро)|доброе утро|приветству|сәлем|сәлеметсіз|қайырлы|hello|\bhi\b|good (morning|afternoon|evening)|welcome/i,
  intro: /меня зовут|мен[іi]ң атым|\bатым\b|my name is|this is [A-ZА-ЯӘҒҚҢӨҰҮҺІ]|i am [A-ZА-ЯӘҒҚҢӨҰҮҺІ]|i'm [A-ZА-ЯӘҒҚҢӨҰҮҺІ]/i,
  sensitive: /вывод|выве|перевод|баланс|пароль|номер сч[её]т|сч[её]т[ау]? |договор|паспорт|\bиин\b|персональн|карт[ау]|кабинет|қаражат|\bшот|құпия|withdraw|transfer|balance|password|account|passport|card/i,
  polite: /пожалуйста|спасибо|извин|понимаю|благодар|рахмет|өтінемін|кешірің|түсінем|please|thank|sorry|understand|apolog/i,
  wait: /минут|секунд|ожида|подожд|провер(ю|яю)|уточн(ю|яю)|күте|тексер|moment|minute|wait|let me check|checking/i,
  bye: /до свидания|всего доброго|хорошего (дня|вечера)|обращайтесь|остались ещё вопросы|ещё вопрос|могу ещё помочь|сау бол|қош|сәттілік|жақсы күн|тағы сұрақ|goodbye|\bbye\b|have a (nice|great|good)|anything else|further questions/i,
  gross: /переведите (мне|на мою)|на мою (личную )?карт|лично мне|мой (личный )?номер|в обход компании|напишите мне в (whatsapp|ватсап|телеграм)|личн(ую|ый) (карт|сч[её]т)|дурак|идиот/i,
};

// Цитата — дословный кусок реплики (по нему проверяется доказательство), обрезанный по границе слова.
// Многоточие дорисовывает интерфейс: он видит, что цитата — часть реплики.
function quoteOf(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= 90) return { quote: s };
  const cut = s.slice(0, 90);
  const sp = cut.lastIndexOf(' ');
  return { quote: (sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '') };
}

function analyze(record) {
  const T = record.transcript.map((t, i) => ({ ...t, n: i + 1 }));
  const ops = T.filter((t) => t.speaker === 'operator');
  const clients = T.filter((t) => t.speaker === 'client');
  const events = T.filter((t) => t.speaker === 'system').map((t) => ({ t, ev: TL.classifySystem(t.text) }));
  return { T, ops, clients, events };
}

const ev = (t) => [{ turn: t.n, ...quoteOf(t.text) }];

/* --- правила для критериев чек-листа из задания (по ключам) ---
 * У каждого правила свой тип ответа (TYPE_OF) и, для шкал, своя вершина (SCALE_OF).
 * Если в редакторе у критерия сменили тип — правило не подходит, ставим общий подставной ответ. */

const TYPE_OF = { c_consult: 'scale', c_manage: 'scale', c_gross: 'flag' }; // остальные — yes_no
const SCALE_OF = { c_consult: 20, c_manage: 10 };

const RULES = {
  c_contact({ ops }) {
    const first = ops[0];
    if (!first) return { answer: 'no', explanation: 'Оператор так и не ответил клиенту.', evidence: [], checked_range: null };
    const g = RE.greet.test(first.text), i = RE.intro.test(first.text);
    if (g && i) return { answer: 'yes', explanation: 'В первом ответе оператор поздоровался и назвал себя.', evidence: ev(first) };
    return {
      answer: 'no',
      explanation: !g && !i ? 'В первом ответе нет ни приветствия, ни имени оператора.' : !g ? 'Оператор назвал себя, но не поздоровался в первом ответе.' : 'Оператор поздоровался, но не представился в первом ответе.',
      evidence: ev(first), checked_range: { from: first.n, to: first.n },
    };
  },

  c_needs({ ops, clients }) {
    const lastOp = ops[ops.length - 1];
    // «Здравствуйте, чем могу помочь?» — приветствие, а не уточнение
    const greetingOnly = (t) => RE.greet.test(t.text) && /чем (я )?могу помочь|көмектесе аламын|how (can|may) i help/i.test(t.text) && t.text.length < 140;
    const asked = ops.find((t) => t.text.includes('?') && t !== lastOp && !greetingOnly(t));
    if (asked) return { answer: 'yes', explanation: 'Перед ответом оператор уточнил детали запроса.', evidence: ev(asked) };
    const firstClient = clients[0];
    if (firstClient && firstClient.text.length > 40) {
      return { answer: 'na', explanation: 'Клиент сразу подробно описал запрос — уточнять было нечего.', evidence: ev(firstClient), na_reason: 'Данных для ответа хватало с самого начала.' };
    }
    if (!ops.length) return { answer: 'na', explanation: 'Оператор не подключился.', evidence: [], na_reason: 'Данных для ответа хватало с самого начала.' };
    return { answer: 'no', explanation: 'Запрос был коротким, но оператор ответил, не уточнив детали.', evidence: [], checked_range: { from: ops[0].n, to: lastOp.n } };
  },

  c_identity({ ops, clients, events }) {
    const idEv = events.find((e) => e.ev && e.ev.type === 'identity');
    if (idEv) return { answer: 'yes', explanation: 'Система подтвердила личность клиента до работы с его данными.', evidence: ev(idEv.t) };
    const sens = clients.find((t) => RE.sensitive.test(t.text));
    if (sens && ops.length) {
      return { answer: 'no', explanation: 'Запрос касался счёта или личных данных, но подтверждения личности в переписке нет.', evidence: ev(sens), checked_range: { from: ops[0].n, to: ops[ops.length - 1].n } };
    }
    return { answer: 'na', explanation: 'Общий вопрос — проверка личности не требовалась.', evidence: clients[0] ? ev(clients[0]) : [], na_reason: 'Запрос не требовал идентификации.' };
  },

  c_consult({ ops, clients }) {
    if (!ops.length || !clients.length) {
      return { answer: 'na', explanation: 'Чат закончился до того, как клиент сформулировал запрос.', evidence: [], na_reason: 'Чат закончился до того, как клиент сформулировал запрос.' };
    }
    const chars = ops.reduce((a, t) => a + t.text.length, 0);
    const longest = ops.slice().sort((a, b) => b.text.length - a.text.length)[0];
    const step = chars >= 300 ? 20 : chars >= 150 ? 15 : chars >= 60 ? 10 : 5;
    const why = { 20: 'Оператор дал развёрнутый ответ по существу.', 15: 'Основной вопрос закрыт, но ответ короткий — возможно, пропущена деталь.', 10: 'Ответ частичный.', 5: 'Есть только общая подсказка.' }[step];
    return { answer: step, explanation: why, evidence: ev(longest) };
  },

  c_empathy({ ops }) {
    const p = ops.find((t) => RE.polite.test(t.text));
    if (p) return { answer: 'yes', explanation: 'Оператор вежлив с клиентом.', evidence: ev(p) };
    if (!ops.length) return { answer: 'no', explanation: 'Оператор не ответил.', evidence: [], checked_range: null };
    return { answer: 'no', explanation: 'Вежливых формулировок в ответах оператора не найдено.', evidence: [], checked_range: { from: ops[0].n, to: ops[ops.length - 1].n } };
  },

  c_manage({ ops }) {
    const w = ops.find((t) => RE.wait.test(t.text));
    if (w) return { answer: 10, explanation: 'Ответы последовательные; оператор предупредил об ожидании.', evidence: ev(w) };
    let longGap = null;
    for (let i = 1; i < ops.length; i++) {
      if (typeof ops[i].offset_sec === 'number' && typeof ops[i - 1].offset_sec === 'number' && ops[i].offset_sec - ops[i - 1].offset_sec > 90) { longGap = ops[i]; break; }
    }
    if (longGap) return { answer: 7, explanation: 'Была заметная пауза в ответах без предупреждения об ожидании.', evidence: ev(longGap) };
    return { answer: 10, explanation: 'Ответы ясные и идут по порядку.', evidence: ops[0] ? ev(ops[0]) : [] };
  },

  c_closing({ T, ops, events }) {
    const lastOp = ops[ops.length - 1];
    if (!lastOp) return { answer: 'na', explanation: 'Оператор не успел подключиться.', evidence: [], na_reason: 'Чат оборвался до возможности его завершить.' };
    const byeTurn = ops.slice().reverse().find((t) => RE.bye.test(t.text));
    if (byeTurn && byeTurn.n >= ops[Math.max(0, ops.length - 2)].n) {
      return { answer: 'yes', explanation: 'В конце оператор попрощался или предложил дальнейшую помощь.', evidence: ev(byeTurn) };
    }
    const cut = events.find((e) => e.ev && (e.ev.type === 'disconnect' || e.ev.type === 'client-left') && e.t.n <= lastOp.n + 1 && ops.length <= 1);
    if (cut) return { answer: 'na', explanation: 'Клиент ушёл раньше, чем оператор мог завершить разговор.', evidence: ev(cut.t), na_reason: 'Чат оборвался до возможности его завершить.' };
    return { answer: 'no', explanation: 'После ответа оператор не попрощался и не предложил дальнейшую помощь.', evidence: ev(lastOp), checked_range: { from: lastOp.n, to: T[T.length - 1].n } };
  },

  c_gross({ ops }) {
    const g = ops.find((t) => RE.gross.test(t.text));
    if (g) return { answer: 'yes', explanation: 'Найдена фраза, похожая на грубое нарушение — нужна проверка человеком.', evidence: ev(g) };
    return { answer: 'no', explanation: 'Оскорблений, предложений в обход компании и раскрытия чужих данных не найдено.', evidence: [] };
  },
};

/** Для критериев, у которых нет правила (например, после «Заменить критерий»). */
function generic(c, ctx) {
  const first = ctx.ops[0];
  const base = { explanation: 'Подставной ответ: для этого критерия нет правила — нужна оценка ИИ.', evidence: first ? ev(first) : [] };
  if (c.type === 'flag') return { ...base, answer: 'no', evidence: [] };
  if (c.type === 'scale') {
    const top = Math.max(...c.scale.map((s) => Number(s.points)));
    return { ...base, answer: top };
  }
  return { ...base, answer: 'yes' };
}

/**
 * @param record   диалог (с transcript)
 * @param checklist версия чек-листа { sections, criteria }
 * @returns {{ answers, summary }}
 */
function mockEvaluate(record, checklist) {
  const ctx = analyze(record);
  const answers = {};
  for (const c of checklist.criteria) {
    const rule = RULES[c.key] && (TYPE_OF[c.key] || 'yes_no') === c.type ? RULES[c.key] : null;
    let a = rule ? rule(ctx) : generic(c, ctx);
    // ответ должен быть допустимым для ЭТОЙ версии критерия (после правок чек-листа)
    if (a.answer === 'na' && !c.na_allowed) {
      // флаг «найдено нарушение» нельзя ставить «на всякий случай»
      const fallback = c.type === 'flag' ? 'no' : c.type === 'scale' ? Math.max(...c.scale.map((s) => Number(s.points))) : 'yes';
      a = { ...a, answer: fallback, na_reason: null, checked_range: null };
    }
    if (c.type === 'scale' && typeof a.answer === 'number') {
      const steps = c.scale.map((s) => Number(s.points)).sort((x, y) => x - y);
      if (!steps.includes(a.answer)) {
        // шкалу поменяли: переводим долю от вершины правила в новую шкалу, берём ближайшую ступень снизу
        const top = Math.max(...steps);
        const of = (rule && SCALE_OF[c.key]) || top;
        const scaled = (a.answer / of) * top + 1e-9;
        a = { ...a, answer: steps.filter((s) => s <= scaled).pop() ?? steps[0] };
      }
    }
    if (c.type !== 'scale' && typeof a.answer === 'number') a = { ...a, answer: 'yes' };
    answers[c.key] = {
      answer: a.answer,
      explanation: a.explanation,
      evidence: a.evidence || [],
      checked_range: a.answer === 'no' ? (a.checked_range || null) : null,
      na_reason: a.answer === 'na' ? (a.na_reason || null) : null,
      confidence: rule ? 'medium' : 'low',
    };
  }
  return { answers, summary: 'Подставная оценка по ключевым словам (не ИИ).' };
}

module.exports = { mockEvaluate };
