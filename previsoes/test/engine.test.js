'use strict';
// Testes do motor com dados sintéticos (sem rede). Correr: node test/engine.test.js
const assert = require('assert');
const E = require('../lib/engine');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const near = (a, b, eps = 0.002) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const mkFix = (id, ts, homeId, awayId, gh, ga, state = 'FT') => ({
  id,
  starting_at: new Date(ts).toISOString().slice(0, 19).replace('T', ' '),
  state: { short_name: state },
  participants: [
    { id: homeId, name: 'H' + homeId, meta: { location: 'home' } },
    { id: awayId, name: 'A' + awayId, meta: { location: 'away' } },
  ],
  scores: [
    { description: 'CURRENT', score: { goals: gh, participant: 'home' } },
    { description: 'CURRENT', score: { goals: ga, participant: 'away' } },
    { description: '1ST_HALF', score: { goals: 1, participant: 'home' } },
    { description: '1ST_HALF', score: { goals: 0, participant: 'away' } },
  ],
});

const D = 86400000, t0 = Date.parse('2026-10-01T15:00:00Z');
const strong = [3, 2, 4, 2, 3, 1].map((g, i) => ({ ts: i, gf: g, ga: 0 }));
const weak = [0, 1, 0, 0, 1, 0].map((g, i) => ({ ts: i, gf: g, ga: 2 }));
const grp = (p, key) => p.groups.find((g) => g.key === key);
const prob = (p, id) => { for (const g of p.groups) for (const o of g.options) if (o.id === id) return o.prob; throw new Error('sem ' + id); };

test('goalsFrom lê o resultado final e o do intervalo', () => {
  const f = mkFix(1, t0, 1, 2, 3, 1);
  assert.deepStrictEqual(E.goalsFrom(f), { home: 3, away: 1 });
  assert.deepStrictEqual(E.goalsFrom(f, '1ST_HALF'), { home: 1, away: 0 });
});

test('formOf: ordena do mais recente, vê golos do ponto de vista da equipa, ignora jogos por jogar', () => {
  const fx = [
    mkFix(1, t0, 1, 9, 2, 0),
    mkFix(2, t0 + 7 * D, 8, 1, 1, 1),
    mkFix(3, t0 + 14 * D, 1, 7, 0, 3),
    mkFix(4, t0 + 21 * D, 1, 6, 0, 0, 'NS'),
  ];
  const f = E.formOf(1, fx);
  assert.strictEqual(f.length, 3);
  assert.deepStrictEqual([f[0].gf, f[0].ga], [0, 3]);
  assert.deepStrictEqual([f[2].gf, f[2].ga], [2, 0]);
});

test('expectedGoals: sem dados suficientes devolve null; favorito marca mais', () => {
  assert.strictEqual(E.expectedGoals(strong.slice(0, 2), weak), null);
  const x = E.expectedGoals(strong, weak);
  assert.ok(x.lh > x.la);
  assert.ok(x.lh < 3.5 && x.la > 0.3); // encolhido para a média
});

test('joint: probabilidades somam 1', () => {
  const x = E.expectedGoals(strong, weak);
  const J = E.joint(x.lh, x.la);
  near(J.reduce((s, r) => s + r.p, 0), 1, 1e-9);
});

const p = E.buildPrediction(strong, weak, null);

test('buildPrediction: v2, mercados em falta não existem, tudo entre 0 e 1', () => {
  assert.strictEqual(p.v, 2);
  assert.ok(p.groups.length >= 14);
  for (const g of p.groups) for (const o of g.options) assert.ok(o.prob >= 0 && o.prob <= 1, o.id);
  assert.strictEqual(E.buildPrediction(strong.slice(0, 2), weak, null), null);
});

test('coerência: 1X2, over/under, btts, HT/FT, intervalo e golos exatos somam 1', () => {
  const sum = (key) => grp(p, key).options.reduce((s, o) => s + o.prob, 0);
  near(sum('1x2'), 1); near(sum('btts'), 1); near(sum('par'), 1);
  near(sum('htft'), 1); near(sum('h1x2'), 1); near(sum('half'), 1); near(sum('tg'), 1);
  near(prob(p, 'ou:o2.5') + prob(p, 'ou:u2.5'), 1);
  near(prob(p, 'th:o1.5') + prob(p, 'th:u1.5'), 1);
  near(prob(p, 'dc:1X'), prob(p, '1x2:1') + prob(p, '1x2:X'));
  near(prob(p, 'dc:12'), prob(p, '1x2:1') + prob(p, '1x2:2'));
});

test('coerência: linhas de golos são monótonas e o HT/FT soma o resultado final', () => {
  assert.ok(prob(p, 'ou:o0.5') >= prob(p, 'ou:o1.5') && prob(p, 'ou:o1.5') >= prob(p, 'ou:o2.5'));
  assert.ok(prob(p, 'ou:o2.5') >= prob(p, 'ou:o3.5') && prob(p, 'ou:o3.5') >= prob(p, 'ou:o4.5'));
  near(prob(p, 'htft:1/1') + prob(p, 'htft:X/1') + prob(p, 'htft:2/1'), prob(p, '1x2:1'));
  near(prob(p, 'htft:1/1') + prob(p, 'htft:1/X') + prob(p, 'htft:1/2'), prob(p, 'h1:1'));
});

test('favorito: casa forte tem mais probabilidade de ganhar, empate anula aposta (DNB) é condicional', () => {
  assert.ok(prob(p, '1x2:1') > 0.5 && prob(p, '1x2:1') > prob(p, '1x2:2'));
  near(prob(p, 'dnb:1'), prob(p, '1x2:1') / (prob(p, '1x2:1') + prob(p, '1x2:2')), 0.003);
  near(prob(p, 'dnb:1') + prob(p, 'dnb:2'), 1);
});

test('resultados exatos: 6, ordenados do mais para o menos provável', () => {
  const cs = grp(p, 'cs').options;
  assert.strictEqual(cs.length, 6);
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i - 1].prob >= cs[i].prob);
});

test('dica principal vem dos mercados principais e tem confiança', () => {
  assert.ok(['1x2:1', '1x2:X', '1x2:2', 'ou:o2.5', 'ou:u2.5', 'btts:Y', 'btts:N'].includes(p.best.id));
  assert.ok(['alta', 'média', 'baixa'].includes(p.best.confidence));
});

test('evaluate: resultado 3-1 (intervalo 1-0)', () => {
  const r = { h: 3, a: 1, h1: 1, a1: 0 };
  const t = (id) => E.evaluate(id, r);
  assert.strictEqual(t('1x2:1'), true); assert.strictEqual(t('1x2:X'), false);
  assert.strictEqual(t('ou:o3.5'), true); assert.strictEqual(t('ou:u3.5'), false);
  assert.strictEqual(t('btts:Y'), true);
  assert.strictEqual(t('th:o2.5'), true); assert.strictEqual(t('ta:o1.5'), false);
  assert.strictEqual(t('wtn:1'), false); assert.strictEqual(t('cs0:1'), false);
  assert.strictEqual(t('mg:1++'), true); assert.strictEqual(t('mg:1+'), false);
  assert.strictEqual(t('tg:4'), true); assert.strictEqual(t('par:P'), true);
  assert.strictEqual(t('h1:1'), true); assert.strictEqual(t('hou:o0.5'), true); assert.strictEqual(t('hou:o1.5'), false);
  assert.strictEqual(t('htft:1/1'), true); assert.strictEqual(t('htft:X/1'), false);
  assert.strictEqual(t('half:2'), true); // 1 golo na 1.ª, 3 na 2.ª
  assert.strictEqual(t('cs:3-1'), true); assert.strictEqual(t('cs:2-1'), false);
  assert.strictEqual(t('dnb:1'), true);
});

test('evaluate: empate anula (void), sem intervalo dá null, sem resultado dá null', () => {
  assert.strictEqual(E.evaluate('dnb:1', { h: 1, a: 1, h1: 0, a1: 0 }), 'void');
  assert.strictEqual(E.evaluate('htft:1/1', { h: 2, a: 0, h1: null, a1: null }), null);
  assert.strictEqual(E.evaluate('1x2:1', { h: 2, a: 0, h1: null, a1: null }), true); // não precisa do intervalo
  assert.strictEqual(E.evaluate('1x2:1', null), null);
  assert.strictEqual(E.evaluate('nao-existe', { h: 1, a: 0, h1: 0, a1: 0 }), null);
});

test('toResult e rescore: mantêm as probabilidades e preenchem os acertos', () => {
  const r = E.toResult({ home: 3, away: 0 }, { home: 2, away: 0 });
  assert.deepStrictEqual(r, { h: 3, a: 0, h1: 2, a1: 0 });
  const after = E.rescore(p, r);
  assert.strictEqual(prob(after, 'ou:o2.5'), prob(p, 'ou:o2.5'));
  assert.strictEqual(grp(after, '1x2').options[0].hit, true);
  assert.strictEqual(after.best.hit, E.evaluate(p.best.id, r));
  assert.strictEqual(E.rescore(p, null).best.hit, null);
});

console.log('\n' + n + ' testes passaram');

// ---------- construtor de aposta ----------
{
  const x = E.expectedGoals(strong, weak);
  const J = E.joint(x.lh, x.la);
  const near = (a, b, t = 1e-9) => Math.abs(a - b) < t;
  const single = (id) => E.comboProb(J, [id]);
  assert.ok(near(single('1x2:1') + single('1x2:X') + single('1x2:2'), 1), 'o 1X2 soma 1');
  assert.ok(near(E.comboProb(J, ['1x2:1', '1x2:2']), 0), 'seleções incompatíveis = 0');
  assert.ok(near(E.comboProb(J, ['1x2:1', 'dc:1X']), single('1x2:1')), 'vitória implica casa ou empate');
  const both = E.comboProb(J, ['ou:o2.5', 'btts:Y']);
  assert.ok(both > single('ou:o2.5') * single('btts:Y'), 'mais de 2,5 e ambas marcam andam juntos (correlação)');
  assert.ok(both <= Math.min(single('ou:o2.5'), single('btts:Y')) + 1e-12);
  assert.strictEqual(E.comboProb(J, ['nao:existe']), null);
  const sug = E.comboSuggest(J, 2, 3);
  assert.ok(sug.length > 0 && sug.every((s) => s.ids.length === 2 && s.prob <= 0.9));
  assert.ok(sug.every((s, i) => i === 0 || sug[i - 1].prob >= s.prob), 'ordenadas por probabilidade');
  assert.ok(sug.every((s) => new Set(s.ids.map((i) => i.split(':')[0])).size === 2), 'no máximo uma seleção por mercado');
  assert.ok(near(sug[0].prob, E.comboProb(J, sug[0].ids)), 'sugestão consistente com o cálculo direto');
  const sug3 = E.comboSuggest(J, 3, 20);
  assert.ok(sug3.every((s) => !(s.ids.some((i) => i.startsWith('1x2')) && s.ids.some((i) => i.startsWith('dc')))), 'só uma seleção de resultado por combinação');
  assert.ok(sug3.every((s) => !(s.ids.includes('ou:o1.5') && s.ids.includes('ou:o2.5'))), 'sem redundâncias');
  const pr = E.buildPrediction(strong, weak, null, 'L');
  assert.ok(typeof pr.sh === 'number' && pr.sh > 0, 'a previsão guarda a divisão por partes');
  console.log('ok - construtor de aposta: correlação, incompatíveis, implicações, sugestões');
}
