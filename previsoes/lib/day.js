'use strict';
// Constrói as previsões de um dia a partir da Sportmonks. Usado pelo gerador (GitHub Actions)
// e, opcionalmente, pela função serverless da Vercel.
const E = require('./engine');

const BASE = 'https://api.sportmonks.com/v3/football';
const DAY = 86400000;
const cache = new Map(); // cache simples em memória (por execução)

async function sm(path, params = {}) {
  const token = process.env.SPORTMONKS_API_TOKEN;
  if (!token) throw Object.assign(new Error('SPORTMONKS_API_TOKEN em falta'), { status: 500 });
  const url = new URL(BASE + path);
  url.searchParams.set('api_token', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const key = url.pathname + url.search.replace(/api_token=[^&]+&?/, '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.data;

  const rows = [];
  for (let page = 1; page <= 5; page++) {
    url.searchParams.set('page', page);
    const r = await fetch(url);
    if (!r.ok) throw Object.assign(new Error('Sportmonks respondeu ' + r.status), { status: 502 });
    const j = await r.json();
    const d = j.data;
    if (Array.isArray(d)) rows.push(...d); else if (d) rows.push(d);
    if (!(j.pagination && j.pagination.has_more)) break;
  }
  cache.set(key, { t: Date.now(), data: rows });
  return rows;
}

const iso = (ts) => new Date(ts).toISOString().slice(0, 10);

async function teamHistory(teamId, dateStr) {
  const end = Date.parse(dateStr + 'T00:00:00Z') + DAY; // inclui o próprio dia
  const start = end - 95 * DAY; // limite da API: 100 dias
  return sm(`/fixtures/between/${iso(start)}/${iso(end)}/${teamId}`, { include: 'participants;scores;state' });
}

async function buildDay(date) {
  const fixtures = await sm(`/fixtures/date/${date}`, { include: 'participants;scores;state;league' });
  const out = [];

  for (const f of fixtures) {
    const { home, away } = E.sides(f);
    if (!home || !away) continue;
    const kick = E.kickoffTs(f);
    const [hh, ah] = await Promise.all([teamHistory(home.id, date), teamHistory(away.id, date)]);
    // só jogos anteriores a este (evita "espreitar" o resultado), sem o próprio jogo
    const before = (h) => h.filter((x) => x.id !== f.id && E.kickoffTs(x) < kick);
    const fh = E.formOf(home.id, before(hh));
    const fa = E.formOf(away.id, before(ah));
    const finished = E.isFinished(f);
    const final = finished ? E.goalsFrom(f) : null;
    const formStr = (rows) => rows.slice(0, 5).map((r) => (r.gf > r.ga ? 'V' : r.gf === r.ga ? 'E' : 'D'));

    out.push({
      id: f.id,
      league: f.league ? f.league.name : '',
      startingAt: new Date(kick).toISOString(),
      state: f.state ? f.state.short_name : '',
      finished,
      score: final,
      home: { name: home.name, logo: home.image_path || '', form: formStr(fh) },
      away: { name: away.name, logo: away.image_path || '', form: formStr(fa) },
      prediction: E.buildPrediction(fh, fa, final),
    });
  }

  out.sort((a, b) => a.startingAt.localeCompare(b.startingAt));
  return { date, generatedAt: new Date().toISOString(), matches: out };
}

module.exports = { buildDay, sm };
