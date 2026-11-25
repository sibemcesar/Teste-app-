'use strict';
const assert = require('assert');
const { compute } = require('../lib/stats');
const opt = (id, prob, hit) => ({ id, label: id, prob, hit });
const m = (pre, bestHit, lg) => ({ finished: true, score: { home: 1, away: 0 }, preGame: pre, league: lg,
  prediction: { v: 2, best: { prob: 0.6, hit: bestHit }, groups: [{ key: 'btts', label: 'Ambas marcam', options: [opt('y', 0.65, true), opt('n', 0.35, false), opt('v', 0.5, 'void'), opt('z', 0.5, null)] }] } });
const days = [{ date: 'd', matches: [m(true, true, 'A'), m(true, false, 'A'), m(false, true, 'B'), { finished: false, preGame: true, prediction: { v: 2 } }, { finished: true, score: { home: 0, away: 0 }, prediction: { markets: [] } }] }];
const s = compute(days);
assert.strictEqual(s.all.games, 3); assert.strictEqual(s.pre.games, 2);
assert.deepStrictEqual([s.pre.best.n, s.pre.best.hits], [2, 1]);
assert.strictEqual(s.pre.leagues[0].league, 'A');
assert.strictEqual(s.pre.groups[0].n, 4, "'void' e null não contam"); // 2 opções válidas × 2 jogos
const b65 = s.pre.bins.find((x) => x.from === 0.6); assert.strictEqual(b65.n, 2); assert.strictEqual(b65.hits, 2);
console.log('ok - desempenho: contagens, só v2 terminados, void/null fora, pré vs todos');
