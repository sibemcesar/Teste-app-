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
const REV = 4;
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
      return { id: f.id, home: isHome, ts: kickoffTs(f), gf: isHome ? g.home : g.away, ga: isHome ? g.away : g.home };
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


// ---------- escanteios e cartões ----------
// Três "espaços" de probabilidade independentes: G = golos {h,a,h1,a1}, C = escanteios {x,y}, K = cartões {x,y}.
// Distribuição binomial negativa (variam mais do que a Poisson). x = equipa da casa, y = visitante.
const COUNT = {
  C: { avg: 5.0, disp: 1.35, homeF: 1.06, awayF: 0.94, max: 30 }, // escanteios por equipa
  K: { avg: 2.0, disp: 1.2, homeF: 0.97, awayF: 1.03, max: 16 }, // cartões (amarelos + vermelhos) por equipa
};
const COUNT_GROUPS = [];
function countGroup(space, key, label, lines, total) {
  const options = [];
  for (const l of lines) {
    options.push(o(`${key}:o${l}`, `Mais de ${fmt(l)}`, (f) => total(f) > l, { space }));
    options.push(o(`${key}:u${l}`, `Menos de ${fmt(l)}`, (f) => total(f) < l, { space }));
  }
  COUNT_GROUPS.push({ key, label, options, space });
}
function moreGroup(space, key, label, what) {
  COUNT_GROUPS.push({ key, label, space, options: [
    o(`${key}:1`, `Casa com mais ${what}`, (f) => f.x > f.y, { space }),
    o(`${key}:X`, 'Igual', (f) => f.x === f.y, { space }),
    o(`${key}:2`, `Fora com mais ${what}`, (f) => f.x < f.y, { space }),
  ] });
}
countGroup('C', 'ck', 'Total de escanteios', [7.5, 8.5, 9.5, 10.5, 11.5, 12.5], (f) => f.x + f.y);
countGroup('C', 'cth', 'Escanteios da casa', [3.5, 4.5, 5.5, 6.5], (f) => f.x);
countGroup('C', 'cta', 'Escanteios do visitante', [3.5, 4.5, 5.5, 6.5], (f) => f.y);
moreGroup('C', 'c1', 'Quem tem mais escanteios', 'escanteios');
countGroup('K', 'kt', 'Total de cartões', [2.5, 3.5, 4.5, 5.5, 6.5], (f) => f.x + f.y);
countGroup('K', 'kth', 'Cartões da casa', [0.5, 1.5, 2.5], (f) => f.x);
countGroup('K', 'kta', 'Cartões do visitante', [0.5, 1.5, 2.5], (f) => f.y);
moreGroup('K', 'k1', 'Quem leva mais cartões', 'cartões');

function wavgRows(rows, k) {
  let s = 0, w = 0;
  rows.forEach((r, i) => { const wt = Math.pow(0.85, i); s += r[k] * wt; w += wt; });
  return s / w;
}
// rows = [{ f, a }] (a favor da equipa / contra), mais recente primeiro. Devolve as médias esperadas de cada equipa.
function expectedCount(rowsH, rowsA, space) {
  if (!rowsH || !rowsA || rowsH.length < 3 || rowsA.length < 3) return null;
  const C = COUNT[space], w = 0.75;
  const bh = (wavgRows(rowsH, 'f') + wavgRows(rowsA, 'a')) / 2;
  const ba = (wavgRows(rowsA, 'f') + wavgRows(rowsH, 'a')) / 2;
  return { x: clamp(w * bh * C.homeF + (1 - w) * C.avg, 0.2, C.max / 2), y: clamp(w * ba * C.awayF + (1 - w) * C.avg, 0.2, C.max / 2) };
}
function nbPmf(mean, disp, max) {
  if (disp <= 1.001) return pmf(mean, max);
  const r = mean / (disp - 1), p = 1 / disp, out = [Math.pow(p, r)];
  for (let k = 0; k < max; k++) out.push((out[k] * (k + r) * (1 - p)) / (k + 1));
  return out;
}
function countJoint(lx, ly, space) {
  const C = COUNT[space], A = nbPmf(lx, C.disp, C.max), B = nbPmf(ly, C.disp, C.max), J = [];
  let tot = 0;
  for (let x = 0; x <= C.max; x++) for (let y = 0; y <= C.max; y++) { const p = A[x] * B[y]; J.push({ x, y, p }); tot += p; }
  for (const r of J) r.p /= tot;
  return J;
}

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
const BYID = new Map([...GROUPS, ...COUNT_GROUPS].flatMap((g) => g.options.map((op) => [op.id, op])));

// Compara uma opção com o resultado {h, a, h1, a1}. Devolve true/false, 'void' ou null (sem dados).
function evaluate(id, result) {
  if (!result) return null;
  const op = optionFor(id);
  if (!op) return null;
  if (op.space) { // escanteios / cartões: precisam das estatísticas do jogo
    const v = op.space === 'C' ? result.c : result.k;
    return v ? op.test(v) : null;
  }
  if (op.ht && (result.h1 == null || result.a1 == null)) return null;
  return op.test(result);
}

// {home, away} + {home, away} do intervalo  ->  {h, a, h1, a1}
// extra (opcional) = { c: [casa, fora] escanteios, k: [casa, fora] cartões }
function toResult(score, ht, extra) {
  if (!score) return null;
  const pair = (v) => (Array.isArray(v) && v.length === 2 ? { x: v[0], y: v[1] } : null);
  const r = { h: score.home, a: score.away, h1: ht ? ht.home : null, a1: ht ? ht.away : null };
  if (extra && (extra.c || extra.k)) { r.c = pair(extra.c); r.k = pair(extra.k); }
  return r;
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

// cs (opcional) = { C: { h: [{f,a}], a: [{f,a}] }, K: {...} }: escanteios e cartões recentes de cada equipa
function buildPrediction(formHome, formAway, result, league, xs, cs) {
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
  // escanteios e cartões (só se houver estatísticas suficientes das duas equipas)
  const counts = {};
  for (const sp of ['C', 'K']) {
    const e = cs && cs[sp] && expectedCount(cs[sp].h, cs[sp].a, sp);
    if (!e) continue;
    const Jc = countJoint(e.x, e.y, sp);
    counts[sp] = [Math.round(e.x * 100) / 100, Math.round(e.y * 100) / 100];
    for (const g of COUNT_GROUPS) {
      if (g.space !== sp) continue;
      groups.push({ key: g.key, label: g.label, options: g.options.map((op) => ({ id: op.id, label: op.label, prob: round3(probOf(Jc, op)) })) });
    }
  }

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
  if (counts.C) pred.cx = counts.C;
  if (counts.K) pred.kx = counts.K;
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
// Dentro dos golos respeita as ligações entre mercados (ex.: "mais de 2,5" e "ambas marcam" andam juntos), ao contrário
// de multiplicar probabilidades soltas. Golos, escanteios e cartões são tratados como independentes entre si.
// X = { C: distribuição dos escanteios, K: distribuição dos cartões } (opcional). Seleções anuladas ('void') contam como não acertadas.
function comboProb(J, ids, X) {
  const ops = ids.map(optionFor);
  if (!ops.length || ops.some((x) => !x)) return null;
  const by = { G: [], C: [], K: [] };
  ops.forEach((op) => by[op.space || 'G'].push(op));
  let prob = 1;
  for (const sp of ['G', 'C', 'K']) {
    if (!by[sp].length) continue;
    const JJ = sp === 'G' ? J : X && X[sp];
    if (!JJ) return null;
    let yes = 0;
    for (const r of JJ) if (by[sp].every((op) => op.test(r) === true)) yes += r.p;
    prob *= yes;
  }
  return prob;
}

// Sugestões de combinações, por nível de risco. Usa quase todos os mercados (resultado, total de golos, ambas marcam,
// golos de cada equipa, vitória sem sofrer, margem, 1.ª parte, parte com mais golos, escanteios, cartões), no máximo uma
// seleção por "família" (1X2, dupla hipótese, margem e vitória sem sofrer contam como uma só). Só entram combinações em
// que as seleções se reforçam (probabilidade conjunta acima do produto das separadas) e sem redundâncias (uma seleção
// que já implica a outra). Em cada nível escolhe as que mais se reforçam, evitando repetir sempre as mesmas seleções.
const FAMILY = { '1x2': 'res', dc: 'res', margin: 'res', wtn: 'res', ou: 'ou', btts: 'btts', th: 'th', ta: 'ta', h1x2: 'h1', hou: 'hou', half: 'half',
  ck: 'ck', cth: 'cth', cta: 'cta', c1: 'c1', kt: 'kt', kth: 'kth', kta: 'kta', k1: 'k1' };
const LINES = { ou: /:(o|u)(1\.5|2\.5|3\.5)$/, th: /:(o|u)(0\.5|1\.5)$/, ta: /:(o|u)(0\.5|1\.5)$/, hou: /:(o|u)(0\.5|1\.5)$/,
  ck: /:(o|u)(8\.5|9\.5|10\.5)$/, cth: /:(o|u)(3\.5|4\.5|5\.5)$/, cta: /:(o|u)(3\.5|4\.5|5\.5)$/, kt: /:(o|u)(3\.5|4\.5)$/, kth: /:(o|u)(0\.5|1\.5)$/, kta: /:(o|u)(0\.5|1\.5)$/ };
const BANDS = [
  { key: 'safe', label: 'Mais segura', lo: 0.5, hi: 0.8 },
  { key: 'mid', label: 'Equilibrada', lo: 0.28, hi: 0.5 },
  { key: 'bold', label: 'Mais arriscada', lo: 0.12, hi: 0.28 },
];
function comboSuggest(J0, perBand = 2, X) {
  const SP = { G: J0.filter((r) => r.p > 1e-7) }; // ignora resultados de probabilidade desprezável (mais rápido)
  if (X && X.C) SP.C = X.C.filter((r) => r.p > 1e-7);
  if (X && X.K) SP.K = X.K.filter((r) => r.p > 1e-7);
  const cands = [];
  for (const g of [...GROUPS, ...COUNT_GROUPS]) {
    const fam = FAMILY[g.key], sp = g.space || 'G', JJ = SP[sp];
    if (!fam || !JJ) continue;
    for (const op of g.options) {
      if (LINES[g.key] && !LINES[g.key].test(op.id)) continue;
      const mask = new Uint8Array(JJ.length);
      let pr = 0;
      for (let i = 0; i < JJ.length; i++) if (op.test(JJ[i]) === true) { mask[i] = 1; pr += JJ[i].p; }
      if (pr < 0.25 || pr > 0.85) continue; // só seleções realmente incertas (nem quase impossíveis nem quase certas)
      cands.push({ fam, sp, id: op.id, label: `${g.short || g.label}: ${op.label}`, mask, pr });
    }
  }
  // probabilidade conjunta dentro de um espaço
  const conj = (xs, sp) => {
    const JJ = SP[sp];
    let c = 0;
    for (let i = 0; i < JJ.length; i++) { let ok = 1; for (const x of xs) if (!x.mask[i]) { ok = 0; break; } if (ok) c += JJ[i].p; }
    return c;
  };
  const all = [];
  const consider = (chosen) => {
    const sps = [...new Set(chosen.map((x) => x.sp))];
    let c = 1;
    for (const sp of sps) c *= conj(chosen.filter((x) => x.sp === sp), sp);
    if (c < 0.12 || c > 0.8) return;
    if (c >= 0.985 * Math.min(...chosen.map((x) => x.pr))) return; // uma seleção já implica as outras
    const indep = chosen.reduce((a, x) => a * x.pr, 1);
    if (c < indep * 1.05) return; // só seleções que se reforçam
    for (let a = 0; a < chosen.length; a++) for (let b = a + 1; b < chosen.length; b++) {
      if (chosen[a].sp !== chosen[b].sp) continue; // espaços diferentes são independentes
      const JJ = SP[chosen[a].sp];
      let both = 0;
      for (let i = 0; i < JJ.length; i++) if (chosen[a].mask[i] && chosen[b].mask[i]) both += JJ[i].p;
      if (both >= 0.985 * Math.min(chosen[a].pr, chosen[b].pr)) return; // par redundante
    }
    all.push({ ids: chosen.map((x) => x.id), labels: chosen.map((x) => x.label), prob: c, indep, lift: c / indep, onlyCounts: chosen.every((x) => x.sp !== 'G') });
  };
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    if (cands[i].fam === cands[j].fam) continue;
    consider([cands[i], cands[j]]);
    for (let k = j + 1; k < cands.length; k++) {
      if (cands[k].fam === cands[i].fam || cands[k].fam === cands[j].fam) continue;
      consider([cands[i], cands[j], cands[k]]);
    }
  }
  all.sort((a, b) => b.lift - a.lift || b.prob - a.prob); // as que mais se reforçam primeiro
  const used = new Map(), out = [];
  for (const band of BANDS) {
    let n = 0;
    for (const c of all) {
      if (n >= perBand) break;
      if (c.prob < band.lo || c.prob >= band.hi) continue;
      if (c.ids.some((id) => (used.get(id) || 0) >= 2)) continue; // variedade: nenhuma seleção em mais de 2 sugestões
      c.ids.forEach((id) => used.set(id, (used.get(id) || 0) + 1));
      out.push({ band: band.key, bandLabel: band.label, ...c });
      n++;
    }
  }
  // grupo à parte: só escanteios e cartões
  let n = 0;
  for (const c of all) {
    if (n >= perBand) break;
    if (!c.onlyCounts || c.ids.length !== 2 || c.prob < 0.2 || c.prob >= 0.7) continue;
    if (c.ids.some((id) => (used.get(id) || 0) >= 2)) continue;
    c.ids.forEach((id) => used.set(id, (used.get(id) || 0) + 1));
    out.push({ band: 'cnt', bandLabel: 'Escanteios e cartões', ...c });
    n++;
  }
  return out;
}

const API = {
  DEFAULTS, REV, setParams, getParams,
  goalsFrom, sides, isFinished, kickoffTs, formOf, expectedGoals, joint,
  evaluate, toResult, buildPrediction, rescore, confidence, GROUPS, COUNT_GROUPS, countJoint, comboProb, comboSuggest,
};
// Node (gerador e testes) e navegador (o site usa o mesmo motor no construtor de aposta)
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof window !== 'undefined') window.Engine = API;
