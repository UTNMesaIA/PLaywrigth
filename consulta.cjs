// consulta.cjs
const express = require('express');
const {
  TIMEOUTS, DEFAULT_MAX_CONFIRM_MS,
  SEL,
  newContextWithState, ensureLoggedIn,
  searchByQuery, rowForCode, readBAInRow,
  clickBAConsult, openConfirmationsPanel, readConfirmationsOnce,
} = require('./login.cjs');

const router = express.Router();

// ---- GET /consulta/:codigo → BA (debug) ----
router.get('/:codigo', async (req, res) => {
  const { codigo } = req.params;
  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);
    await searchByQuery(page, codigo);

    const row = rowForCode(page, codigo);
    if (await row.count() === 0) throw new Error(`No encontré una fila que contenga "${codigo}"`);
    const ba = await readBAInRow(row.first());

    await page.close();
    res.json({ ok: true, step: 'SEARCH_OK', codigo, ba });
  } catch (err) {
    res.status(500).json({ ok: false, step: 'SEARCH_FAIL', codigo, message: err?.message || 'Error' });
  } finally {
    if (context) await context.close();
  }
});

// ---- GET /consulta/:codigo/stock-confirm → verde / C (panel) / rojo ----
// Soporta ?min (cantidad mínima) y ?maxWait (segundos; default 3h).
router.get('/:codigo/stock-confirm', async (req, res) => {
  const { codigo } = req.params;
  const min = req.query.min !== undefined ? Number(req.query.min) : null;
  const maxWaitSec = req.query.maxWait !== undefined ? Number(req.query.maxWait) : null;
  const MAX_CONFIRM_MS = (Number.isFinite(maxWaitSec) && maxWaitSec > 0)
    ? maxWaitSec * 1000
    : DEFAULT_MAX_CONFIRM_MS;

  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);

    // 1) Buscar y ubicar fila del producto
    await searchByQuery(page, codigo);
    const row = rowForCode(page, codigo);
    if (await row.count() === 0) throw new Error(`No encontré una fila que contenga "${codigo}"`);
    const row0 = row.first();

    // Helper para responder agregando el boolean 'stock'
    const send = (payload) => {
      const availableNum = typeof payload.available === 'number' ? payload.available : null;

      let stockBool = false;
      if (payload.mode === 'immediate-green') {
        stockBool = (availableNum === null) ? false : availableNum > 0;
      } else if (payload.mode === 'confirmation-panel') {
        stockBool = (availableNum || 0) > 0;
      } else if (payload.mode === 'unavailable') {
        stockBool = false;
      }

      const out = { ok: true, step: 'CONFIRM_STOCK_OK', codigo, stock: stockBool, ...payload };
      if (min !== null) {
        out.enough = availableNum !== null ? availableNum >= min : false;
        out.min = min;
      }
      return res.json(out);
    };

    // 2) Leer BA actual
    const ba = await readBAInRow(row0);

    // 2.a) Verde → devolver número visible (si el texto trae dígitos)
    if (ba.isGreen) {
      const available = (typeof ba.numero === 'number') ? ba.numero : null;
      await page.close();
      return send({ mode: 'immediate-green', available, ba });
    }

    // 2.b) "C" → abrir panel, buscar; si no está, click en "C" y poll hasta MAX_CONFIRM_MS
    if (ba.isConsult) {
      await openConfirmationsPanel(page);
      let found = await readConfirmationsOnce(page, codigo);

      if (!found) {
        await clickBAConsult(row0);
        await openConfirmationsPanel(page);

        const deadline = Date.now() + MAX_CONFIRM_MS;
        while (!found && Date.now() < deadline) {
          found = await readConfirmationsOnce(page, codigo);
          if (found) break;
          await page.waitForTimeout(10000); // cada 10s
          const hasTable = await page.locator(SEL.confirmTableBody).count();
          if (!hasTable) await openConfirmationsPanel(page);
        }
      }

      await page.close();

      if (!found) {
        const out = {
          ok: false,
          step: 'CONFIRM_STOCK_TIMEOUT',
          codigo,
          message: `No llegó confirmación (${Math.round(MAX_CONFIRM_MS/1000)}s).`
        };
        if (min !== null) out.min = min;
        return res.status(408).json(out);
      }

      return send({ mode: 'confirmation-panel', available: found.qty ?? null, rowText: found.rowText });
    }

    // 2.c) Rojo u otro → available = 0
    await page.close();
    return send({ mode: 'unavailable', available: 0, ba });

  } catch (err) {
    const out = { ok: false, step: 'CONFIRM_STOCK_FAIL', codigo, message: err?.message || 'Error' };
    if (req.query.min !== undefined) out.min = Number(req.query.min);
    if (req.query.maxWait !== undefined) out.maxWait = Number(req.query.maxWait);
    res.status(500).json(out);
  } finally {
    if (context) await context.close();
  }
});

module.exports = router;
