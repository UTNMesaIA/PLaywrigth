// bot.cjs — LOGIN + SEARCH (?searchText) + STOCK(BA) + CONFIRMACIONES "C" + COMPRA
// Respuestas clave:
//  - /consulta/:codigo           → { ok, step:"SEARCH_OK", ba:{ bg, text, numero, isGreen, isConsult } }
//  - /consulta/:codigo/stock-confirm?min&maxWait
//      → { ok, step:"CONFIRM_STOCK_OK", mode:"immediate-green"|"confirmation-panel"|"unavailable", available, stock, enough? }
//  - POST /compra  → { ok, step:"ORDER_CONFIRMED", codigo, cantidad, pedidoId|null } o errores con step

require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
app.use(express.json());

// ---- Config (.env) ----
const BASE     = process.env.DISTRISUPER_URL || 'https://lupa.distrisuper.com';
const USER     = process.env.DISTRISUPER_USER || '';
const PASS     = process.env.DISTRISUPER_PASS || '';
const HEADLESS = process.env.PW_HEADLESS !== 'false'; // true por defecto
const PORT     = process.env.PORT || 3000;

const TIMEOUTS = { nav: 35000, action: 30000 };
const DEFAULT_MAX_CONFIRM_MS = 3 * 60 * 60 * 1000; // 3h

// Selectores (mismos que venías usando + botones de compra)
const SEL = {
  // Login / home
  loginUser: '#client_code',
  loginPass: '#client_password',
  loginBtn:  'button.tp-login-btn:has-text("Iniciar Sesión")',
  buscador:  'input[placeholder="Buscá tu repuesto..."]',

  // Dentro de cada fila/card de producto:
  stockBar:  'div.d-flex.w-100.justify-content-center.align-items-center', // barra con 4 semáforos
  qtyInput:  'input[type="number"].text-center',

  // Panel de confirmaciones
  confirmBanner: 'text=Tenés confirmaciones de stock',
  confirmTableBody: 'div.table-responsive table tbody',
  confirmCodeCell: 'td.fw-bold', // primera columna "Código"

  // Carrito / compra
  btnEnviarPedido: 'button.btn.btn-dark:has-text("Enviar el pedido")',
  obsTextarea: '#observaciones',
  btnConfirmar: 'button.btn.btn-primary:has-text("Confirmar")',
};

const AUTH_DIR  = path.join(process.cwd(), 'playwright', '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'state.json');
fs.mkdirSync(AUTH_DIR, { recursive: true });

// ---- Browser bootstrap (reutilizable) ----
let browser;
async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: HEADLESS });
  return browser;
}
async function newContextWithState() {
  const br = await getBrowser();
  const hasState = fs.existsSync(AUTH_FILE);
  return hasState ? br.newContext({ storageState: AUTH_FILE }) : br.newContext();
}

// ---- Helpers de login y navegación ----
async function doLogin(page) {
  if (!USER || !PASS) throw new Error('Faltan DISTRISUPER_USER / DISTRISUPER_PASS en .env');
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });
  await page.fill(SEL.loginUser, USER, { timeout: TIMEOUTS.action });
  await page.fill(SEL.loginPass, PASS, { timeout: TIMEOUTS.action });
  await Promise.all([
    page.click(SEL.loginBtn, { timeout: TIMEOUTS.action }),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(() => {})
  ]);
  await page.waitForSelector(SEL.buscador, { timeout: TIMEOUTS.nav });
}
async function ensureLoggedIn(context) {
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});
    const ok = await page.$(SEL.buscador);
    if (ok) return page;
    await doLogin(page);
    await context.storageState({ path: AUTH_FILE });
    return page;
  } catch (e) {
    await page.close().catch(()=>{});
    throw e;
  }
}

// Buscar directo por query param ?searchText= (evita tipear y ambigüedades)
async function searchByQuery(page, codigo) {
  await page.goto(`${BASE}/?searchText=${encodeURIComponent(String(codigo))}`, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUTS.nav
  });
  // En tu entorno esto funciona; si el sitio cambia, cambiar por una espera basada en texto del código.
  await page.waitForSelector(SEL.stockBar, { timeout: TIMEOUTS.nav });
}

/** Fila/card que contiene el texto del código (sube al contenedor con barra de stock e input de cantidad) */
function rowForCode(page, codigo) {
  const codeText = String(codigo).trim();
  const xpath = 'xpath=ancestor-or-self::div[' +
    './/div[contains(@class,"justify-content-center") and contains(@class,"align-items-center")]' + // stockBar
    ' and .//input[@type="number" and contains(@class,"text-center")]' + // qtyInput
    '][1]';
  return page.locator(`:text("${codeText}")`).locator(xpath);
}

// ---- Stock helpers ----
const GREEN_BA_RE  = /25,\s*135,\s*84/;   // rgb(25,135,84) = verde
const YELLOW_BA_RE = /212,\s*175,\s*55/;  // rgb(212,175,55) = "C" (amarillo)

/** Lee el 3er semáforo (BA) dentro de una fila: { bg, text, numero, isGreen, isConsult } */
async function readBAInRow(row) {
  const bar = row.locator(SEL.stockBar).first();
  await bar.waitFor({ state: 'visible', timeout: TIMEOUTS.nav });

  const baInfo = await bar.evaluate((el) => {
    const kids = el.querySelectorAll(':scope > div');
    if (kids.length < 3) return null;
    const ba = kids[2]; // BA = tercer semáforo
    const bg = getComputedStyle(ba).backgroundColor;
    const text = (ba.textContent || '').trim(); // "C", "NO", "+9", "7", etc.
    return { bg, text };
  });
  if (!baInfo) throw new Error('No encontré el semáforo BA en la fila');

  let numero = null;
  const m = baInfo.text.match(/\d+/);
  if (m) numero = parseInt(m[0], 10);

  const isGreen   = GREEN_BA_RE.test(baInfo.bg);
  const isConsult = baInfo.text.toUpperCase() === 'C' || YELLOW_BA_RE.test(baInfo.bg);

  return { ...baInfo, numero, isGreen, isConsult };
}

/** Click en el “C” (BA) dentro de la fila */
async function clickBAConsult(row) {
  const bar = row.locator(SEL.stockBar).first();
  const ba = bar.locator(':scope > div').nth(2);
  await ba.click({ trial: false });
}

/** Abre el panel “Tenés confirmaciones de stock” si existe. */
async function openConfirmationsPanel(page) {
  const banner = page.locator(SEL.confirmBanner);
  if (await banner.count() > 0) {
    await banner.first().click().catch(()=>{});
    await page.waitForSelector(SEL.confirmTableBody, { timeout: TIMEOUTS.nav }).catch(()=>{});
    return true;
  }
  return false;
}

/** Lee el panel de confirmaciones una vez y devuelve {qty,rowText} si encuentra el código (Cant = 2do td). */
async function readConfirmationsOnce(page, codigo) {
  return await page.evaluate((codeUpper) => {
    const tbody = document.querySelector('div.table-responsive table tbody');
    if (!tbody) return null;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    for (const tr of rows) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 2) continue;
      const codeCell = (tds[0].textContent || '').trim().toUpperCase();
      if (codeCell === codeUpper) {
        const cantRaw = (tds[1].textContent || '').trim(); // 2do td = Cant
        const m = cantRaw.match(/\d+/);
        const qty = m ? parseInt(m[0], 10) : null;
        return { qty, rowText: tr.innerText };
      }
    }
    return null;
  }, String(codigo).trim().toUpperCase());
}

// ---- Helpers de compra ----
async function setQuantityInRow(row, cantidad) {
  const input = row.locator(SEL.qtyInput).first();
  await input.waitFor({ state: 'visible', timeout: TIMEOUTS.action });
  await input.fill('');
  await input.type(String(cantidad));
  // a veces necesitan blur/enter para registrar
  try { await input.press('Enter'); } catch {}
}

// ---- Endpoints ----
app.get('/health', (_req, res) => res.json({ ok: true, step: 'READY' }));

// Buscar y devolver BA del match real (útil para debug / monitoreo rápido)
app.get('/consulta/:codigo', async (req, res) => {
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

// Confirmación de stock (verde inmediato / "C" con panel / rojo).
// Soporta ?min (cantidad mínima) y ?maxWait (segundos; default 3h).
app.get('/consulta/:codigo/stock-confirm', async (req, res) => {
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

    // Helper para responder agregando boolean 'stock'
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

// -------- COMPRA --------
// Body JSON: { codigo: string, cantidad: number, observaciones?: string, force?: boolean }
app.post('/compra', async (req, res) => {
  const { codigo, cantidad, observaciones = 'urg', force = false } = req.body || {};
  if (!codigo || !Number.isFinite(cantidad) || cantidad <= 0) {
    return res.status(400).json({ ok: false, step: 'BAD_REQUEST', message: 'Body esperado: { codigo, cantidad, observaciones?, force? }' });
  }

  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);

    // 1) Buscar producto y ubicar fila
    await searchByQuery(page, codigo);
    const row = rowForCode(page, codigo);
    if (await row.count() === 0) throw new Error(`No encontré una fila que contenga "${codigo}"`);
    const row0 = row.first();

    // 2) BA debe estar verde (a menos que force=true)
    const ba = await readBAInRow(row0);
    if (!ba.isGreen && !force) {
      await page.close();
      return res.status(409).json({ ok: false, step: 'BA_NOT_GREEN', codigo, ba, message: 'BA no está verde; pase force=true para forzar' });
    }

    // 3) Setear cantidad en la misma fila del producto
    await setQuantityInRow(row0, cantidad);
    await page.waitForTimeout(500);

    // 4) Ir al carrito y confirmar
    await page.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });
    await page.waitForSelector(SEL.btnEnviarPedido, { timeout: TIMEOUTS.action });
    await page.click(SEL.btnEnviarPedido);

    await page.waitForSelector(SEL.obsTextarea, { timeout: TIMEOUTS.action });
    await page.fill(SEL.obsTextarea, String(observaciones || ''));

    // Capturar la respuesta del POST de confirmación (si es posible)
    const [resp] = await Promise.all([
      page.waitForResponse(
        r => r.request().method() === 'POST' && /pedido|order|checkout/i.test(r.url()),
        { timeout: 15000 }
      ).catch(() => null),
      page.click(SEL.btnConfirmar),
    ]);

    let pedidoId = null;
    if (resp) { try { pedidoId = (await resp.json())?.id ?? null; } catch {} }

    await page.close();
    return res.json({ ok: true, step: 'ORDER_CONFIRMED', codigo, cantidad, pedidoId, baAtBuy: ba });

  } catch (err) {
    return res.status(500).json({ ok: false, step: 'ORDER_FAIL', codigo, message: err?.message || 'Error' });
  } finally {
    if (context) await context.close();
  }
});

// Start
app.listen(PORT, () => {
  console.log(`✅ bot.cjs escuchando en :${PORT} — consulta, confirmaciones y compra listo (CommonJS)`);
});
