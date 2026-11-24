'use strict';
// Função serverless (Vercel): GET /api/previsoes?date=YYYY-MM-DD
// Mantém a chave da Sportmonks no servidor (variável SPORTMONKS_API_TOKEN) e calcula as previsões.
const E = require('../lib/engine');

const BASE = 'https://api.sportmonks.com/v3/football';
const DAY = 86400000;
const cache = new Map(); // cache simples em memória (por instância)

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
  let page = 1;
  for (; page <= 5; page++) {
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

module.exports = async function handler(req, res) {
  try {
    const date = String((req.query && req.query.date) || iso(Date.now()));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date inválida (YYYY-MM-DD)' });

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

      out.push({
        id: f.id,
        league: f.league ? f.league.name : '',
        startingAt: new Date(kick).toISOString(),
        state: f.state ? f.state.short_name : '',
        finished,
        score: final,
        home: { name: home.name, logo: home.image_path || '', form: fh.slice(0, 5).map((r) => (r.gf > r.ga ? 'V' : r.gf === r.ga ? 'E' : 'D')) },
        away: { name: away.name, logo: away.image_path || '', form: fa.slice(0, 5).map((r) => (r.gf > r.ga ? 'V' : r.gf === r.ga ? 'E' : 'D')) },
        prediction: E.buildPrediction(fh, fa, final),
      });
    }

    out.sort((a, b) => a.startingAt.localeCompare(b.startingAt));
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ date, generatedAt: new Date().toISOString(), matches: out });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'erro' });
  }
};
