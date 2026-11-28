'use strict';
const assert = require('assert');
process.env.LEARN_MIN_GAMES = '150';
const E = require('../lib/engine');
const { learn, rowsFrom } = require('../lib/learn');

// gerador simples de jogos: golos reais ~ Poisson com a "verdade" = média da liga 1.8 e casa 1.25
let seed = 57; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pois = (l) => { let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
const mk = (i, trueHome, trueAway, exact) => {
  const bh = 1 + rnd(), ba = 1 + rnd();
  const lh = 0.75 * bh * 1.08 + 0.25 * 1.35, la = 0.75 * ba * 0.93 + 0.25 * 1.35;
  const gh = exact ? pois(lh) : pois(trueHome * bh), ga = exact ? pois(la) : pois(trueAway * ba);
  return { finished: true, startingAt: new Date(2026, 0, 1 + (i % 28), 12, i % 60).toISOString(), league: 'L', score: { home: gh, away: ga }, ht: { home: 0, away: 0 },
    prediction: { v: 2, xg: [lh, la], base: [bh, ba], groups: [], best: {} } };
};

// poucos jogos: não aprende
let r = learn([{ matches: Array.from({ length: 40 }, (_, i) => mk(i, 1.3, 1.0)) }], null);
assert.strictEqual(r.status, 'a-aprender'); assert.strictEqual(r.params, null);
console.log('ok - poucos jogos: não aprende');

// muitos jogos com uma "verdade" diferente dos valores por defeito: aprende e valida
E.setParams(null);
r = learn([{ matches: Array.from({ length: 1200 }, (_, i) => mk(i, 1.6, 1.1)) }], null);
assert.strictEqual(r.status, 'ativo', r.reason);
assert.ok(r.params.homeFactor > 1.08, 'vantagem de casa sobe: ' + r.params.homeFactor);
assert.ok(r.report.gainPerGame > 0.002);
assert.ok(r.params.homeFactor <= 1.3 && r.params.awayFactor >= 0.75);
console.log('ok - muitos jogos: aprende, valida em jogos não vistos e respeita os limites', JSON.stringify(r.params));

// se a realidade for exatamente o modelo atual, não adota nada
E.setParams(null); seed = 11;
r = learn([{ matches: Array.from({ length: 600 }, (_, i) => mk(i, 0, 0, true)) }], null);
assert.notStrictEqual(r.status, 'ativo', 'sem ganho real não deve adotar: ' + JSON.stringify(r.report));
console.log('ok - sem ganho real: mantém os valores atuais');

// previsões antigas (sem base) recuperam a base a partir do xG
const old = { finished: true, startingAt: new Date().toISOString(), league: 'L', score: { home: 1, away: 0 }, prediction: { v: 2, xg: [1.7, 1.2], groups: [], best: {} } };
const rows = rowsFrom([{ matches: [old] }]); assert.strictEqual(rows.length, 1); assert.ok(Math.abs(rows[0].bh - (1.7 - 0.3375) / 0.75 / 1.08) < 1e-9);
console.log('ok - previsões antigas entram na aprendizagem');

// setParams altera as previsões e as previsões registam a versão
E.setParams({ version: 3, homeFactor: 1.2 });
const f = Array.from({ length: 6 }, () => ({ gf: 2, ga: 1, ts: 1 }));
assert.strictEqual(E.buildPrediction(f, f, null, 'L').pv, 3);
E.setParams(null);
console.log('ok - parâmetros novos entram no modelo');

// ---------- correção de "ambas marcam" ----------
{
  const { fitBtts, bttsRows } = require('../lib/learn');
  let sd = 5; const rd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const mkB = (pY, yes, bs) => ({ finished: true, score: yes ? { home: 1, away: 1 } : { home: 0, away: 1 },
    prediction: { v: 2, bs: bs || 0, groups: [{ key: 'btts', options: [{ id: 'btts:Y', prob: pY }, { id: 'btts:N', prob: 1 - pY }] }] } });
  // o modelo diz 60% mas só acontece 45%: deve baixar
  const over = Array.from({ length: 300 }, () => mkB(0.6, rd() < 0.45));
  let f = fitBtts(bttsRows([{ matches: over }]));
  assert.ok(f.used && f.shift < -0.1 && f.shift >= -0.8, 'corrige o otimismo: ' + JSON.stringify(f));
  // modelo calibrado: não mexe
  const ok = Array.from({ length: 300 }, () => mkB(0.55, rd() < 0.55));
  f = fitBtts(bttsRows([{ matches: ok }])); assert.ok(!f.used || Math.abs(f.shift) < 0.15, 'calibrado: ' + JSON.stringify(f));
  // poucos jogos: não aprende
  assert.strictEqual(fitBtts(bttsRows([{ matches: over.slice(0, 50) }])), null);
  // se a previsão já levava correção (bs), a análise retira-a antes de reestimar
  const l0 = Math.log(0.6 / 0.4), tilted = 1 / (1 + Math.exp(-(l0 - 0.3)));
  assert.ok(Math.abs(bttsRows([{ matches: [mkB(tilted, true, -0.3)] }])[0].l - l0) < 1e-9);
  const r2 = learn([{ matches: over }], null);
  assert.strictEqual(r2.status, 'ativo'); assert.ok(r2.params.bttsShift < 0);
  console.log('ok - correção de ambas marcam: aprende o desvio, ignora o calibrado e poucos jogos');
}
