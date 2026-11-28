'use strict';
// Fonte de dados: TheStatsAPI (variável STATSAPI_KEY). Autenticação: Authorization: Bearer <chave>.
// A lista de jogos não traz o nome da liga, o logótipo nem o resultado ao intervalo:
//  - o nome da liga vem de /football/competitions (1 pedido, em cache);
//  - o intervalo vem do detalhe do jogo, só pedido para jogos terminados que ainda não temos guardados;
//  - o histórico de cada equipa é a mesma lista filtrada por team_id (em cache durante a execução).
const BASE = 'https://api.thestatsapi.com/api';
// Filtro por nome de competição (substring, sem maiúsculas). STATS_COMPETITIONS substitui; "*" = todas.
const DEFAULT_COMPS = 'Premier League,Championship,Bundesliga,Serie A,Serie B,La Liga,Ligue 1,Eredivisie,Primeira Liga,Champions League,National League';
const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params) {
  const key = (process.env.STATSAPI_KEY || '').trim();
  if (!key) throw Object.assign(new Error('STATSAPI_KEY em falta'), { status: 500 });
  const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString() : '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(BASE + path + qs, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
    if (r.status === 429) {
      const wait = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 30;
      let body = ''; try { body = await r.text(); } catch (e) { /* */ }
      if (/USAGE_LIMIT_EXCEEDED/.test(body)) throw Object.assign(new Error('TheStatsAPI: quota mensal esgotada'), { status: 429 });
      console.warn('TheStatsAPI: limite por minuto, a esperar ' + wait + 's');
      await sleep(Math.min(wait, 90) * 1000);
      continue;
    }
    if (!r.ok) {
      let msg = ''; try { msg = (await r.text()).slice(0, 160).replace(/\s+/g, ' '); } catch (e) { /* */ }
      throw Object.assign(new Error('TheStatsAPI respondeu ' + r.status + (msg ? ' (' + msg + ')' : '')), { status: 502 });
    }
    return r.json();
  }
  throw Object.assign(new Error('TheStatsAPI: limite de pedidos'), { status: 429 });
}

async function getAll(path, params, maxPages = 5) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const j = await get(path, { ...params, page, per_page: 100 });
    out.push(...(j.data || []));
    const tp = j.meta && j.meta.total_pages;
    if (!tp || page >= tp) break;
  }
  return out;
}

// Converte um jogo da TheStatsAPI para o formato interno. `ht` = {home,away} ou null; `names` = mapa id → liga
function toFixture(m, names, ht) {
  const finished = m.status === 'finished';
  const sc = m.score || {};
  const reg = sc.regulation && sc.regulation.home != null ? sc.regulation : sc; // 90 minutos
  const scores = [];
  const push = (description, t) => {
    if (t && t.home != null && t.away != null) {
      scores.push({ description, score: { goals: t.home, participant: 'home' } });
      scores.push({ description, score: { goals: t.away, participant: 'away' } });
    }
  };
  if (finished) { push('CURRENT', reg); push('1ST_HALF', ht); }
  const team = (t, location) => ({ id: t.id, name: t.name, image_path: '', meta: { location } });
  return {
    id: m.id,
    season_id: m.season_id || null,
    starting_at: String(m.utc_date || '').replace('T', ' ').replace(/\.\d+Z$|Z$/, ''),
    state: { short_name: finished ? 'FT' : String(m.status || '').toUpperCase() },
    league: { name: (names && names.get(m.competition_id)) || m.competition_name || '', cc: ccs.get(m.competition_id) || '' },
    participants: [team(m.home_team, 'home'), team(m.away_team, 'away')],
    scores,
  };
}

let compsPromise = null;
const ccs = new Map(); // id da competição → código do país (ex.: DE, GB-ENG)
function competitions() {
  if (!compsPromise) {
    compsPromise = getAll('/football/competitions', null, 10)
      .then((rows) => { rows.forEach((c) => { const cc = c.subdivision_code || c.country_code; if (cc) ccs.set(c.id, String(cc).toUpperCase()); }); return new Map(rows.map((c) => [c.id, c.name])); })
      .catch((e) => { console.warn('TheStatsAPI: sem nomes de ligas (' + e.message + ')'); return new Map(); });
  }
  return compsPromise;
}

function allowed(names, id) {
  const cfg = (process.env.STATS_COMPETITIONS || DEFAULT_COMPS).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (cfg.includes('*') || !names.size) return true; // sem nomes não dá para filtrar
  const name = String(names.get(id) || '').toLowerCase();
  return cfg.some((c) => c === String(id).toLowerCase() || (name && name.includes(c)));
}

// old: Map id → jogo já guardado (para não repetir pedidos de jogos terminados)
async function listFixtures(date, opts = {}) {
  const old = opts.old || new Map();
  const names = await competitions();
  const rows = await getAll('/football/matches', { date_from: date, date_to: date, sort: 'utc_date' });
  const max = Number(process.env.STATS_MAX_MATCHES) || 40;
  const keep = rows.filter((m) => m.home_team && m.away_team && allowed(names, m.competition_id)).slice(0, max);
  const out = [];
  for (const m of keep) {
    let ht = null;
    const o = old.get(m.id);
    if (m.status === 'finished') {
      if (o && o.finished && o.score) ht = o.ht || null; // já temos o intervalo guardado
      else {
        try {
          const d = await get('/football/matches/' + m.id);
          const s = ((d && d.data) || d || {}).score || {};
          if (s.half_time_home != null && s.half_time_away != null) ht = { home: s.half_time_home, away: s.half_time_away };
        } catch (e) { console.warn('TheStatsAPI: sem detalhe de ' + m.id + ': ' + e.message); }
      }
    }
    out.push(toFixture(m, names, ht));
  }
  return out;
}

const histCache = new Map();
async function history(teamId, date) {
  const k = teamId + '|' + date;
  if (!histCache.has(k)) {
    const from = new Date(Date.parse(date + 'T00:00:00Z') - 95 * DAY).toISOString().slice(0, 10);
    histCache.set(k, get('/football/matches', { team_id: teamId, status: 'finished', date_from: from, date_to: date, sort: '-utc_date', per_page: 20 })
      .then((j) => (j.data || []).filter((m) => m.home_team && m.away_team).map((m) => toFixture(m, null, null))));
    histCache.get(k).catch(() => histCache.delete(k));
  }
  return histCache.get(k);
}

// xG por jogo de uma equipa na época (1 pedido por equipa). Guarda em cache 24 h, também entre execuções (data/xg-equipas.json).
const XG_TTL = 24 * 3600 * 1000;
const xgCache = new Map(); // "equipa|época" → { t, f, a, n } ou { t, none: true }
let xgDirty = false;
const loadXgCache = (obj) => { for (const [k, v] of Object.entries(obj || {})) xgCache.set(k, v); };
const dumpXgCache = () => (xgDirty ? Object.fromEntries(xgCache) : null);
async function teamXg(teamId, seasonId) {
  if (!teamId || !seasonId) return null;
  const k = teamId + '|' + seasonId, c = xgCache.get(k);
  if (c && Date.now() - c.t < XG_TTL) return c.none ? null : c;
  try {
    const j = await get('/football/teams/' + teamId + '/stats', { season_id: seasonId });
    const d = (j && j.data) || j || {};
    const n = Number(d.xg_matches), f = Number(d.expected_goals_for), a = Number(d.expected_goals_against);
    const v = n > 0 && isFinite(f) && isFinite(a) ? { t: Date.now(), f: Math.round((f / n) * 1000) / 1000, a: Math.round((a / n) * 1000) / 1000, n } : { t: Date.now(), none: true };
    xgCache.set(k, v); xgDirty = true;
    return v.none ? null : v;
  } catch (e) {
    if (e.status === 429) throw e; // quota/limite: deixa falhar o dia, não escondas
    xgCache.set(k, { t: Date.now() - XG_TTL + 3600 * 1000, none: true }); xgDirty = true; // sem xG: tenta de novo daqui a 1 hora
    return null;
  }
}

module.exports = { name: 'statsapi', listFixtures, history, toFixture, teamXg, loadXgCache, dumpXgCache };
