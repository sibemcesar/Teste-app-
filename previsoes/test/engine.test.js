'use strict';
// Testes do motor com dados sintéticos (sem rede). Correr: node test/engine.test.js
const assert = require('assert');
const E = require('../lib/engine');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

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
    { description: '1ST_HALF', score: { goals: 0, participant: 'home' } },
  ],
});

const D = 86400000, t0 = Date.parse('2026-10-01T15:00:00Z');

test('goalsFrom lê o resultado final e ignora a parte', () => {
  assert.deepStrictEqual(E.goalsFrom(mkFix(1, t0, 1, 2, 3, 1)), { home: 3, away: 1 });
});

test('formOf: ordena do mais recente, lê golos do ponto de vista da equipa, ignora jogos por jogar', () => {
  const fx = [
    mkFix(1, t0, 1, 9, 2, 0),            // casa, venceu 2-0
    mkFix(2, t0 + 7 * D, 8, 1, 1, 1),    // fora, 1-1
    mkFix(3, t0 + 14 * D, 1, 7, 0, 3),   // casa, perdeu 0-3
    mkFix(4, t0 + 21 * D, 1, 6, 0, 0, 'NS'), // por jogar
  ];
  const f = E.formOf(1, fx);
  assert.strictEqual(f.length, 3);
  assert.deepStrictEqual([f[0].gf, f[0].ga], [0, 3]);
  assert.deepStrictEqual([f[2].gf, f[2].ga], [2, 0]);
});

const strong = [3, 2, 4, 2, 3, 1].map((g, i) => ({ ts: i, gf: g, ga: 0 }));
const weak = [0, 1, 0, 0, 1, 0].map((g, i) => ({ ts: i, gf: g, ga: 2 }));

test('predict: probabilidades 1X2 somam 1 e o favorito é a equipa forte', () => {
  const p = E.predict(strong, weak).p;
  assert.ok(Math.abs(p.h + p.d + p.a - 1) < 1e-9);
  assert.ok(p.h > p.a && p.h > 0.5);
});

test('predict: sem dados suficientes devolve null', () => {
  assert.strictEqual(E.predict(strong.slice(0, 2), weak), null);
});

test('predict: encolhe para a média (sem probabilidades extremas)', () => {
  const p = E.predict(strong, weak).p;
  assert.ok(p.h < 0.95 && p.a > 0.01);
});

test('mercados: over/under e btts são complementares', () => {
  const p = E.predict(strong, weak).p;
  assert.ok(Math.abs(p.over25 + p.under25 - 1) < 1e-9);
  assert.ok(Math.abs(p.bttsY + p.bttsN - 1) < 1e-9);
});

test('evaluate: resultados de cada mercado', () => {
  const m = (key, pick) => ({ key, pick });
  assert.strictEqual(E.evaluate(m('1x2', '1'), { home: 2, away: 1 }), true);
  assert.strictEqual(E.evaluate(m('1x2', 'X'), { home: 2, away: 1 }), false);
  assert.strictEqual(E.evaluate(m('goals', 'O25'), { home: 2, away: 1 }), true);
  assert.strictEqual(E.evaluate(m('goals', 'U25'), { home: 1, away: 1 }), true);
  assert.strictEqual(E.evaluate(m('btts', 'Y'), { home: 2, away: 0 }), false);
  assert.strictEqual(E.evaluate(m('btts', 'N'), { home: 2, away: 0 }), true);
  assert.strictEqual(E.evaluate(m('dc', 'X2'), { home: 0, away: 0 }), true);
  assert.strictEqual(E.evaluate(m('dc', '12'), { home: 1, away: 1 }), false);
  assert.strictEqual(E.evaluate(m('1x2', '1'), null), null);
});

test('buildPrediction: estrutura completa, odd justa = 1/prob, hit preenchido com o resultado', () => {
  const r = E.buildPrediction(strong, weak, { home: 3, away: 0 });
  assert.strictEqual(r.markets.length, 4);
  assert.ok(r.markets.every((m) => typeof m.hit === 'boolean'));
  assert.ok(Math.abs(r.best.fairOdd - 1 / r.best.prob) < 0.02);
  assert.ok(['alta', 'média', 'baixa'].includes(r.best.confidence));
  assert.strictEqual(E.buildPrediction(strong, weak, null).best.hit, null);
});

console.log('\n' + n + ' testes passaram');
