'use strict';
// Motor de previsão v2: modelo de Poisson com duas partes (1.ª e 2.ª).
// Todas as probabilidades saem da MESMA distribuição conjunta de golos, por isso são coerentes entre si.
// Cada mercado é definido uma só vez (id + teste), e o mesmo teste serve para calcular a probabilidade
// e para dizer se a dica acertou depois do jogo. Sem dependências, testável sem rede.

const FINISHED = new Set(['FT', 'AET', 'FT_PEN']);
// Parâmetros do modelo. Os valores por defeito são os de partida; o gerador pode aprender melhores
// (ver lib/learn.js e data/modelo.json) e passá-los com setParams().
const DEFAULTS = Object.freeze({
  version: 0,
  homeFactor: 1.08, // vantagem de jogar em casa
  awayFactor: 0.93,
  formWeight: 0.75, // peso da forma recente (o resto vai para a média da liga)
  half1Share: 0.45, // fração dos golos que acontecem na 1.ª parte
  leagueAvg: 1.35, // média de golos por equipa
  xgWeight: 0.5, // peso do xG da época (estatísticas dos jogos) face aos golos recentes, quando há xG das duas equipas
  bttsShift: 0, // correção (em logit) à probabilidade de ambas marcarem, aprendida dos resultados
  leagues: {}, // média própria de algumas ligas: { "Premier League": 1.5 }
});
// REV muda quando o modelo muda de forma: previsões de jogos que ainda não começaram são recalculadas.
const REV = 3;
let PARAMS = { ...DEFAULTS };
const setParams = (p) => { PARAMS = { ...DEFAULTS, ...(p || {}), leagues: { ...((p && p.leagues) || {}) } }; };
const getParams = () => PARAMS;
const N = 8; // golos máximos por equipa em cada parte (a cauda além disto é desprezável)

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

function pmf(lambda, max) {
  const out = [Math.exp(-lambda)];
  for (let k = 1; k <= max; k++) out.push((out[k - 1] * lambda) / k);
  return out;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Golos esperados de cada equipa (ou null se faltarem dados)
// xs (opcional) = estatísticas de xG por jogo da época: { h: {f, a, n}, a: {f, a, n} } (f = a favor, a = sofrido, n = jogos com xG)
function expectedGoals(formHome, formAway, league, xs) {
  if (formHome.length < 3 || formAway.length < 3) return null;
  const wavg = (rows, k) => {
    let s = 0, w = 0;
    rows.forEach((r, i) => {
      const wt = Math.pow(0.85, i); // jogos mais recentes pesam mais
      s += r[k] * wt;
      w += wt;
    });
    return s / w;
  };
  let bh = (wavg(formHome, 'gf') + wavg(formAway, 'ga')) / 2; // base antes da vantagem de casa
  let ba = (wavg(formAway, 'gf') + wavg(formHome, 'ga')) / 2;
  // estatísticas dos jogos: mistura o xG da época (mais estável do que os golos) com os golos recentes
  let xw = 0;
  if (xs && xs.h && xs.a) {
    const nmin = Math.min(xs.h.n, xs.a.n);
    if (nmin >= 4) xw = PARAMS.xgWeight * Math.min(1, nmin / 10);
  }
  if (xw > 0) {
    bh = (1 - xw) * bh + xw * ((xs.h.f + xs.a.a) / 2);
    ba = (1 - xw) * ba + xw * ((xs.a.f + xs.h.a) / 2);
  }
  const P = PARAMS, avg = (league && P.leagues[league]) || P.leagueAvg, w = P.formWeight;
  // encolhe para a média: poucas amostras não devem dar previsões extremas
  const lh = clamp(w * bh * P.homeFactor + (1 - w) * avg, 0.3, 3.5);
  const la = clamp(w * ba * P.awayFactor + (1 - w) * avg, 0.3, 3.5);
  return { lh, la, bh, ba, xw };
}

// Distribuição conjunta: lista de {h, a, h1, a1, p} = golos finais e ao intervalo de cada equipa
function joint(lh, la, share = PARAMS.half1Share, shift = PARAMS.bttsShift) {
  const A1 = pmf(lh * share, N), B1 = pmf(la * share, N);
  const A2 = pmf(lh * (1 - share), N), B2 = pmf(la * (1 - share), N);
  const J = [];
  let tot = 0;
  for (let h1 = 0; h1 <= N; h1++) {
    for (let a1 = 0; a1 <= N; a1++) {
      const p1 = A1[h1] * B1[a1];
      for (let h2 = 0; h2 <= N; h2++) {
        for (let a2 = 0; a2 <= N; a2++) {
          const p = p1 * A2[h2] * B2[a2];
          J.push({ h: h1 + h2, a: a1 + a2, h1, a1, p });
          tot += p;
        }
      }
    }
  }
  for (const r of J) r.p /= tot;
  if (shift) { // corrige a probabilidade de ambas marcarem (multiplica as suas chances por e^shift), mantendo o resto coerente
    const f = Math.exp(shift);
    let t2 = 0;
    for (const r of J) { if (r.h > 0 && r.a > 0) r.p *= f; t2 += r.p; }
    for (const r of J) r.p /= t2;
  }
  return J;
}

// ---------- definição dos mercados ----------
// test(f) com f = {h, a, h1, a1} devolve true, false ou 'void' (aposta anulada).
// ht:true = precisa do resultado ao intervalo. main:true = candidato à dica principal.
const o = (id, label, test, extra = {}) => ({ id, label, test, ...extra });
const fmt = (x) => String(x).replace('.', ',');
const GROUPS = [];
const add = (key, label, options, extra = {}) => GROUPS.push({ key, label, options, ...extra });

add('1x2', 'Resultado final (1X2)', [
  o('1x2:1', 'Vitória casa', (f) => f.h > f.a, { main: true }),
  o('1x2:X', 'Empate', (f) => f.h === f.a, { main: true }),
  o('1x2:2', 'Vitória fora', (f) => f.h < f.a, { main: true }),
], { short: 'Resultado' });

add('dc', 'Dupla hipótese', [
  o('dc:1X', 'Casa ou empate (1X)', (f) => f.h >= f.a),
  o('dc:12', 'Casa ou fora (12)', (f) => f.h !== f.a),
  o('dc:X2', 'Empate ou fora (X2)', (f) => f.h <= f.a),
]);

add('dnb', 'Empate anula aposta', [
  o('dnb:1', 'Casa', (f) => (f.h === f.a ? 'void' : f.h > f.a)),
  o('dnb:2', 'Fora', (f) => (f.h === f.a ? 'void' : f.h < f.a)),
]);

function overUnder(key, label, total, lines, extra = {}, mainLine = null, short = null) {
  const options = [];
  for (const l of lines) {
    const main = l === mainLine;
    options.push(o(`${key}:o${l}`, `Mais de ${fmt(l)}`, (f) => total(f) > l, { ...extra, ...(main ? { main: true } : {}) }));
    options.push(o(`${key}:u${l}`, `Menos de ${fmt(l)}`, (f) => total(f) < l, { ...extra, ...(main ? { main: true } : {}) }));
  }
  add(key, label, options, short ? { short } : {});
}

overUnder('ou', 'Total de golos do jogo', (f) => f.h + f.a, [0.5, 1.5, 2.5, 3.5, 4.5], {}, 2.5, 'Golos');
add('btts', 'Ambas as equipas marcam', [
  o('btts:Y', 'Sim', (f) => f.h > 0 && f.a > 0, { main: true }),
  o('btts:N', 'Não', (f) => f.h === 0 || f.a === 0, { main: true }),
], { short: 'Ambas marcam' });
overUnder('th', 'Golos da equipa da casa', (f) => f.h, [0.5, 1.5, 2.5]);
overUnder('ta', 'Golos da equipa visitante', (f) => f.a, [0.5, 1.5, 2.5]);

add('wtn', 'Vitória sem sofrer / baliza inviolada', [
  o('wtn:1', 'Casa vence sem sofrer golos', (f) => f.h > f.a && f.a === 0),
  o('wtn:2', 'Fora vence sem sofrer golos', (f) => f.a > f.h && f.h === 0),
  o('cs0:1', 'Casa não sofre golos', (f) => f.a === 0),
  o('cs0:2', 'Fora não sofre golos', (f) => f.h === 0),
]);

add('margin', 'Margem de vitória', [
  o('mg:1+', 'Casa vence por 1 golo', (f) => f.h - f.a === 1),
  o('mg:1++', 'Casa vence por 2 ou mais', (f) => f.h - f.a >= 2),
  o('mg:2+', 'Fora vence por 1 golo', (f) => f.a - f.h === 1),
  o('mg:2++', 'Fora vence por 2 ou mais', (f) => f.a - f.h >= 2),
]);

const tgOpts = [0, 1, 2, 3, 4].map((k) => o(`tg:${k}`, k === 1 ? '1 golo' : `${k} golos`, (f) => f.h + f.a === k));
tgOpts.push(o('tg:5+', '5 ou mais golos', (f) => f.h + f.a >= 5));
add('tg', 'Número exato de golos', tgOpts);

add('par', 'Golos pares ou ímpares', [
  o('par:P', 'Par', (f) => (f.h + f.a) % 2 === 0),
  o('par:I', 'Ímpar', (f) => (f.h + f.a) % 2 === 1),
]);

const r3 = (x, y) => (x > y ? '1' : x === y ? 'X' : '2');
const WHO = { 1: 'Casa', X: 'Empate', 2: 'Fora' };

add('h1x2', '1.ª parte: resultado ao intervalo', [
  o('h1:1', 'Casa a ganhar ao intervalo', (f) => f.h1 > f.a1, { ht: true }),
  o('h1:X', 'Empate ao intervalo', (f) => f.h1 === f.a1, { ht: true }),
  o('h1:2', 'Fora a ganhar ao intervalo', (f) => f.h1 < f.a1, { ht: true }),
]);

overUnder('hou', '1.ª parte: total de golos', (f) => f.h1 + f.a1, [0.5, 1.5], { ht: true });

add('half', 'Parte com mais golos', [
  o('half:1', '1.ª parte', (f) => f.h1 + f.a1 > f.h + f.a - f.h1 - f.a1, { ht: true }),
  o('half:X', 'Igual nas duas', (f) => f.h1 + f.a1 === f.h + f.a - f.h1 - f.a1, { ht: true }),
  o('half:2', '2.ª parte', (f) => f.h1 + f.a1 < f.h + f.a - f.h1 - f.a1, { ht: true }),
]);

const htft = [];
for (const c1 of ['1', 'X', '2']) {
  for (const c2 of ['1', 'X', '2']) {
    htft.push(o(`htft:${c1}/${c2}`, `${c1}/${c2} · ${WHO[c1]} / ${WHO[c2]}`, (f) => r3(f.h1, f.a1) === c1 && r3(f.h, f.a) === c2, { ht: true }));
  }
}
add('htft', 'Intervalo / final (HT/FT)', htft);

// Opções com id dinâmico (resultado exato "cs:2-1")
function optionFor(id) {
  const found = BYID.get(id);
  if (found) return found;
  const m = /^cs:(\d+)-(\d+)$/.exec(id);
  if (m) {
    const H = +m[1], A = +m[2];
    return o(id, `${H}-${A}`, (f) => f.h === H && f.a === A);
  }
  return null;
}
const BYID = new Map(GROUPS.flatMap((g) => g.options.map((op) => [op.id, op])));

// Compara uma opção com o resultado {h, a, h1, a1}. Devolve true/false, 'void' ou null (sem dados).
function evaluate(id, result) {
  if (!result) return null;
  const op = optionFor(id);
  if (!op) return null;
  if (op.ht && (result.h1 == null || result.a1 == null)) return null;
  return op.test(result);
}

// {home, away} + {home, away} do intervalo  ->  {h, a, h1, a1}
function toResult(score, ht) {
  if (!score) return null;
  return { h: score.home, a: score.away, h1: ht ? ht.home : null, a1: ht ? ht.away : null };
}

function probOf(J, op) {
  let yes = 0, base = 0;
  for (const r of J) {
    const v = op.test(r);
    if (v === 'void') continue;
    base += r.p;
    if (v) yes += r.p;
  }
  return base > 0 ? yes / base : 0;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

function confidence(prob) {
  return prob >= 0.65 ? 'alta' : prob >= 0.55 ? 'média' : 'baixa';
}

function buildPrediction(formHome, formAway, result, league, xs) {
  const xg = expectedGoals(formHome, formAway, league, xs);
  if (!xg) return null;
  const J = joint(xg.lh, xg.la);

  // resultados exatos mais prováveis
  const byScore = new Map();
  for (const r of J) {
    const k = r.h + '-' + r.a;
    byScore.set(k, (byScore.get(k) || 0) + r.p);
  }
  const topScores = [...byScore.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6);

  const groups = GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    options: g.options.map((op) => ({ id: op.id, label: op.label, prob: round3(probOf(J, op)) })),
  }));
  const csGroup = {
    key: 'cs',
    label: 'Resultados exatos mais prováveis',
    options: topScores.map(([k, p]) => ({ id: 'cs:' + k, label: k.replace('-', ' - '), prob: round3(p) })),
  };
  groups.splice(groups.findIndex((g) => g.key === 'tg'), 0, csGroup);

  // dica principal: a opção mais provável entre os mercados "principais"
  let best = null;
  for (const g of GROUPS) {
    for (const op of g.options) {
      if (!op.main) continue;
      const prob = probOf(J, op);
      if (!best || prob > best.prob) best = { id: op.id, short: g.short, pickLabel: op.label, prob };
    }
  }
  best.prob = round3(best.prob);
  best.confidence = confidence(best.prob);

  // base = forma bruta (sem vantagem de casa) e pv = versão dos parâmetros: servem para a aprendizagem (lib/learn.js)
  const pred = { v: 2, xg: [Math.round(xg.lh * 100) / 100, Math.round(xg.la * 100) / 100], base: [Math.round(xg.bh * 1000) / 1000, Math.round(xg.ba * 1000) / 1000], pv: PARAMS.version || 0, rev: REV, sh: PARAMS.half1Share, bs: PARAMS.bttsShift || 0, groups, best };
  if (xg.xw > 0) { // estatísticas usadas (xG por jogo: a favor / sofrido) e o peso que tiveram
    const r2 = (x) => Math.round(x * 100) / 100;
    pred.st = { h: [r2(xs.h.f), r2(xs.h.a)], a: [r2(xs.a.f), r2(xs.a.a)], w: r2(xg.xw) };
  }
  return rescore(pred, result);
}

// Atualiza os acertos de uma previsão já guardada (as probabilidades não mudam)
function rescore(pred, result) {
  const groups = pred.groups.map((g) => ({
    ...g,
    options: g.options.map((op) => ({ ...op, hit: evaluate(op.id, result) })),
  }));
  return { ...pred, groups, best: { ...pred.best, hit: evaluate(pred.best.id, result) } };
}

// ---------- construtor de aposta ----------
// Probabilidade de TODAS as seleções acontecerem no mesmo jogo, a partir da distribuição conjunta.
// Respeita as ligações entre mercados (ex.: "mais de 2,5" e "ambas marcam" andam juntos), ao contrário
// de multiplicar probabilidades soltas. Seleções anuladas ('void') contam como não acertadas.
function comboProb(J, ids) {
  const ops = ids.map(optionFor);
  if (!ops.length || ops.some((x) => !x)) return null;
  let yes = 0;
  for (const r of J) if (ops.every((op) => op.test(r) === true)) yes += r.p;
  return yes;
}

// Melhores combinações de `size` seleções, no máximo uma por mercado (1X2 e dupla hipótese contam como um só), entre os mercados mais usados.
// Ignora combinações redundantes (uma seleção já implica a outra) e as quase certas (> maxProb).
function comboSuggest(J, size, top = 3, maxProb = 0.9) {
  const keys = ['1x2', 'dc', 'ou', 'btts'];
  const cands = [];
  for (const g of GROUPS) {
    if (!keys.includes(g.key)) continue;
    for (const op of g.options) {
      if (g.key === 'ou' && !/:(o|u)(1\.5|2\.5|3\.5)$/.test(op.id)) continue;
      const mask = new Uint8Array(J.length);
      let pr = 0;
      J.forEach((r, i) => { if (op.test(r) === true) { mask[i] = 1; pr += r.p; } });
      cands.push({ g: g.key === 'dc' ? '1x2' : g.key, id: op.id, label: `${g.short || g.label}: ${op.label}`, mask, pr });
    }
  }
  const out = [];
  const rec = (start, chosen) => {
    if (chosen.length === size) {
      let c = 0;
      for (let i = 0; i < J.length; i++) { if (chosen.every((x) => x.mask[i])) c += J[i].p; }
      const minLeg = Math.min(...chosen.map((x) => x.pr));
      if (c > maxProb || c >= 0.985 * minLeg || c <= 0) return;
      // redundante se, em algum par, uma seleção já implica a outra (ex.: "mais de 2,5" implica "mais de 1,5")
      for (let a = 0; a < chosen.length; a++) for (let b = a + 1; b < chosen.length; b++) {
        let both = 0;
        for (let i = 0; i < J.length; i++) if (chosen[a].mask[i] && chosen[b].mask[i]) both += J[i].p;
        if (both >= 0.985 * Math.min(chosen[a].pr, chosen[b].pr)) return;
      }
      out.push({ ids: chosen.map((x) => x.id), labels: chosen.map((x) => x.label), prob: c, indep: chosen.reduce((a, x) => a * x.pr, 1) });
      return;
    }
    for (let i = start; i < cands.length; i++) {
      if (chosen.some((x) => x.g === cands[i].g)) continue;
      rec(i + 1, [...chosen, cands[i]]);
    }
  };
  rec(0, []);
  return out.sort((a, b) => b.prob - a.prob).slice(0, top);
}

const API = {
  DEFAULTS, REV, setParams, getParams,
  goalsFrom, sides, isFinished, kickoffTs, formOf, expectedGoals, joint,
  evaluate, toResult, buildPrediction, rescore, confidence, GROUPS, comboProb, comboSuggest,
};
// Node (gerador e testes) e navegador (o site usa o mesmo motor no construtor de aposta)
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof window !== 'undefined') window.Engine = API;
