'use strict';
// Testes do adaptador da football-data.org (sem rede). Correr: node test/footballdata.test.js
const assert = require('assert');
const { toFixture } = require('../lib/providers/footballdata');
const E = require('../lib/engine');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const base = (over) => ({
  id: 10, utcDate: '2026-11-21T15:00:00Z', status: 'FINISHED',
  homeTeam: { id: 1, name: 'Arsenal FC', shortName: 'Arsenal', crest: 'https://x/a.png' },
  awayTeam: { id: 2, name: 'Chelsea FC', shortName: null, crest: null },
  competition: { name: 'Premier League' },
  score: { winner: 'HOME_TEAM', duration: 'REGULAR', fullTime: { home: 2, away: 1 }, halfTime: { home: 1, away: 0 } },
  ...over,
});

test('jogo terminado: resultado, intervalo, equipas, liga e hora', () => {
  const f = toFixture(base());
  assert.deepStrictEqual(E.goalsFrom(f), { home: 2, away: 1 });
  assert.deepStrictEqual(E.goalsFrom(f, '1ST_HALF'), { home: 1, away: 0 });
  assert.strictEqual(E.isFinished(f), true);
  const s = E.sides(f);
  assert.strictEqual(s.home.name, 'Arsenal'); assert.strictEqual(s.away.name, 'Chelsea FC');
  assert.strictEqual(s.home.image_path, 'https://x/a.png');
  assert.strictEqual(f.league.name, 'Premier League');
  assert.strictEqual(new Date(E.kickoffTs(f)).toISOString(), '2026-11-21T15:00:00.000Z');
});

test('jogo por acontecer: sem resultado e não terminado', () => {
  const f = toFixture(base({ status: 'TIMED', score: { duration: 'REGULAR', fullTime: { home: null, away: null }, halfTime: { home: null, away: null } } }));
  assert.strictEqual(E.isFinished(f), false);
  assert.strictEqual(E.goalsFrom(f), null);
  assert.strictEqual(f.state.short_name, 'TIMED');
});

test('prolongamento: usa o resultado dos 90 minutos (regularTime)', () => {
  const f = toFixture(base({ score: { duration: 'EXTRA_TIME', fullTime: { home: 3, away: 2 }, regularTime: { home: 2, away: 2 }, halfTime: { home: 1, away: 1 } } }));
  assert.deepStrictEqual(E.goalsFrom(f), { home: 2, away: 2 });
});

test('penáltis sem regularTime: sem resultado (não arrisca um valor errado)', () => {
  const f = toFixture(base({ score: { duration: 'PENALTY_SHOOTOUT', fullTime: { home: 5, away: 4 }, halfTime: { home: 0, away: 0 } } }));
  assert.strictEqual(E.isFinished(f), true);
  assert.strictEqual(E.goalsFrom(f), null);
});

test('sem halfTime: resultado final existe, intervalo não', () => {
  const f = toFixture(base({ score: { duration: 'REGULAR', fullTime: { home: 0, away: 0 } } }));
  assert.deepStrictEqual(E.goalsFrom(f), { home: 0, away: 0 });
  assert.strictEqual(E.goalsFrom(f, '1ST_HALF'), null);
});

console.log('\n' + n + ' testes passaram');
