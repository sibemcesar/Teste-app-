'use strict';
// Desempenho do modelo: compara o que o modelo previu com o que aconteceu, nos jogos já terminados.
// Só usa previsões v2. "pre" = registadas antes do jogo (o registo verdadeiro); "all" = todas (inclui calculadas depois).

const BINS = [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
const isBool = (h) => h === true || h === false;

function summarize(matches) {
  const best = { n: 0, hits: 0, probSum: 0 };
  const leagues = new Map(), groups = new Map();
  const bins = BINS.map(([a, b]) => ({ from: a, to: Math.min(b, 1), n: 0, hits: 0, probSum: 0 }));

  for (const m of matches) {
    const p = m.prediction;
    if (p.best && isBool(p.best.hit)) {
      best.n++; best.probSum += p.best.prob; if (p.best.hit) best.hits++;
      const L = leagues.get(m.league || 'Outras ligas') || { league: m.league || 'Outras ligas', n: 0, hits: 0 };
      L.n++; if (p.best.hit) L.hits++; leagues.set(L.league, L);
    }
    for (const g of p.groups || []) {
      const G = groups.get(g.key) || { key: g.key, label: g.label, n: 0, hits: 0, probSum: 0 };
      for (const o of g.options || []) {
        if (!isBool(o.hit)) continue; // 'void' e jogos sem resultado ficam de fora
        G.n++; G.probSum += o.prob; if (o.hit) G.hits++;
        const b = bins.find((x) => o.prob >= x.from && o.prob < (x.to === 1 ? 1.01 : x.to));
        if (b) { b.n++; b.probSum += o.prob; if (o.hit) b.hits++; }
      }
      groups.set(g.key, G);
    }
  }
  const r = (x) => Math.round(x * 1000) / 1000;
  return {
    games: matches.length,
    best: { n: best.n, hits: best.hits, avgProb: best.n ? r(best.probSum / best.n) : null },
    leagues: [...leagues.values()].sort((a, b) => b.n - a.n),
    groups: [...groups.values()].filter((g) => g.n).map((g) => ({ key: g.key, label: g.label, n: g.n, hits: g.hits, avgProb: r(g.probSum / g.n) })),
    bins: bins.filter((b) => b.n).map((b) => ({ from: b.from, to: b.to, n: b.n, hits: b.hits, avgProb: r(b.probSum / b.n) })),
  };
}

// days: lista de { date, matches } (ficheiros de data/)
function compute(days) {
  const all = [];
  for (const d of days) for (const m of d.matches || []) {
    if (m.finished && m.score && m.prediction && m.prediction.v === 2) all.push(m);
  }
  return { days: days.length, pre: summarize(all.filter((m) => m.preGame)), all: summarize(all) };
}

module.exports = { compute, summarize };
