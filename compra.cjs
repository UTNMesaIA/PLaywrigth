// compra.cjs
const express = require('express');
const {
  TIMEOUTS,
  SEL,
  newContextWithState, ensureLoggedIn,
  searchByQuery, rowForCode, readBAInRow,
} = require('./login.cjs');

const router = express.Router();

// Espera body JSON: { codigo: string, cantidad: number, observaciones?: string, force?: boolean }
// - Si BA no está verde, por defecto devuelve 409 (a menos que force=true).
router.post('/', async (req, res) => {
  const { codigo, cantidad, observaciones = 'urg', force = false } = req.body || {};
  if (!codigo || !Number.isFinite(cantidad) || cantidad <= 0) {
    return res.status(400).json({ ok: false, step: 'INVALID_INPUT', message: 'Se requiere { codigo, cantidad>0 }' });
  }

  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);

    // 1) Buscar el producto
    await searchByQuery(page, codigo);
    const row = rowForCode(page, codigo);
    if (await row.count() === 0) throw new Error(`No encontré una fila que contenga "${codigo}"`);
    const row0 = row.first();

    // 2) Validar BA (verde) salvo que se fuerce
    const ba = await readBAInRow(row0);
    if (!ba.isGreen && !force) {
      await page.close();
      return res.status(409).json({
        ok: false,
        step: 'BA_NOT_GREEN',
        codigo,
        message: 'El semáforo BA no está en verde; use "force": true para intentar igual.',
        ba
      });
    }

    // 3) Cargar cantidad en el input de esa fila
    const qtyInput = row0.locator(SEL.qtyInput).first();
    if (await qtyInput.count() === 0) throw new Error('No encontré el input de cantidad');
    await qtyInput.fill('');
    await qtyInput.type(String(cantidad), { delay: 10 });

    // 4) Ir al carrito y abrir el modal de envío de pedido
    await page.waitForTimeout(1500);
    await page.goto('/cart', { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });
    await page.waitForSelector(SEL.btnEnviarPedido, { timeout: TIMEOUTS.nav });
    await page.click(SEL.btnEnviarPedido, { timeout: TIMEOUTS.action });

    // 5) Completar observaciones y Confirmar
    await page.waitForSelector(SEL.obsTextarea, { timeout: TIMEOUTS.nav });
    await page.fill(SEL.obsTextarea, String(observaciones).slice(0, 240));

    // Intentamos capturar la respuesta del POST
    const [resp] = await Promise.all([
      page.waitForResponse(
        r => r.request().method() === 'POST' && /pedido|order|checkout/i.test(r.url()),
        { timeout: 15000 }
      ).catch(() => null),
      page.click(SEL.btnConfirmar, { timeout: TIMEOUTS.action }),
    ]);

    let pedidoId = null;
    if (resp) {
      try { pedidoId = (await resp.json())?.id ?? null; } catch {}
    }

    await page.waitForTimeout(500);
    await page.close();

    return res.json({
      ok: true,
      step: 'ORDER_OK',
      codigo,
      qty: cantidad,
      pedidoId,
      forced: !!force
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      step: 'ORDER_FAIL',
      codigo,
      message: err?.message || 'Error'
    });
  } finally {
    if (context) await context.close();
  }
});

module.exports = router;
