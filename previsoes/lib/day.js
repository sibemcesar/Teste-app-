'use strict';
// Constrói as previsões de um dia. Usado pelo gerador (GitHub Actions) e, opcionalmente, pela função da Vercel.
// A fonte de dados escolhe-se pelas variáveis de ambiente: FOOTBALLDATA_TOKEN (football-data.org) tem prioridade;
// se não existir, usa SPORTMONKS_API_TOKEN (Sportmonks).
const E = require('./engine');

function provider() {
  if (process.env.STATSAPI_KEY) return require('./providers/statsapi');
  if (process.env.FOOTBALLDATA_TOKEN) return require('./providers/footballdata');
  if (process.env.SPORTMONKS_API_TOKEN) return require('./providers/sportmonks');
  throw Object.assign(new Error('Falta STATSAPI_KEY, FOOTBALLDATA_TOKEN ou SPORTMONKS_API_TOKEN'), { status: 500 });
}

const SKIP = new Set(['POSTPONED', 'CANCELLED', 'SUSPENDED', 'POSTP', 'CANCL', 'CANC', 'ABAN', 'PST']);

// old (opcional): dia já guardado. Jogos com previsão v2 não precisam de histórico (a previsão está congelada).
async function buildDay(date, old) {
  const P = provider();
  const oldById = new Map(((old && old.matches) || []).map((m) => [m.id, m]));
  const fixtures = await P.listFixtures(date, { old: oldById });
  const out = [];

  for (const f of fixtures) {
    if (f.state && SKIP.has(f.state.short_name)) continue; // jogos adiados/cancelados não entram
    const { home, away } = E.sides(f);
    if (!home || !away) continue;
    const kick = E.kickoffTs(f);
    const o = oldById.get(f.id);
    const finished = E.isFinished(f);
    // previsão congelada: jogo já começado/terminado, ou já calculada com o modelo atual.
    // Jogos que ainda não começaram são recalculados quando o modelo muda (continua a ser antes do apito).
    const op = o && o.prediction;
    const moreStats = !!(P.matchStats && op && op.cn === 2 && P.statsBudgetLeft && P.statsBudgetLeft() > 30); // faltavam estatísticas por falta de orçamento
    const frozen = !!(op && op.v === 2 && (finished || kick <= Date.now() || (op.rev === E.REV && op.pv === (E.getParams().version || 0) && !moreStats)));
    const [hh, ah] = frozen ? [[], []] : await Promise.all([P.history(home.id, date), P.history(away.id, date)]);
    let xs = null; // estatísticas dos jogos (xG da época), se a fonte as tiver
    if (!frozen && !finished && P.teamXg) {
      const [xh, xa] = await Promise.all([P.teamXg(home.id, f.season_id), P.teamXg(away.id, f.season_id)]);
      if (xh && xa) xs = { h: xh, a: xa };
    }
    // só jogos anteriores a este (evita "espreitar" o resultado), sem o próprio jogo
    const before = (h) => h.filter((x) => x.id !== f.id && E.kickoffTs(x) < kick);
    const fh = E.formOf(home.id, before(hh));
    const fa = E.formOf(away.id, before(ah));
    const final = finished ? E.goalsFrom(f) : null;
    const ht = finished ? E.goalsFrom(f, '1ST_HALF') : null;
    // escanteios e cartões: resultado real (jogos terminados) e forma recente das equipas (jogos por acontecer)
    let extra, cs = null, incomplete = false;
    if (finished && P.matchStats) {
      const ms = await P.matchStats(f.id);
      if (ms) extra = { c: ms.c, k: ms.k };
    }
    if (!frozen && !finished && P.matchStats) {
      const teamRows = async (teamId, form) => {
        const C = [], K = [];
        for (const r of form) {
          const ms = await P.matchStats(r.id);
          if (ms === undefined) { incomplete = true; continue; }
          if (!ms) continue;
          const i = r.home ? 0 : 1;
          if (ms.c) C.push({ f: ms.c[i], a: ms.c[1 - i] });
          if (ms.k) K.push({ f: ms.k[i], a: ms.k[1 - i] });
        }
        return { C, K };
      };
      const [th, ta] = await Promise.all([teamRows(home.id, fh), teamRows(away.id, fa)]);
      cs = { C: { h: th.C, a: ta.C }, K: { h: th.K, a: ta.K } };
    }
    const formStr = (rows) => rows.slice(0, 5).map((r) => (r.gf > r.ga ? 'V' : r.gf === r.ga ? 'E' : 'D'));

    const prediction = frozen ? null : E.buildPrediction(fh, fa, E.toResult(final, ht, extra), f.league && f.league.name, xs, cs);
    if (prediction) prediction.cn = prediction.cx || prediction.kx ? 1 : incomplete ? 2 : 0; // 1 = com estatísticas, 2 = faltaram (orçamento), 0 = sem estatísticas
    out.push({
      id: f.id,
      league: f.league ? f.league.name : '',
      leagueCc: (f.league && f.league.cc) || '',
      startingAt: new Date(kick).toISOString(),
      state: f.state ? f.state.short_name : '',
      finished,
      score: final,
      ht,
      ...(extra ? { extra } : {}),
      home: { name: home.name, logo: home.image_path || '', form: formStr(fh) },
      away: { name: away.name, logo: away.image_path || '', form: formStr(fa) },
      prediction,
    });
  }

  out.sort((a, b) => a.startingAt.localeCompare(b.startingAt));
  return { date, generatedAt: new Date().toISOString(), matches: out };
}

module.exports = { buildDay };
