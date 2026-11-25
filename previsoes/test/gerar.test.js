'use strict';
// Testes da lógica de congelar previsões (sem rede). Correr: node test/gerar.test.js
const assert = require('assert');
const { merge } = require('../scripts/gerar');
const E = require('../lib/engine');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const form = [3, 2, 4, 2, 3, 1].map((g, i) => ({ ts: i, gf: g, ga: 0 }));
const weak = [0, 1, 0, 0, 1, 0].map((g, i) => ({ ts: i, gf: g, ga: 2 }));
const probs = (p) => p.groups.flatMap((g) => g.options.map((o) => o.prob));

const mkMatch = (id, startingAt, score, pred) => ({
  id, league: 'L', startingAt, state: score ? 'FT' : 'NS', finished: !!score, score, ht: score ? { home: 1, away: 0 } : null,
  home: { name: 'A', logo: '', form: ['V', 'V'] }, away: { name: 'B', logo: '', form: ['D', 'D'] }, prediction: pred,
});

test('merge: previsão v2 já registada fica congelada, mesmo que a API devolva outra', () => {
  const kick = '2026-11-25T20:00:00.000Z';
  const frozen = E.buildPrediction(form, weak, null);
  const old = { generatedAt: '2026-11-25T10:00:00.000Z', matches: [{ ...mkMatch(1, kick, null, frozen), preGame: true }] };
  const different = E.buildPrediction(weak, form, E.toResult({ home: 0, away: 2 }, { home: 0, away: 1 }));
  const fresh = { generatedAt: '2026-11-25T23:00:00.000Z', matches: [mkMatch(1, kick, { home: 0, away: 2 }, different)] };
  const out = merge(fresh, old)[0];
  assert.deepStrictEqual(probs(out.prediction), probs(frozen));
  assert.strictEqual(out.preGame, true);
  assert.deepStrictEqual(out.score, { home: 0, away: 2 });
  assert.strictEqual(typeof out.prediction.best.hit, 'boolean'); // acertos atualizados com o resultado
});

test('merge: previsão em formato antigo (sem v) é recalculada', () => {
  const kick = '2026-11-25T20:00:00.000Z';
  const oldPred = { xg: [1, 1], markets: [], best: { label: 'x' } }; // formato v1
  const old = { generatedAt: '2026-11-25T08:00:00.000Z', matches: [{ ...mkMatch(5, kick, null, oldPred), preGame: true }] };
  const pred = E.buildPrediction(form, weak, null);
  const fresh = { generatedAt: '2026-11-25T10:00:00.000Z', matches: [mkMatch(5, kick, null, pred)] };
  const out = merge(fresh, old)[0];
  assert.strictEqual(out.prediction.v, 2);
  assert.strictEqual(out.preGame, true); // ainda não começou: conta como registada antes
});

test('merge: jogo visto pela primeira vez antes do apito conta como registado antes', () => {
  const pred = E.buildPrediction(form, weak, null);
  const fresh = { generatedAt: '2026-11-25T10:00:00.000Z', matches: [mkMatch(2, '2026-11-25T20:00:00.000Z', null, pred)] };
  assert.strictEqual(merge(fresh, null)[0].preGame, true);
});

test('merge: jogo visto pela primeira vez depois de começar NÃO conta como registado antes', () => {
  const pred = E.buildPrediction(form, weak, E.toResult({ home: 1, away: 0 }, { home: 0, away: 0 }));
  const fresh = { generatedAt: '2026-11-25T23:00:00.000Z', matches: [mkMatch(3, '2026-11-25T20:00:00.000Z', { home: 1, away: 0 }, pred)] };
  assert.strictEqual(merge(fresh, null)[0].preGame, false);
});

test('merge: jogo sem previsão (poucos dados) nunca conta como registado antes', () => {
  const fresh = { generatedAt: '2026-11-25T10:00:00.000Z', matches: [mkMatch(4, '2026-11-25T20:00:00.000Z', null, null)] };
  assert.strictEqual(merge(fresh, null)[0].preGame, false);
});

console.log('\n' + n + ' testes passaram');
