'use strict';
// Constrói as previsões de um dia. Usado pelo gerador (GitHub Actions) e, opcionalmente, pela função da Vercel.
// A fonte de dados escolhe-se pelas variáveis de ambiente: FOOTBALLDATA_TOKEN (football-data.org) tem prioridade;
// se não existir, usa SPORTMONKS_API_TOKEN (Sportmonks).
const E = require('./engine');

function provider() {
  if (process.env.FOOTBALLDATA_TOKEN) return require('./providers/footballdata');
  if (process.env.SPORTMONKS_API_TOKEN) return require('./providers/sportmonks');
  throw Object.assign(new Error('Falta FOOTBALLDATA_TOKEN ou SPORTMONKS_API_TOKEN'), { status: 500 });
}

const SKIP = new Set(['POSTPONED', 'CANCELLED', 'SUSPENDED', 'POSTP', 'CANCL', 'CANC', 'ABAN', 'PST']);

async function buildDay(date) {
  const P = provider();
  const fixtures = await P.listFixtures(date);
  const out = [];

  for (const f of fixtures) {
    if (f.state && SKIP.has(f.state.short_name)) continue; // jogos adiados/cancelados não entram
    const { home, away } = E.sides(f);
    if (!home || !away) continue;
    const kick = E.kickoffTs(f);
    const [hh, ah] = await Promise.all([P.history(home.id, date), P.history(away.id, date)]);
    // só jogos anteriores a este (evita "espreitar" o resultado), sem o próprio jogo
    const before = (h) => h.filter((x) => x.id !== f.id && E.kickoffTs(x) < kick);
    const fh = E.formOf(home.id, before(hh));
    const fa = E.formOf(away.id, before(ah));
    const finished = E.isFinished(f);
    const final = finished ? E.goalsFrom(f) : null;
    const ht = finished ? E.goalsFrom(f, '1ST_HALF') : null;
    const formStr = (rows) => rows.slice(0, 5).map((r) => (r.gf > r.ga ? 'V' : r.gf === r.ga ? 'E' : 'D'));

    out.push({
      id: f.id,
      league: f.league ? f.league.name : '',
      startingAt: new Date(kick).toISOString(),
      state: f.state ? f.state.short_name : '',
      finished,
      score: final,
      ht,
      home: { name: home.name, logo: home.image_path || '', form: formStr(fh) },
      away: { name: away.name, logo: away.image_path || '', form: formStr(fa) },
      prediction: E.buildPrediction(fh, fa, E.toResult(final, ht)),
    });
  }

  out.sort((a, b) => a.startingAt.localeCompare(b.startingAt));
  return { date, generatedAt: new Date().toISOString(), matches: out };
}

module.exports = { buildDay };
