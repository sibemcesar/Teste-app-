'use strict';
// Gera data/AAAA-MM-DD.json (hoje, 2 dias à frente e 7 dias atrás). Corre no GitHub Actions com o segredo
// SPORTMONKS_API_TOKEN. Regra importante: uma previsão já registada (formato v2) nunca é recalculada.
// Só se atualizam o estado, o resultado e os acertos. Assim o histórico é um registo verdadeiro.
const fs = require('fs');
const path = require('path');
const E = require('../lib/engine');

const DATA = path.join(__dirname, '..', 'data');
const DAY = 86400000;
const iso = (ts) => new Date(ts).toISOString().slice(0, 10);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// Junta o que veio da API com o que já estava guardado
function merge(fresh, old) {
  const oldById = new Map(((old && old.matches) || []).map((m) => [m.id, m]));
  return fresh.matches.map((m) => {
    const o = oldById.get(m.id);
    if (o && o.prediction && o.prediction.v === 2) {
      // previsão já registada: congelada (só se atualizam os acertos)
      m.prediction = E.rescore(o.prediction, E.toResult(m.score, m.ht));
      m.home.form = o.home.form;
      m.away.form = o.away.form;
      m.preGame = !!o.preGame;
    } else {
      // primeira vez que vemos este jogo (ou formato antigo): só conta como "antes do jogo" se ainda não começou
      m.preGame = !!m.prediction && Date.parse(fresh.generatedAt) < Date.parse(m.startingAt);
    }
    return m;
  });
}

const upToDate = (day) => day.matches.every((m) => !m.prediction || m.prediction.v === 2);

async function main() {
  if (!process.env.FOOTBALLDATA_TOKEN && !process.env.SPORTMONKS_API_TOKEN) {
    console.error('Falta um segredo: FOOTBALLDATA_TOKEN (football-data.org) ou SPORTMONKS_API_TOKEN (Sportmonks).');
    process.exit(1);
  }
  console.log('Fonte de dados:', process.env.FOOTBALLDATA_TOKEN ? 'football-data.org' : 'Sportmonks');
  const { buildDay } = require('../lib/day');
  fs.mkdirSync(DATA, { recursive: true });
  const now = Date.now();
  let ok = 0, falhas = 0;

  // i negativo = dias futuros: amanhã (-1) e depois de amanhã (-2). i = 0 é hoje, 1..7 são os dias passados.
  for (let i = -2; i <= 7; i++) {
    const date = iso(now - i * DAY);
    const file = path.join(DATA, date + '.json');
    const old = readJson(file);
    if (i >= 2 && old && upToDate(old)) { ok++; continue; } // dias fechados não se mexem (poupa pedidos à API)
    try {
      const fresh = await buildDay(date);
      fresh.matches = merge(fresh, old);
      if (old && JSON.stringify(old.matches) === JSON.stringify(fresh.matches)) {
        console.log(date, 'sem alterações');
      } else {
        fs.writeFileSync(file, JSON.stringify({ date, generatedAt: fresh.generatedAt, matches: fresh.matches }) + '\n');
        console.log(date, 'atualizado:', fresh.matches.length, 'jogos');
      }
      ok++;
    } catch (e) {
      falhas++;
      console.error(date, 'erro:', e.message);
    }
  }
  if (!ok) process.exit(1); // tudo falhou: o workflow fica vermelho
  if (falhas) console.warn(falhas + ' dia(s) falharam, os outros ficaram atualizados.');
}

if (require.main === module) main();
module.exports = { merge };
