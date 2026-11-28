'use strict';
// Aprendizagem: ajusta os parâmetros do modelo com os resultados já conhecidos.
// Regras de segurança:
//  - só aprende com amostra suficiente (MIN_GAMES jogos terminados);
//  - cada valor é puxado para o valor por defeito quando há poucos dados e fica dentro de limites;
//  - validação "walk-forward": ajusta nos jogos mais antigos e testa nos mais recentes.
//    Os parâmetros novos só são adotados se previrem melhor do que os atuais nesse teste.
//  - previsões já registadas nunca são alteradas: os parâmetros novos só valem para jogos novos.
const E = require('./engine');
const D = E.DEFAULTS;

const MIN_GAMES = Number(process.env.LEARN_MIN_GAMES) || 150;
const MIN_HT = 100;
const MIN_LEAGUE = 40;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const shrinkTo = (val, def, n, k = 150) => def + (val - def) * (n / (n + k));

// Linhas de treino: um jogo terminado com previsão v2 → forma base, golos reais, liga e golos ao intervalo.
function rowsFrom(days) {
  const rows = [];
  for (const d of days) for (const m of d.matches || []) {
    const p = m.prediction;
    if (!m.finished || !m.score || !p || p.v !== 2 || !p.xg) continue;
    let base = p.base;
    if (!base) { // previsões antigas (parâmetros por defeito): recupera a base a partir do xG guardado
      base = [(p.xg[0] - 0.25 * D.leagueAvg) / 0.75 / D.homeFactor, (p.xg[1] - 0.25 * D.leagueAvg) / 0.75 / D.awayFactor];
    }
    if (!(base[0] > 0) || !(base[1] > 0)) continue;
    rows.push({ ts: Date.parse(m.startingAt) || 0, league: m.league || '', bh: base[0], ba: base[1], gh: m.score.home, ga: m.score.away, ht: m.ht || null });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

function lam(P, league, base, factor) {
  const avg = (league && P.leagues[league]) || P.leagueAvg;
  return clamp(P.formWeight * base * factor + (1 - P.formWeight) * avg, 0.3, 3.5);
}
// log-verosimilhança de Poisson dos golos reais, jogo a jogo (maior = melhor)
function perGame(P, rows) {
  return rows.map((r) => {
    const lh = lam(P, r.league, r.bh, P.homeFactor), la = lam(P, r.league, r.ba, P.awayFactor);
    return r.gh * Math.log(lh) - lh + r.ga * Math.log(la) - la;
  });
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const loglik = (P, rows) => mean(perGame(P, rows));

function fit(rows) {
  const n = rows.length;
  const tot = rows.reduce((s, r) => s + r.gh + r.ga, 0);
  const leagueAvg = clamp(shrinkTo(tot / (2 * n), D.leagueAvg, n), 0.9, 2.0);
  const byL = new Map();
  for (const r of rows) { const L = byL.get(r.league) || { n: 0, g: 0 }; L.n++; L.g += r.gh + r.ga; byL.set(r.league, L); }
  const leagues = {};
  for (const [name, L] of byL) if (name && L.n >= MIN_LEAGUE) leagues[name] = Math.round(clamp(shrinkTo(L.g / (2 * L.n), leagueAvg, L.n, 60), 0.9, 2.0) * 1000) / 1000;

  const ht = rows.filter((r) => r.ht && r.gh + r.ga >= 0);
  let half1Share = D.half1Share;
  if (ht.length >= MIN_HT) {
    const g = ht.reduce((s, r) => s + r.gh + r.ga, 0), h = ht.reduce((s, r) => s + r.ht.home + r.ht.away, 0);
    if (g > 0) half1Share = clamp(shrinkTo(h / g, D.half1Share, ht.length), 0.40, 0.50);
  }

  // para cada peso da forma, ajusta as vantagens de casa/fora para igualar a média de golos e escolhe o melhor peso
  let best = null;
  for (let w = 0.5; w <= 0.951; w += 0.05) {
    const P = { ...D, leagueAvg, leagues, half1Share, formWeight: w };
    const sumAvg = (r) => (P.leagues[r.league] || P.leagueAvg);
    const hf = (rows.reduce((s, r) => s + r.gh, 0) - (1 - w) * rows.reduce((s, r) => s + sumAvg(r), 0)) / (w * rows.reduce((s, r) => s + r.bh, 0));
    const af = (rows.reduce((s, r) => s + r.ga, 0) - (1 - w) * rows.reduce((s, r) => s + sumAvg(r), 0)) / (w * rows.reduce((s, r) => s + r.ba, 0));
    P.homeFactor = clamp(shrinkTo(hf, D.homeFactor, n), 0.9, 1.3);
    P.awayFactor = clamp(shrinkTo(af, D.awayFactor, n), 0.75, 1.1);
    const ll = loglik(P, rows);
    if (!best || ll > best.ll) best = { P, ll };
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const P = best.P;
  return { homeFactor: r3(P.homeFactor), awayFactor: r3(P.awayFactor), formWeight: r3(P.formWeight), half1Share: r3(P.half1Share), leagueAvg: r3(P.leagueAvg), leagues };
}

// days: ficheiros de data/. prev: modelo.json anterior (ou null). Devolve o novo conteúdo de modelo.json.
function learnGoals(days, prev) {
  const rows = rowsFrom(days);
  const base = { games: rows.length, minGames: MIN_GAMES };
  const keep = (reason) => ({ ...base, status: prev && prev.status === 'ativo' ? 'ativo' : 'a-aprender', reason, params: prev && prev.status === 'ativo' ? prev.params : null,
    version: prev ? prev.version : 0, report: prev ? prev.report : null });
  if (rows.length < MIN_GAMES) return keep('Poucos jogos terminados para aprender com segurança.');

  // validação: ajusta nos 70% mais antigos, testa nos 30% mais recentes
  const cut = Math.floor(rows.length * 0.7), train = rows.slice(0, cut), test = rows.slice(cut);
  const current = E.getParams();
  const trial = { ...D, ...fit(train) };
  const a = perGame(current, test), b = perGame(trial, test);
  const llOld = mean(a), llNew = mean(b), diffs = b.map((x, i) => x - a[i]);
  const gain = mean(diffs);
  // erro-padrão do ganho: só conta se for claramente maior do que o acaso
  const se = Math.sqrt(diffs.reduce((s, d) => s + (d - gain) * (d - gain), 0) / Math.max(1, diffs.length - 1) / diffs.length);
  const report = { testGames: test.length, loglikCurrent: Math.round(llOld * 1000) / 1000, loglikLearned: Math.round(llNew * 1000) / 1000, gainPerGame: Math.round(gain * 1000) / 1000, stdError: Math.round(se * 1000) / 1000 };
  if (!(gain > 0.002 && gain > 2 * se)) return { ...keep('Os parâmetros aprendidos não previram melhor do que os atuais no teste: mantêm-se os atuais.'), report };

  const params = fit(rows); // adotado: reajusta com todos os jogos
  const same = prev && prev.status === 'ativo' && JSON.stringify(prev.params) === JSON.stringify(params);
  return { ...base, status: 'ativo', reason: 'Parâmetros aprendidos e validados em jogos que o ajuste não viu.', params, version: same ? prev.version : (prev && prev.version || 0) + 1, report };
}

// ---------- correção de "ambas marcam" ----------
// Se o modelo previu, em média, mais (ou menos) "ambas marcam" do que aconteceu, ajusta as chances em logit.
// Um só parâmetro: basta um teste de calibração (z) em vez de validação em separado.
const MIN_BTTS = 100;
const sig = (x) => 1 / (1 + Math.exp(-x));
function bttsRows(days) {
  const rows = [];
  for (const d of days) for (const m of d.matches || []) {
    const p = m.prediction;
    if (!m.finished || !m.score || !p || p.v !== 2) continue;
    const g = (p.groups || []).find((x) => x.key === 'btts');
    const y = g && g.options.find((o) => o.id === 'btts:Y');
    if (!y || !(y.prob > 0.001 && y.prob < 0.999)) continue;
    const logit = Math.log(y.prob / (1 - y.prob)) - (p.bs || 0); // retira a correção que já tinha sido aplicada
    rows.push({ l: logit, y: m.score.home > 0 && m.score.away > 0 ? 1 : 0 });
  }
  return rows;
}
function fitBtts(rows) {
  const n = rows.length;
  if (n < MIN_BTTS) return null;
  const p0 = rows.map((r) => sig(r.l));
  const z = (rows.reduce((a, r) => a + r.y, 0) - p0.reduce((a, x) => a + x, 0)) / Math.sqrt(p0.reduce((a, x) => a + x * (1 - x), 0));
  if (!(Math.abs(z) >= 1.64)) return { n, z, shift: 0, used: false };
  let s = 0;
  for (let i = 0; i < 25; i++) { // Newton
    let g = 0, h = 0;
    for (const r of rows) { const q = sig(r.l + s); g += r.y - q; h -= q * (1 - q); }
    if (!h) break;
    s = clamp(s - g / h, -2, 2);
  }
  const shift = Math.round(clamp(shrinkTo(s, 0, n, 60), -0.8, 0.8) * 1000) / 1000;
  return { n, z: Math.round(z * 100) / 100, shift, used: true };
}

// golos (validação walk-forward) + correção de "ambas marcam"
function learn(days, prev) {
  const g = learnGoals(days, prev);
  const b = fitBtts(bttsRows(days));
  const params = { ...(g.status === 'ativo' && g.params ? g.params : {}), ...(b && b.used ? { bttsShift: b.shift } : {}) };
  if (!Object.keys(params).length) return { ...g, btts: b };
  const same = prev && prev.status === 'ativo' && JSON.stringify(prev.params) === JSON.stringify(params);
  const reasons = [g.status === 'ativo' ? 'Golos: parâmetros aprendidos e validados.' : null, b && b.used ? 'Ambas marcam: o modelo estava ' + (b.shift < 0 ? 'otimista' : 'pessimista') + ' (z = ' + b.z + ').' : null].filter(Boolean);
  return { ...g, status: 'ativo', params, version: same ? prev.version : (prev && prev.version || 0) + 1, reason: reasons.join(' '), btts: b };
}

module.exports = { learn, rowsFrom, fit, loglik, bttsRows, fitBtts, MIN_GAMES };
