'use strict';
// Fonte de dados: Sportmonks (variável SPORTMONKS_API_TOKEN).
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

// Jogos de um dia (AAAA-MM-DD)
async function listFixtures(date) {
  return sm(`/fixtures/date/${date}`, { include: 'participants;scores;state;league' });
}

// Jogos recentes de uma equipa até ao dia indicado
async function history(teamId, dateStr) {
  const end = Date.parse(dateStr + 'T00:00:00Z') + DAY; // inclui o próprio dia
  const start = end - 95 * DAY; // limite da API: 100 dias
  return sm(`/fixtures/between/${iso(start)}/${iso(end)}/${teamId}`, { include: 'participants;scores;state' });
}

module.exports = { name: 'sportmonks', listFixtures, history, sm };
