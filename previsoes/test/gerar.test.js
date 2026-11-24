'use strict';
// Testes da lógica de congelar previsões (sem rede). Correr: node test/gerar.test.js
const assert = require('assert');
const { merge, rescore } = require('../scripts/gerar');
const E = require('../lib/engine');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const form = [3, 2, 4, 2, 3, 1].map((g, i) => ({ ts: i, gf: g, ga: 0 }));
const weak = [0, 1, 0, 0, 1, 0].map((g, i) => ({ ts: i, gf: g, ga: 2 }));

const mkMatch = (id, startingAt, score, pred) => ({
  id, league: 'L', startingAt, state: score ? 'FT' : 'NS', finished: !!score, score,
  home: { name: 'A', logo: '', form: ['V', 'V'] }, away: { name: 'B', logo: '', form: ['D', 'D'] }, prediction: pred,
});

test('rescore atualiza os acertos sem mudar as probabilidades', () => {
  const pred = E.buildPrediction(form, weak, null);
  const after = rescore(pred, { home: 3, away: 0 });
  assert.deepStrictEqual(after.markets.map((m) => m.prob), pred.markets.map((m) => m.prob));
  assert.ok(after.markets.every((m) => typeof m.hit === 'boolean'));
  assert.strictEqual(after.best.hit, after.markets.find((m) => m.key === after.best.key).hit);
  assert.strictEqual(rescore(pred, null).best.hit, null);
});

test('merge: previsão já registada fica congelada, mesmo que a API devolva outra', () => {
  const kick = '2026-11-25T20:00:00.000Z';
  const frozen = E.buildPrediction(form, weak, null);
  const old = { generatedAt: '2026-11-25T10:00:00.000Z', matches: [{ ...mkMatch(1, kick, null, frozen), preGame: true }] };
  const different = E.buildPrediction(weak, form, { home: 0, away: 2 }); // previsão "nova" diferente
  const fresh = { generatedAt: '2026-11-25T23:00:00.000Z', matches: [mkMatch(1, kick, { home: 0, away: 2 }, different)] };
  const out = merge(fresh, old)[0];
  assert.deepStrictEqual(out.prediction.markets.map((m) => m.prob), frozen.markets.map((m) => m.prob));
  assert.strictEqual(out.preGame, true);
  assert.deepStrictEqual(out.score, { home: 0, away: 2 }); // o resultado atualiza
  assert.strictEqual(typeof out.prediction.best.hit, 'boolean');
});

test('merge: jogo visto pela primeira vez antes do apito conta como registado antes', () => {
  const pred = E.buildPrediction(form, weak, null);
  const fresh = { generatedAt: '2026-11-25T10:00:00.000Z', matches: [mkMatch(2, '2026-11-25T20:00:00.000Z', null, pred)] };
  assert.strictEqual(merge(fresh, null)[0].preGame, true);
});

test('merge: jogo visto pela primeira vez depois de começar NÃO conta como registado antes', () => {
  const pred = E.buildPrediction(form, weak, { home: 1, away: 0 });
  const fresh = { generatedAt: '2026-11-25T23:00:00.000Z', matches: [mkMatch(3, '2026-11-25T20:00:00.000Z', { home: 1, away: 0 }, pred)] };
  assert.strictEqual(merge(fresh, null)[0].preGame, false);
});

test('merge: jogo sem previsão (poucos dados) nunca conta como registado antes', () => {
  const fresh = { generatedAt: '2026-11-25T10:00:00.000Z', matches: [mkMatch(4, '2026-11-25T20:00:00.000Z', null, null)] };
  assert.strictEqual(merge(fresh, null)[0].preGame, false);
});

console.log('\n' + n + ' testes passaram');
