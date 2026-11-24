'use strict';
// Função serverless da Vercel (opcional): GET /api/previsoes?date=YYYY-MM-DD
// No GitHub Pages isto não é usado: quem gera os dados é scripts/gerar.js (GitHub Actions).
const { buildDay } = require('../lib/day');

module.exports = async function handler(req, res) {
  try {
    const date = String((req.query && req.query.date) || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date inválida (YYYY-MM-DD)' });
    const day = await buildDay(date);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(day);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'erro' });
  }
};
