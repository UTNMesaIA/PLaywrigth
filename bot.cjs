// bot.cjs
require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json()); // ← necesario para body JSON en /compra

// Salud
app.get('/health', (_req, res) => res.json({ ok: true, step: 'READY', scope: ['consulta','compra'] }));

// Routers
app.use('/consulta', require('./consulta.cjs'));
app.use('/compra',   require('./compra.cjs'));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en :${PORT} (CommonJS)`);
});
