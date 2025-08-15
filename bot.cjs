// bot.cjs — LOGIN + SEARCH (?searchText) + STOCK(BA) + CONFIRMACIONES "C" (banner flotante) + ADD TO CART + CART CONFIRM

require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const app = express();

// ---- Config (.env) ----
const BASE     = process.env.DISTRISUPER_URL || 'https://lupa.distrisuper.com';
const USER     = process.env.DISTRISUPER_USER || '';
const PASS     = process.env.DISTRISUPER_PASS || '';
const HEADLESS = process.env.PW_HEADLESS !== 'false'; // true por defecto
const PORT     = process.env.PORT || 3000;

const TIMEOUTS = { nav: 60000, action: 45000 };

// Selectores
const SEL = {
  loginUser: '#client_code',
  loginPass: '#client_password',
  loginBtn:  'button.tp-login-btn:has-text("Iniciar Sesión")',
  buscador:  'input[placeholder="Buscá tu repuesto..."]',
  stockBar:  'div.d-flex.w-100.justify-content-center.align-items-center',
  qtyInput:  'input[type="number"].text-center'
};

const AUTH_DIR  = path.join(process.cwd(), 'playwright', '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'state.json');
fs.mkdirSync(AUTH_DIR, { recursive: true });

// ---- Browser bootstrap (reutilizable) ----
let browser;
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
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

  // Aseguramos que realmente salimos del login
  await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});
  if ((page.url() || '').includes('/login')) {
    throw new Error('Login falló: seguimos en /login (revisá DISTRISUPER_USER/PASS en Railway).');
  }
  await page.waitForSelector(SEL.buscador, { timeout: TIMEOUTS.nav });
}
async function ensureLoggedIn(context) {
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});

    if ((page.url() || '').includes('/login') || !(await page.$(SEL.buscador))) {
      await doLogin(page);
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});
      await page.waitForSelector(SEL.buscador, { timeout: TIMEOUTS.nav });
    }

    await context.storageState({ path: AUTH_FILE });
    return page;
  } catch (e) {
    await page.close().catch(()=>{});
    throw e;
  }
}

// Buscar directo por query param ?searchText= (evita tipear y ambigüedades)
async function searchByQuery(page, codigo) {
  const url = `${BASE}/?searchText=${encodeURIComponent(String(codigo))}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });

  // Si redirigió a /login, re-logueamos y reintentamos 1 vez
  if ((page.url() || '').includes('/login')) {
    await doLogin(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });
  }

  await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});
  await page.waitForTimeout(1000).catch(()=>{});

  const ok = await Promise.race([
    page.waitForSelector(SEL.stockBar, { timeout: TIMEOUTS.nav }).then(()=>true).catch(()=>false),
    page.waitForSelector(`:text("${String(codigo).trim()}")`, { timeout: TIMEOUTS.nav }).then(()=>true).catch(()=>false),
    page.waitForSelector(SEL.buscador, { timeout: TIMEOUTS.nav }).then(()=>true).catch(()=>false)
  ]);

  if (!ok) {
    const dbgUrl = page.url();
    try { await page.screenshot({ path: `debug-search-${Date.now()}.png`, fullPage: true }); } catch {}
    throw new Error(`No se renderizó el listado para ${codigo}. URL actual: ${dbgUrl}`);
  }
}

/** Fila/card que contiene el texto del código */
function rowForCode(page, codigo) {
  const codeText = String(codigo).trim();
  const xpath = 'xpath=ancestor-or-self::div[' +
    './/div[contains(@class,"justify-content-center") and contains(@class,"align-items-center")]' +
    ' and .//input[@type="number" and contains(@class,"text-center")]' +
    '][1]';
  return page.locator(`:text("${codeText}")`).locator(xpath);
}

// ---- Stock helpers ----
const GREEN_BA_RE  = /25,\s*135,\s*84/;
const YELLOW_BA_RE = /212,\s*175,\s*55/;

async function readBAInRow(row) {
  const bar = row.locator(SEL.stockBar).first();
  await bar.waitFor({ state: 'visible', timeout: TIMEOUTS.nav });

  const baInfo = await bar.evaluate((el) => {
    const kids = el.querySelectorAll(':scope > div');
    if (kids.length < 3) return null;
    const ba = kids[2];
    const bg = getComputedStyle(ba).backgroundColor;
    const text = (ba.textContent || '').trim();
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

async function clickBAConsult(row) {
  const bar = row.locator(SEL.stockBar).first();
  const ba = bar.locator(':scope > div').nth(2);
  await ba.click({ trial: false });
}

async function setQtyInRow(row, qty) {
  const input = row.locator(SEL.qtyInput).first();
  await input.waitFor({ state: 'visible', timeout: TIMEOUTS.nav });
  await input.click({ clickCount: 3 }).catch(()=>{});
  await input.fill('');
  await input.type(String(qty));
  await input.press('Tab').catch(()=>{});
  await row.page().waitForTimeout(200).catch(()=>{});
  const finalValue = await input.inputValue().catch(() => null);
  return { finalValue };
}

// ---------------- Confirmaciones: banner flotante moderno ----------------
const SEL_CONFIRM_FLOAT = {
  bannerText: 'text=Tenés confirmaciones de stock',
  modalContainer: 'div.bg-white.text-black',
  tableBody: 'div.bg-white.text-black .table-responsive table tbody'
};

async function openFloatingConfirmations(page) {
  await page.waitForTimeout(5000).catch(() => {});
  const deadline = Date.now() + 20000;
  const findBanner = () => page.locator(SEL_CONFIRM_FLOAT.bannerText).first();

  while (Date.now() < deadline) {
    const t = findBanner();
    if (await t.count()) {
      const clickable = t.locator('xpath=ancestor-or-self::div[contains(@class,"position-fixed") and contains(@class,"cursor-pointer")][1]');
      try {
        if (await clickable.count()) await clickable.click({ timeout: 2000 });
        else await t.click({ timeout: 2000 });
      } catch {
        await page.evaluate((selector) => {
          const el = document.querySelector(selector) || Array.from(document.querySelectorAll('*')).find(n => (n.textContent||'').includes('Tenés confirmaciones de stock'));
          if (el) el.click();
        }, SEL_CONFIRM_FLOAT.bannerText);
      }
      await page.waitForSelector(`${SEL_CONFIRM_FLOAT.modalContainer}, ${SEL_CONFIRM_FLOAT.tableBody}`, { timeout: 5000 }).catch(() => {});
      if (await page.locator(SEL_CONFIRM_FLOAT.tableBody).count()) return true;
      if (await page.locator(SEL_CONFIRM_FLOAT.modalContainer).count()) return true;
    }
    await page.waitForTimeout(1000).catch(() => {});
  }
  return false;
}

async function readFloatingConfirmations(page, codigo) {
  const args = { codeUpper: String(codigo).trim().toUpperCase(), selTbody: SEL_CONFIRM_FLOAT.tableBody };
  return await page.evaluate(({ codeUpper, selTbody }) => {
    const tbody = document.querySelector(selTbody);
    if (!tbody) return null;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const matches = [];
    for (const tr of rows) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 4) continue;
      const codeCell = (tds[0].textContent || '').trim().toUpperCase();
      const cantRaw  = (tds[1].textContent || '').trim();
      const sucCell  = (tds[2].textContent || '').trim().toUpperCase();
      const fechaRaw = (tds[3].textContent || '').trim();
      if (codeCell === codeUpper && sucCell === 'BA') {
        const m = cantRaw.match(/\d+/);
        const qty = m ? parseInt(m[0], 10) : 0;
        matches.push({ codigo: codeCell, qty, suc: sucCell, fecha: fechaRaw, rowText: tr.innerText });
      }
    }
    return matches;
  }, args);
}

// ---- Endpoints ----
app.get('/health', (_req, res) => res.json({ ok: true, step: 'READY' }));

// Buscar y devolver BA (debug)
app.get('/DISTRISUPER/:codigo', async (req, res) => {
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

// Stock-check
async function stockCheckFastHandler(req, res) {
  const { codigo } = req.params;
  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);
    await searchByQuery(page, codigo);
    const row0 = rowForCode(page, codigo).first();
    if (await row0.count() === 0) throw new Error(`No encontré una fila que contenga "${codigo}"`);
    const ba = await readBAInRow(row0);

    if (ba.isConsult) {
      await clickBAConsult(row0);
      await page.waitForTimeout(5000).catch(()=>{});
      await page.close();
      return res.json({ ok: true, step: 'CONSULTED_DUE_TO_YELLOW', codigo, mode: 'consult-clicked', consulted: true,
        message: 'Semáforo amarillo con "C". Se hizo click para consultar y se terminó la ejecución.' });
    }

    if (ba.isGreen) {
      const available = (typeof ba.numero === 'number') ? ba.numero : null;
      await page.close();
      return res.json({ ok: true, step: 'GREEN_STOCK', codigo, mode: 'immediate-green',
        stock: available !== null ? available > 0 : false, available, ba });
    }

    await page.close();
    return res.json({ ok: true, step: 'NO_STOCK_RED', codigo, mode: 'unavailable', stock: false, available: 0, ba });

  } catch (err) {
    res.status(500).json({ ok: false, step: 'STOCK_CHECK_FAST_FAIL', codigo, message: err?.message || 'Error' });
  } finally {
    if (context) await context.close();
  }
}
app.get('/DISTRISUPER/:codigo/stock-check-fast', stockCheckFastHandler);

// Confirmaciones (banner flotante)
app.get('/DISTRISUPER/:codigo/confirmations-check', async (req, res) => {
  const { codigo } = req.params;
  const min = req.query.min !== undefined ? Number(req.query.min) : null;
  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});
    await page.waitForTimeout(1500).catch(()=>{});
    let opened = await openFloatingConfirmations(page);
    if (!opened) {
      await searchByQuery(page, ' ');
      opened = await openFloatingConfirmations(page);
    }

    if (!opened) {
      await page.close();
      const out = { ok: true, step: 'NO_CONFIRM_BANNER', codigo, hasConfirmations: false,
        message: 'No se encontró el banner de "Tenés confirmaciones de stock".' };
      if (min !== null) out.min = min;
      return res.json(out);
    }

    await page.waitForTimeout(500).catch(()=>{});
    const matches = await readFloatingConfirmations(page, codigo);
    await page.close();

    if (!matches || matches.length === 0) {
      const out = { ok: true, step: 'CONFIRM_MODAL_EMPTY_FOR_CODE', codigo, hasConfirmations: true, results: [],
        message: 'Se abrió el modal, pero no hay filas para ese código con Suc=BA.' };
      if (min !== null) out.min = min;
      return res.json(out);
    }

    let bestQty = 0;
    for (const r of matches) bestQty = Math.max(bestQty, r.qty);
    const out = { ok: true, step: 'CONFIRM_MODAL_RESULTS', codigo, hasConfirmations: true, results: matches };
    if (min !== null) { out.min = min; out.available = bestQty; out.enough = bestQty >= min; }
    return res.json(out);

  } catch (err) {
    const out = { ok: false, step: 'CONFIRMATIONS_CHECK_FAIL', codigo, message: err?.message || 'Error' };
    if (req.query.min !== undefined) out.min = Number(req.query.min);
    res.status(500).json(out);
  } finally {
    if (context) await context.close();
  }
});

// ADD TO CART
async function addToCartHandler(req, res) {
  const { codigo } = req.params;
  const qty = Number(req.query.qty);
  const requireGreen = ['1', 'true', 'yes'].includes(String(req.query.requireGreen || '').toLowerCase());

  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ ok: false, step: 'ADD_TO_CART_INVALID_QTY', codigo, message: 'Falta ?qty= (número > 0).' });
  }

  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);

    await searchByQuery(page, codigo);
    const row0 = rowForCode(page, codigo).first();
    if (await row0.count() === 0) throw new Error(`No encontré una fila que contenga "${codigo}"`);

    let ba = await readBAInRow(row0);
    if (requireGreen && !ba.isGreen) {
      await page.close();
      return res.status(409).json({ ok: false, step: 'BA_NOT_GREEN', codigo, required: 'green', ba,
        message: 'El semáforo BA no está en verde y requireGreen=1.' });
    }

    const { finalValue } = await setQtyInRow(row0, qty);
    await page.waitForTimeout(10000).catch(()=>{});
    ba = await readBAInRow(row0).catch(() => ba);

    await page.close();
    return res.json({ ok: true, step: 'QTY_SET_OK', codigo, qtyRequested: qty,
      qtyInputValue: finalValue !== null ? Number(finalValue) : null, waitedMs: 10000, ba,
      message: 'Cantidad cargada en el input del producto (espera de 10s aplicada).' });

  } catch (err) {
    return res.status(500).json({ ok: false, step: 'ADD_TO_CART_FAIL', codigo, message: err?.message || 'Error' });
  } finally {
    if (context) await context.close();
  }
}
app.post('/DISTRISUPER/:codigo/add-to-cart', addToCartHandler);
app.get('/DISTRISUPER/:codigo/add-to-cart', addToCartHandler);

// Alias deprecado
app.get('/DISTRISUPER/:codigo/stock-confirm', stockCheckFastHandler);

// CART CONFIRM
app.post('/DISTRISUPER/cart-confirm', async (req, res) => {
  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);

    await page.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });
    await page.waitForSelector('button.btn.btn.dark, button.btn.btn-dark:has-text("Enviar el pedido")', { timeout: TIMEOUTS.action }).catch(()=>{});
    await page.click('button.btn.btn-dark:has-text("Enviar el pedido")');

    await page.waitForSelector('#observaciones', { timeout: TIMEOUTS.action });
    await page.fill('#observaciones', 'urg');

    const [resp] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'POST' && /pedido|order|checkout/i.test(r.url()), { timeout: TIMEOUTS.action }).catch(() => null),
      page.click('button.btn.btn-primary:has-text("Confirmar")'),
    ]);

    let pedidoId = null;
    if (resp) { try { pedidoId = (await resp.json())?.id ?? null; } catch {} }

    await page.close();
    return res.json({ ok: true, step: 'CART_CONFIRMED', pedidoId, message: 'Pedido confirmado desde el carrito.' });

  } catch (err) {
    return res.status(500).json({ ok: false, step: 'CART_CONFIRM_FAIL', message: err?.message || 'Error' });
  } finally {
    if (context) await context.close();
  }
});

// Start
app.listen(PORT, () => {
  console.log(`bot.cjs escuchando en :${PORT}`);
  console.log('Endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /DISTRISUPER/:codigo');
  console.log('  GET  /DISTRISUPER/:codigo/stock-check-fast');
  console.log('  GET  /DISTRISUPER/:codigo/stock-confirm  (alias deprecado → stock-check-fast)');
  console.log('  GET  /DISTRISUPER/:codigo/confirmations-check?min=');
  console.log('  POST /DISTRISUPER/:codigo/add-to-cart  (alias GET con ?qty=)');
  console.log('  POST /DISTRISUPER/cart-confirm');
});
