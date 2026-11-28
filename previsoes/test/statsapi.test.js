'use strict';
// Testes do adaptador TheStatsAPI com respostas simuladas (sem rede). Correr: node test/statsapi.test.js
const assert = require('assert');
process.env.STATSAPI_KEY = 'k';
const calls = [];
const mk = (id, h, a, status, date, sc) => ({ id, season_id: 'sn_1', competition_id: 'comp_1', status, utc_date: date,
  home_team: { id: h, name: 'T' + h }, away_team: { id: a, name: 'T' + a }, score: sc || { home: null, away: null, regulation: null } });
global.fetch = async (url, opt) => {
  calls.push(url);
  assert.strictEqual(opt.headers.Authorization, 'Bearer k');
  const u = new URL(url); const q = u.searchParams; let body;
  if (u.pathname.endsWith('/competitions')) body = { data: [{ id: 'comp_1', name: 'Premier League', country_code: 'GB', subdivision_code: 'GB-ENG' }, { id: 'comp_2', name: 'Liga Obscura' }], meta: { total_pages: 1 } };
  else if (/\/teams\/[^/]+\/stats$/.test(u.pathname)) body = { data: { team_id: 'x', season_id: q.get('season_id'), xg_matches: 10, expected_goals_for: 20, expected_goals_against: 12 } };
  else if (/\/matches\/mt_f1$/.test(u.pathname)) body = { data: { id: 'mt_f1', score: { half_time_home: 1, half_time_away: 0 } } };
  else if (q.get('team_id')) body = { data: [1, 2, 3, 4, 5, 6].map((i) => mk('mt_h' + q.get('team_id') + i, q.get('team_id'), 'tm_x', 'finished', '2026-11-0' + i + 'T15:00:00.000Z', { home: 2, away: 0, regulation: { home: 2, away: 0 } })) };
  else body = { data: [
    mk('mt_f1', 'tm_1', 'tm_2', 'finished', '2026-11-25T12:00:00.000Z', { home: 2, away: 1, regulation: { home: 2, away: 1 } }),
    mk('mt_n1', 'tm_3', 'tm_4', 'scheduled', '2026-11-25T19:00:00.000Z'),
    { ...mk('mt_o', 'tm_5', 'tm_6', 'scheduled', '2026-11-25T19:00:00.000Z'), competition_id: 'comp_2' },
  ], meta: { total_pages: 1 } };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' };
};
(async () => {
  const E = require('../lib/engine');
  const { buildDay } = require('../lib/day');
  const day = await buildDay('2026-11-25');
  assert.strictEqual(day.matches.length, 2, 'filtra ligas fora da lista');
  const [fin, nxt] = day.matches;
  assert.strictEqual(fin.league, 'Premier League'); assert.strictEqual(fin.leagueCc, 'GB-ENG');
  assert.deepStrictEqual(fin.score, { home: 2, away: 1 });
  assert.deepStrictEqual(fin.ht, { home: 1, away: 0 });
  assert.strictEqual(nxt.finished, false); assert.strictEqual(nxt.score, null);
  assert.ok(nxt.prediction && nxt.prediction.v === 2 && nxt.home.form.length === 5);
  assert.ok(nxt.prediction.st && nxt.prediction.st.h[0] === 2 && nxt.prediction.st.h[1] === 1.2, 'usa o xG da época: ' + JSON.stringify(nxt.prediction.st));
  assert.strictEqual(fin.prediction.st, undefined, 'jogos terminados não usam xG da época');
  console.log('ok - dia completo: liga, resultado, intervalo, previsão com xG');

  // 2.ª execução com o dia já guardado: sem detalhe nem histórico
  calls.length = 0;
  const day2 = await buildDay('2026-11-25', JSON.parse(JSON.stringify(day)));
  assert.ok(!calls.some((c) => /mt_f1$/.test(c)), 'não repete o detalhe do jogo terminado');
  assert.ok(!calls.some((c) => /team_id/.test(c)), 'não repete o histórico de jogos congelados');
  assert.ok(!calls.some((c) => /\/stats/.test(c)), 'nem o xG');
  assert.deepStrictEqual(day2.matches[0].ht, { home: 1, away: 0 });
  console.log('ok - segunda execução poupa pedidos');
  console.log('2 testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
