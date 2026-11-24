'use strict';
// Motor de previsão: modelo de Poisson a partir dos golos recentes de cada equipa.
// Sem dependências, corre em Node e é testável sem rede.

const FINISHED = new Set(['FT', 'AET', 'FT_PEN']);
const LEAGUE_AVG_GOALS = 1.35; // média típica de golos por equipa (prior)

function goalsFrom(fixture, description = 'CURRENT') {
  let h = null, a = null;
  for (const s of fixture.scores || []) {
    if (s.description !== description || !s.score) continue;
    if (s.score.participant === 'home') h = s.score.goals;
    else if (s.score.participant === 'away') a = s.score.goals;
  }
  return h == null || a == null ? null : { home: h, away: a };
}

function sides(fixture) {
  const p = fixture.participants || [];
  return {
    home: p.find((x) => x.meta && x.meta.location === 'home'),
    away: p.find((x) => x.meta && x.meta.location === 'away'),
  };
}

function isFinished(f) {
  return !!(f.state && FINISHED.has(f.state.short_name));
}

function kickoffTs(f) {
  return Date.parse(String(f.starting_at || '').replace(' ', 'T') + 'Z');
}

// Últimos jogos terminados de uma equipa (mais recente primeiro)
function formOf(teamId, fixtures, limit = 6) {
  return fixtures
    .filter(isFinished)
    .map((f) => {
      const { home, away } = sides(f);
      const g = goalsFrom(f);
      if (!home || !away || !g) return null;
      const isHome = home.id === teamId;
      if (!isHome && away.id !== teamId) return null;
      return { ts: kickoffTs(f), gf: isHome ? g.home : g.away, ga: isHome ? g.away : g.home };
    })
    .filter(Boolean)
    .sort((x, y) => y.ts - x.ts)
    .slice(0, limit);
}

function poissonPmf(lambda, max) {
  const out = [Math.exp(-lambda)];
  for (let k = 1; k <= max; k++) out.push((out[k - 1] * lambda) / k);
  return out;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function predict(formHome, formAway) {
  if (formHome.length < 3 || formAway.length < 3) return null; // dados insuficientes

  const wavg = (rows, k) => {
    let s = 0, w = 0;
    rows.forEach((r, i) => {
      const wt = Math.pow(0.85, i); // jogos mais recentes pesam mais
      s += r[k] * wt;
      w += wt;
    });
    return s / w;
  };

  let lh = ((wavg(formHome, 'gf') + wavg(formAway, 'ga')) / 2) * 1.08; // vantagem de jogar em casa
  let la = ((wavg(formAway, 'gf') + wavg(formHome, 'ga')) / 2) * 0.93;
  // encolhe para a média: poucas amostras não devem dar previsões extremas
  lh = clamp(0.75 * lh + 0.25 * LEAGUE_AVG_GOALS, 0.3, 3.5);
  la = clamp(0.75 * la + 0.25 * LEAGUE_AVG_GOALS, 0.3, 3.5);

  const N = 10;
  const ph = poissonPmf(lh, N), pa = poissonPmf(la, N);
  let h = 0, d = 0, a = 0, over25 = 0, bttsY = 0, total = 0;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const p = ph[i] * pa[j];
      total += p;
      if (i > j) h += p; else if (i === j) d += p; else a += p;
      if (i + j > 2) over25 += p;
      if (i > 0 && j > 0) bttsY += p;
    }
  }
  h /= total; d /= total; a /= total; over25 /= total; bttsY /= total;
  return { xg: [lh, la], p: { h, d, a, over25, under25: 1 - over25, bttsY, bttsN: 1 - bttsY } };
}

function confidence(prob) {
  return prob >= 0.65 ? 'alta' : prob >= 0.55 ? 'média' : 'baixa';
}

function buildMarkets(p) {
  const defs = [
    { key: '1x2', label: 'Resultado', options: [
      { code: '1', label: 'Vitória casa', prob: p.h },
      { code: 'X', label: 'Empate', prob: p.d },
      { code: '2', label: 'Vitória fora', prob: p.a } ] },
    { key: 'goals', label: 'Golos', options: [
      { code: 'O25', label: 'Mais de 2,5', prob: p.over25 },
      { code: 'U25', label: 'Menos de 2,5', prob: p.under25 } ] },
    { key: 'btts', label: 'Ambas marcam', options: [
      { code: 'Y', label: 'Sim', prob: p.bttsY },
      { code: 'N', label: 'Não', prob: p.bttsN } ] },
    { key: 'dc', label: 'Dupla hipótese', secondary: true, options: [
      { code: '1X', label: '1X', prob: p.h + p.d },
      { code: '12', label: '12', prob: p.h + p.a },
      { code: 'X2', label: 'X2', prob: p.d + p.a } ] },
  ];
  return defs.map((m) => {
    const best = m.options.reduce((x, y) => (y.prob > x.prob ? y : x));
    return {
      key: m.key, label: m.label, secondary: !!m.secondary,
      pick: best.code, pickLabel: best.label,
      prob: Math.round(best.prob * 1000) / 1000,
      fairOdd: Math.round((1 / best.prob) * 100) / 100, // odd "justa" implícita no modelo
    };
  });
}

// Compara uma dica com o resultado final {home, away}
function evaluate(market, goals) {
  if (!goals) return null;
  const { home: h, away: a } = goals;
  switch (market.key + ':' + market.pick) {
    case '1x2:1': return h > a;
    case '1x2:X': return h === a;
    case '1x2:2': return h < a;
    case 'goals:O25': return h + a > 2;
    case 'goals:U25': return h + a <= 2;
    case 'btts:Y': return h > 0 && a > 0;
    case 'btts:N': return h === 0 || a === 0;
    case 'dc:1X': return h >= a;
    case 'dc:12': return h !== a;
    case 'dc:X2': return h <= a;
    default: return null;
  }
}

function buildPrediction(formHome, formAway, finalGoals) {
  const pr = predict(formHome, formAway);
  if (!pr) return null;
  const markets = buildMarkets(pr.p);
  const main = markets.filter((m) => !m.secondary);
  const best = main.reduce((x, y) => (y.prob > x.prob ? y : x));
  markets.forEach((m) => { m.hit = evaluate(m, finalGoals); });
  return {
    xg: pr.xg.map((x) => Math.round(x * 100) / 100),
    markets,
    best: { key: best.key, label: best.label, pickLabel: best.pickLabel, prob: best.prob,
            fairOdd: best.fairOdd, confidence: confidence(best.prob), hit: best.hit },
  };
}

module.exports = { goalsFrom, sides, isFinished, kickoffTs, formOf, predict, buildMarkets, evaluate, buildPrediction, confidence };
