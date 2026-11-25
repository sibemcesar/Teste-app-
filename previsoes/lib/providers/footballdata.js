'use strict';
// Fonte de dados: football-data.org v4 (variável FOOTBALLDATA_TOKEN).
// Plano grátis: 12 competições e 10 pedidos por minuto. Faz 1 pedido por competição (a época inteira):
// isso traz de uma vez a forma de todas as equipas e os jogos que ainda vão acontecer.
// Os jogos são convertidos para o mesmo formato interno usado pelo motor (estilo Sportmonks).
const BASE = 'https://api.football-data.org/v4';
// Premier League, Championship, Bundesliga, Serie A, La Liga, Ligue 1, Eredivisie, Primeira Liga, Brasileirão, Champions League
const DEFAULT_COMPS = 'PL,ELC,BL1,SA,PD,FL1,DED,PPL,BSA,CL';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = () => (process.env.FD_PACE_MS != null ? Number(process.env.FD_PACE_MS) : 6500); // 10 pedidos/minuto

async function fdGet(path) {
  const token = (process.env.FOOTBALLDATA_TOKEN || '').trim();
  if (!token) throw Object.assign(new Error('FOOTBALLDATA_TOKEN em falta'), { status: 500 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(BASE + path, { headers: { 'X-Auth-Token': token } });
    if (r.status === 429) { // limite por minuto: espera e tenta outra vez
      const wait = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 60;
      console.warn('football-data.org: limite atingido, a esperar ' + wait + 's');
      await sleep(Math.min(wait, 90) * 1000);
      continue;
    }
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.text()).slice(0, 160).replace(/\s+/g, ' '); } catch (e) { /* sem corpo */ }
      throw Object.assign(new Error('football-data.org respondeu ' + r.status + (msg ? ' (' + msg + ')' : '')), { status: 502 });
    }
    return r.json();
  }
  throw Object.assign(new Error('football-data.org: limite de pedidos'), { status: 429 });
}

// Converte um jogo da football-data.org para o formato interno
function toFixture(m, comp) {
  const finished = m.status === 'FINISHED';
  const sc = m.score || {};
  // Resultado dos 90 minutos: com prolongamento/penáltis usa regularTime, se existir (senão fica sem resultado)
  const ft = !finished ? null : (!sc.duration || sc.duration === 'REGULAR') ? sc.fullTime : (sc.regularTime || null);
  const scores = [];
  const push = (description, t) => {
    if (t && t.home != null && t.away != null) {
      scores.push({ description, score: { goals: t.home, participant: 'home' } });
      scores.push({ description, score: { goals: t.away, participant: 'away' } });
    }
  };
  if (finished) { push('CURRENT', ft); push('1ST_HALF', sc.halfTime); }
  const team = (t, location) => ({ id: t.id, name: t.shortName || t.name, image_path: t.crest || '', meta: { location } });
  return {
    id: m.id,
    starting_at: String(m.utcDate || '').replace('T', ' ').replace('Z', ''),
    state: { short_name: finished ? 'FT' : m.status },
    league: { name: (m.competition && m.competition.name) || (comp && comp.name) || '' },
    participants: [team(m.homeTeam, 'home'), team(m.awayTeam, 'away')],
    scores,
  };
}

let poolPromise = null;

// Todos os jogos da época das competições escolhidas (carrega uma vez por execução)
function loadPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const comps = (process.env.FD_COMPETITIONS || DEFAULT_COMPS).split(',').map((s) => s.trim()).filter(Boolean);
      const all = [], errors = [];
      for (let i = 0; i < comps.length; i++) {
        try {
          const j = await fdGet(`/competitions/${comps[i]}/matches`);
          let n = 0;
          for (const m of j.matches || []) {
            if (!m.homeTeam || !m.homeTeam.id || !m.awayTeam || !m.awayTeam.id) continue; // equipas ainda por definir
            all.push(toFixture(m, j.competition)); n++;
          }
          console.log('football-data.org', comps[i], n, 'jogos');
        } catch (e) {
          errors.push(comps[i] + ': ' + e.message);
        }
        if (i < comps.length - 1) await sleep(pace());
      }
      if (!all.length) throw Object.assign(new Error('football-data.org: nenhuma competição carregada (' + errors.join('; ') + ')'), { status: 502 });
      if (errors.length) console.warn('football-data.org: competições ignoradas: ' + errors.join('; '));
      return all;
    })();
    poolPromise.catch(() => { poolPromise = null; }); // se falhar, a próxima chamada tenta de novo
  }
  return poolPromise;
}

async function listFixtures(date) {
  const pool = await loadPool();
  return pool.filter((f) => f.starting_at.slice(0, 10) === date);
}

async function history(teamId) {
  const pool = await loadPool();
  return pool.filter((f) => f.participants.some((p) => p.id === teamId));
}

module.exports = { name: 'footballdata', listFixtures, history, toFixture };
