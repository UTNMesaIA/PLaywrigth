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

  // Esperar campos (si no están, no es la página de login)
  await page.waitForSelector(SEL.loginUser, { timeout: TIMEOUTS.action });
  await page.waitForSelector(SEL.loginPass, { timeout: TIMEOUTS.action });

  // Completar credenciales
  await page.fill(SEL.loginUser, USER, { timeout: TIMEOUTS.action });
  await page.fill(SEL.loginPass, PASS, { timeout: TIMEOUTS.action });

  // Click + Enter como fallback
  await Promise.race([
    page.click(SEL.loginBtn, { timeout: 5000 }).catch(()=>{}),
    page.keyboard.press('Enter').catch(()=>{})
  ]);

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});
  await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});

  // ¿Seguimos en /login?
  if ((page.url() || '').includes('/login')) {
    const loginError = await page.evaluate(() => {
      try {
        const txt = document.body ? (document.body.innerText || '') : '';
        if (/incorrect|inválid|invalida|error/i.test(txt)) return txt.slice(0, 200);
      } catch {}
      return null;
    }).catch(()=>null);

    throw new Error(
      `Login falló: seguimos en /login. Revisá DISTRISUPER_USER/PASS en Railway. ` +
      (loginError ? `Mensaje: ${loginError}` : '')
    );
  }

  await page.waitForSelector(SEL.buscador, { timeout: TIMEOUTS.nav });
}

async function ensureLoggedIn(context) {
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});
    await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});

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

// Buscar directo por query param ?searchText=
async function searchByQuery(page, codigo) {
  const url = `${BASE}/?searchText=${encodeURIComponent(String(codigo))}`;

  // Primer intento
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });

  // Si pateó a /login, loguear y reintentar 1 vez
  if ((page.url() || '').includes('/login')) {
    await doLogin(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });
    await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});
    if ((page.url() || '').includes('/login')) {
      throw new Error('AUTH_REQUIRED: el sitio sigue en /login tras reintentar (credenciales inválidas o bloqueo).');
    }
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
function normalizeUp(s){ return String(s||'').replace(/\s+/g,' ').trim().toUpperCase(); }

/** Fila/card por código con fallback flexible:
 * 1) intenta la localización actual por :text("...") (rápida)
 * 2) si no hay resultado, busca contenedores de fila y matchea por texto
 *    - preferExact: intenta igualdad exacta primero; luego startsWith/contains
 */
async function rowForCodeFlexible(page, codigo, { preferExact=true } = {}) {
  const codeText = String(codigo).trim();
  const codeUp   = normalizeUp(codeText);

  // 1) intento rápido (tu selector actual), puede ya matchear substrings
  const byText = rowForCode(page, codigo);
  if (await byText.count() > 0) return byText.first();

  // 2) fallback: localizar "contenedores de fila" por tus dos anclas (stockBar + qtyInput)
  //    y filtrar por texto con heurística (exacto, startsWith, contains)
  const rowContainerSel =
    'div:has(div.d-flex.w-100.justify-content-center.align-items-center):has(input[type="number"].text-center)';

  const rows = page.locator(rowContainerSel);
  const n = await rows.count();
  if (!n) return rows; // vacío, retornamos un locator vacío compatible

  let exactIdx = -1, startsIdx = -1, containsIdx = -1;

  for (let i=0; i<n; i++) {
    const txt = normalizeUp(await rows.nth(i).innerText().catch(()=>'')); // robusto
    if (txt === codeUp && exactIdx === -1) exactIdx = i;
    if (txt.startsWith(codeUp) && startsIdx === -1) startsIdx = i;
    if (txt.includes(codeUp) && containsIdx === -1) containsIdx = i;
    if (exactIdx !== -1 && startsIdx !== -1 && containsIdx !== -1) break;
  }

  let pick = -1;
  if (preferExact && exactIdx !== -1) pick = exactIdx;
  else if (startsIdx !== -1) pick = startsIdx;
  else if (containsIdx !== -1) pick = containsIdx;

  return pick >= 0 ? rows.nth(pick) : rows.first(); // último recurso: primera fila
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
  const args = { codeRaw: String(codigo), selTbody: SEL_CONFIRM_FLOAT.tableBody };
  return await page.evaluate(({ codeRaw, selTbody }) => {
    const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const q = norm(codeRaw);

    const tbody = document.querySelector(selTbody);
    if (!tbody) return null;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    const matches = [];

    for (const tr of rows) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 4) continue;

      const codeCellRaw = (tds[0].textContent || '').trim();
      const codeUp      = norm(codeCellRaw);
      const cantRaw     = (tds[1].textContent || '').trim();
      const sucCellUp   = (tds[2].textContent || '').trim().toUpperCase();
      const fechaRaw    = (tds[3].textContent || '').trim();

      if (sucCellUp !== 'BA') continue;

      // --- Matching flexible: exacto -> endsWith -> includes
      let matchType = null;
      if (codeUp === q) matchType = 'exact';
      else if (codeUp.endsWith(q)) matchType = 'endsWith';
      else if (codeUp.includes(q)) matchType = 'includes';

      if (!matchType) continue;

      const m = cantRaw.match(/\d+/);
      const qty = m ? parseInt(m[0], 10) : 0;

      matches.push({
        codigo: codeCellRaw, // mostramos el código como aparece en la tabla (p.ej. FRI808425MM)
        qty,
        suc: 'BA',
        fecha: fechaRaw,
        rowText: tr.innerText,
        matchType
      });
    }

    return matches;
  }, args);
}

// ---- Endpoints ----
app.get('/health', (_req, res) => res.json({ ok: true, step: 'READY' }));

// Ping para probar login en producción
app.get('/health/login-test', async (_req, res) => {
  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);
    const url = page.url();
    await page.close();
    res.json({ ok: true, step: 'LOGIN_OK', url });
  } catch (e) {
    res.status(500).json({ ok: false, step: 'LOGIN_FAIL', message: e?.message || 'Error' });
  } finally {
    if (context) await context.close();
  }
});

// Buscar y devolver BA (debug)
app.get('/DISTRISUPER/:codigo', async (req, res) => {
  const { codigo } = req.params;
  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);
    await searchByQuery(page, codigo);
    const row = await rowForCodeFlexible(page, codigo);
    if (await row.count() === 0) throw new Error(`No encontré una fila que contenga "${codigo}"`);
    const ba = await readBAInRow(row);
    res.json({ ok: true, step: 'SEARCH_OK', codigo, ba });
  } catch (err) {
    res.status(500).json({ ok: false, step: 'SEARCH_FAIL', codigo, message: err?.message || 'Error' });
  } finally {
    if (context) await context.close();
  }
});

// Stock-check rápido
async function stockCheckFastHandler(req, res) {
  const { codigo } = req.params;
  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);
    await searchByQuery(page, codigo);
    const row0 = await rowForCodeFlexible(page, codigo);
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
    const row0 = await rowForCodeFlexible(page, codigo);
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
    await page.waitForSelector('button.btn.btn-dark:has-text("Enviar el pedido")', { timeout: TIMEOUTS.action });
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

/**
 * ENV requeridas:
 *   ZERBINI_USER, ZERBINI_PASS
 * Reutiliza: getBrowser(), TIMEOUTS, fs, path
 */

const ZB = {
  BASE: 'https://zerbinicomponentes.com.ar',
  HOME: 'https://zerbinicomponentes.com.ar/v2/home/',
  CATA: 'https://zerbinicomponentes.com.ar/v2/catalogo/'
};

// Selectores de login (modal "Ingresar")
const ZB_SEL = {
  loginLink: 'a[data-toggle="modal"][data-target="#modal_login"]',
  userInput: 'input[placeholder="Usuario"], input[name="userid"]#uxUsuario, #uxUsuario, input#uxLogin', // tolerante
  passInput: 'input[placeholder="Contraseña"], input[name="password"]#uxPassword, #uxPassword, input[type="password"]',
  loginBtn:  'button.btn.btn-primary:has-text("Ingresar"), button:has-text("Ingresar")'
};

// Selectores de catálogo
const ZB_CATALOG_SEL = {
  codeInput: '#uxCodigo',
  searchBtn:  '#uxBuscar.button-link, #uxBuscar',
  catalogContainer: 'div#content, main, .container, .row'
};

// StorageState separado para Zerbini
const ZB_AUTH_DIR  = path.join(process.cwd(), 'playwright', '.auth_zerbini');
const ZB_AUTH_FILE = path.join(ZB_AUTH_DIR, 'state.json');
fs.mkdirSync(ZB_AUTH_DIR, { recursive: true });

/** Context nuevo con state persistido para Zerbini */
async function zbNewContextWithState() {
  const br = await getBrowser();
  const hasState = fs.existsSync(ZB_AUTH_FILE);
  return hasState ? br.newContext({ storageState: ZB_AUTH_FILE }) : br.newContext();
}

/** LOGIN: abre home, abre modal, carga credenciales y verifica */
async function zbDoLogin(page) {
  const USER = process.env.ZERBINI_USER || '';
  const PASS = process.env.ZERBINI_PASS || '';
  if (!USER || !PASS) throw new Error('Faltan ZERBINI_USER / ZERBINI_PASS en .env');

  await page.goto(ZB.HOME, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });

  // Abrir modal
  await page.waitForSelector(ZB_SEL.loginLink, { timeout: TIMEOUTS.action });
  await page.click(ZB_SEL.loginLink);

  // Completar credenciales
  const user = page.locator(ZB_SEL.userInput).first();
  const pass = page.locator(ZB_SEL.passInput).first();
  await user.waitFor({ state: 'visible', timeout: TIMEOUTS.action });
  await pass.waitFor({ state: 'visible', timeout: TIMEOUTS.action });
  await user.fill(USER);
  await pass.fill(PASS);

  // Enviar
  await Promise.race([
    page.click(ZB_SEL.loginBtn, { timeout: 4000 }).catch(()=>{}),
    page.keyboard.press('Enter').catch(()=>{})
  ]);

  // Esperar red o cierre de modal
  await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});

  // Heurística: si todavía vemos el link "Ingresar", asumimos fallo
  const stillLoginLink = await page.locator(ZB_SEL.loginLink).count().catch(()=>0);
  if (stillLoginLink > 0) {
    const msg = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const m = body.match(/(usuario|contraseñ|inv[aá]lid|incorrect|error)/i);
      return m ? body.slice(Math.max(0, m.index - 60), Math.min(body.length, (m.index||0) + 160)) : null;
    }).catch(()=>null);
    throw new Error('Login Zerbini falló. ' + (msg ? `Detalle: ${msg}` : 'Revisá ZERBINI_USER/PASS.`'));
  }
}

/** Asegura sesión iniciada; si no, hace login. Persiste storageState. */
async function zbEnsureLoggedIn(context) {
  const page = await context.newPage();
  try {
    await page.goto(ZB.HOME, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});
    await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});

    const needsLogin = await page.locator(ZB_SEL.loginLink).count().catch(()=>0);
    if (needsLogin > 0) {
      await zbDoLogin(page);
      await page.goto(ZB.HOME, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});
      await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});
    }

    await context.storageState({ path: ZB_AUTH_FILE });
    return page;
  } catch (e) {
    await page.close().catch(()=>{});
    throw e;
  }
}

// ==========================
//  ZERBINI: helpers de resultados + disponibilidad
// ==========================

/** Espera a que aparezca la grilla y le da tiempo extra a que termine de renderizar. */
async function zbWaitResults(page, extraWaitMs = 5000) {
  await Promise.race([
    page.waitForSelector('table tbody tr', { timeout: TIMEOUTS.nav }),
    page.waitForSelector('text=/no se encontraron/i', { timeout: TIMEOUTS.nav }).catch(()=>{})
  ]).catch(()=>{});
  await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});
  await page.waitForTimeout(extraWaitMs).catch(()=>{});
}

function zbMatchesCodeLoose(codeText, queryUp) {
  const t = (codeText||'').replace(/\s+/g,' ').trim().toUpperCase();
  const q = (queryUp   ||'').replace(/\s+/g,' ').trim().toUpperCase();
  if (!t || !q) return false;
  if (t === q) return true;
  // Heurística: si el query tiene ≥3 chars, preferimos startsWith; si no, contains
  if (q.length >= 3) return t.startsWith(q) || t.includes(q);
  return t.includes(q);
}

async function zbReadAvailability(page, codigo) {
  const codeUpper = String(codigo).trim().toUpperCase();

  // Esperar hasta 10s que cargue la tabla (tolerante)
  await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(()=>{});

  return await page.evaluate((codeUpper) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const up   = (s) => norm(s).toUpperCase();

    const rows = document.querySelectorAll('table tbody tr');
    for (const tr of rows) {
      const th = tr.querySelector('th[scope="row"] span');
      if (!th) continue;

      const codeTextRaw = th.textContent || '';
      const codeTextUp  = up(codeTextRaw);
      const qUp         = up(codeUpper);

      // MATCH FLEXIBLE: exacto -> startsWith -> includes
      const matches =
        (codeTextUp === qUp) ||
        (qUp.length >= 3 ? (codeTextUp.startsWith(qUp) || codeTextUp.includes(qUp)) : codeTextUp.includes(qUp));

      if (!matches) continue;

      const dispTd = tr.querySelector('td[data-title="Disponibilidad"]');
      if (!dispTd) {
        return { codeText: codeTextUp, title: null, cellText: '', iconClass: null, available: null, error: 'NO_DISP_CELL' };
      }

      const cellText = norm(dispTd.textContent || '');
      const span = dispTd.querySelector('[title]') || dispTd.querySelector('i[class*="fa-"], span[class*="fa-"]');
      const title = span ? span.getAttribute('title') : null;
      const iconClass = span ? (span.className || '') : '';

      const bag = `${title || ''} ${cellText}`;

      const isConsult = /baja\s*disponibil|consultar/i.test(bag) || /fa-question/i.test(iconClass);
      const isNoStock = /(sin\s*stock|no\s*disponible|agotado)/i.test(bag) || /(fa-times|fa-close|fa-ban)/i.test(iconClass);
      const isStock   = /\b(con\s*stock|en\s*stock|disponible)\b/i.test(bag) || /fa-check/i.test(iconClass);

      let available = null;
      if (isConsult) available = null;
      else if (isNoStock) available = false;
      else if (isStock) available = true;

      return { codeText: codeTextUp, title, cellText, iconClass, available };
    }
    return null; // no se encontró la fila
  }, codeUpper);
}



/**
 * Ir a catálogo, escribir el código y **clickear BUSCAR**.
 * Después del click espera afterClickWaitMs (default 5000ms).
 */
async function zbSearchInCatalog(page, codigo, afterClickWaitMs = 5000) {
  await page.goto(ZB.CATA, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});
  await page.waitForSelector(ZB_CATALOG_SEL.catalogContainer, { timeout: TIMEOUTS.action }).catch(()=>{});
  await page.waitForSelector(ZB_CATALOG_SEL.codeInput, { timeout: TIMEOUTS.action });

  const input = page.locator(ZB_CATALOG_SEL.codeInput).first();
  await input.click({ timeout: TIMEOUTS.action }).catch(()=>{});
  await input.press('Control+A').catch(()=>{});
  await input.press('Meta+A').catch(()=>{});
  await input.fill('');
  await input.type(String(codigo), { delay: 20 });

  const btn = page.locator(ZB_CATALOG_SEL.searchBtn).first();
  await btn.waitFor({ state: 'visible', timeout: TIMEOUTS.action });
  await Promise.race([
    btn.click().catch(()=>{}),
    (async () => { await input.press('Enter').catch(()=>{}); })()
  ]);

  await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});
  await page.waitForTimeout(afterClickWaitMs).catch(()=>{});

  const finalValue = await input.inputValue().catch(()=>null);
  return { finalValue };
}

// ------------------ Endpoints ------------------

app.get('/ZERBINI/health', (_req, res) => {
  res.json({ ok: true, step: 'ZB_READY', base: ZB.BASE, home: ZB.HOME, cata: ZB.CATA });
});

app.get('/ZERBINI/login-test', async (_req, res) => {
  let context;
  try {
    context = await zbNewContextWithState();
    const page = await zbEnsureLoggedIn(context);
    const url = page.url();
    await page.close();
    res.json({ ok: true, step: 'ZB_LOGIN_OK', url });
  } catch (e) {
    res.status(500).json({ ok: false, step: 'ZB_LOGIN_FAIL', message: e?.message || 'Error' });
  } finally {
    if (context) await context.close();
  }
});

/**
 * GET /ZERBINI/:codigo/search
 *   - Va a /v2/catalogo
 *   - Completa #uxCodigo, clickea BUSCAR, espera 5s (o ?wait=ms)
 *   - Lee "Disponibilidad" (data-title="Disponibilidad")
 */
app.get('/ZERBINI/:codigo/search', async (req, res) => {
  const { codigo } = req.params;
  const afterClickWaitMs = Math.max(0, Number(req.query.wait ?? 5000)); // default 5s

  let context;
  try {
    context = await zbNewContextWithState();
    const page = await zbEnsureLoggedIn(context);

    // Escribir código + click en BUSCAR + esperar
    const { finalValue } = await zbSearchInCatalog(page, codigo, afterClickWaitMs);

    // Esperar aparición de resultados (sin espera extra, ya la hicimos)
    await zbWaitResults(page, 0);

    // Leer disponibilidad
    const availability = await zbReadAvailability(page, codigo);

    const currentUrl = page.url();
    await page.close();

    if (!availability) {
      return res.json({
        ok: true,
        step: 'ZB_CATALOG_SEARCH_NO_ROW',
        codigo,
        inputEcho: finalValue,
        url: currentUrl,
        availability: null,
        waitedAfterClickMs: afterClickWaitMs,
        message: 'No se encontró una fila con ese código en la grilla.'
      });
    }

    res.json({
      ok: true,
      step: 'ZB_CATALOG_SEARCH_OK',
      codigo,
      inputEcho: finalValue,
      url: currentUrl,
      availability,
      inStock: availability.available === true,
      waitedAfterClickMs: afterClickWaitMs
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      step: 'ZB_CATALOG_SEARCH_FAIL',
      codigo,
      message: e?.message || 'Error'
    });
  } finally {
    if (context) await context.close();
  }
});

// ==========================
//  ZERBINI: ADD TO CART
// ==========================

/** Localiza el <a> "Agregar al Carrito" de la fila del código y lo clickea (abre popup iframe). */
async function zbOpenAddToCartPopup(page, codigo) {
  const codeUpper = String(codigo).trim().toUpperCase();

  // Ubicar el <a> dentro de la fila cuyo <th scope="row"> contenga el código.
  const linkSelector = await page.evaluate((codeUpper) => {
    const normUp = (s) => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const qUp    = normUp(codeUpper);

    const rows = document.querySelectorAll('table tbody tr');
    for (const tr of rows) {
      const th = tr.querySelector('th[scope="row"] span');
      if (!th) continue;

      const codeCellUp = normUp(th.textContent || '');

      // MATCH FLEXIBLE: exacto -> startsWith -> includes
      const matches =
        (codeCellUp === qUp) ||
        (qUp.length >= 3 ? (codeCellUp.startsWith(qUp) || codeCellUp.includes(qUp)) : codeCellUp.includes(qUp));

      if (!matches) continue;

      const a = tr.querySelector('td[data-title="Agregar al Carrito"] a');
      if (a) {
        a.setAttribute('data-qa-cart', 'target');
        return 'td[data-title="Agregar al Carrito"] a[data-qa-cart="target"]';
      }
      break; // si matcheó la fila pero no tiene link, no seguimos recorriendo
    }
    return null;
  }, codeUpper);

  if (!linkSelector) {
    return { ok: false, error: 'NO_CART_LINK_IN_ROW' };
  }

  await page.click(linkSelector, { timeout: TIMEOUTS.action }).catch(()=>{});

  // Esperar iframe del popup
  const iframeHandle = await page
    .waitForSelector('iframe.mfp-iframe, .mfp-content iframe', { timeout: Math.max(10000, TIMEOUTS.action) })
    .catch(() => null);

  if (!iframeHandle) return { ok: false, error: 'IFRAME_NOT_FOUND' };

  const frame = await iframeHandle.contentFrame();
  if (!frame) return { ok: false, error: 'IFRAME_CONTENT_NOT_AVAILABLE' };

  return { ok: true, frame };
}

/** Dentro del iframe, selecciona cantidad y hace click en "Agregar al carrito". */
async function zbSubmitCartInPopup(page, frame, qty) {
  // Esperar select de cantidad y botón submit
  await frame.waitForSelector('#units', { timeout: 10000 });
  await frame.selectOption('#units', String(qty)).catch(()=>{});
  await frame.waitForSelector('#uxSubmit', { timeout: 10000 });
  await frame.click('#uxSubmit').catch(()=>{});

  // Esperar confirmación: o bien aparece el snackbar en la página padre,
  // o bien se cierra el popup (iframe desaparece).
  await Promise.race([
    page.waitForSelector('#snackbar.show', { timeout: 10000 }),
    page.waitForSelector('div.mfp-wrap', { state: 'detached', timeout: 10000 })
  ]).catch(()=>{});
}

/**
 * GET /ZERBINI/:codigo/add-to-cart?qty=NUM
 *   - Busca el código en /v2/catalogo
 *   - Abre popup del carrito (columna "Agregar al Carrito")
 *   - Selecciona cantidad (1..100) y confirma
 *   - Toma screenshot para validar
 */
app.get('/ZERBINI/:codigo/add-to-cart', async (req, res) => {
  const { codigo } = req.params;
  let qty = parseInt(String(req.query.qty || '1'), 10);
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  if (qty > 100) qty = 100;

  let context;
  try {
    context = await zbNewContextWithState();
    const page = await zbEnsureLoggedIn(context);

    // Ir al catálogo y buscar el código
    await zbSearchInCatalog(page, codigo, 3000);
    await zbWaitResults(page, 1000); // le damos un segundo extra

    // Abrir popup del carrito
    const { ok, frame, error } = await zbOpenAddToCartPopup(page, codigo);
    if (!ok || !frame) {
      const currentUrl = page.url();
      await page.close().catch(()=>{});
      return res.status(404).json({
        ok: false,
        step: 'ZB_CART_POPUP_FAIL',
        codigo,
        qty,
        url: currentUrl,
        error: error || 'UNKNOWN'
      });
    }

    // Seleccionar cantidad y enviar
    await zbSubmitCartInPopup(page, frame, qty);

    // Screenshot para validar visualmente
    const ssDir = path.join(process.cwd(), 'screenshots');
    fs.mkdirSync(ssDir, { recursive: true });
    const ssFile = path.join(ssDir, `zerbini-add-to-cart-${codigo}-${Date.now()}.png`);
    await page.screenshot({ path: ssFile, fullPage: true }).catch(()=>{});

    const currentUrl = page.url();
    await page.close().catch(()=>{});

    res.json({
      ok: true,
      step: 'ZB_ADD_TO_CART_OK',
      codigo,
      qty,
      url: currentUrl,
      screenshot: ssFile
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      step: 'ZB_ADD_TO_CART_FAIL',
      codigo,
      qty,
      message: e?.message || 'Error'
    });
  } finally {
    if (context) await context.close().catch(()=>{});
  }
});



// ==========================
//  FIN BLOQUE ZERBINI
// ==========================
app.listen(PORT, () => {
  console.log(`bot.cjs escuchando en :${PORT}`);
  console.log('Endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /health/login-test');
  console.log('  GET  /DISTRISUPER/:codigo');
  console.log('  GET  /DISTRISUPER/:codigo/stock-check-fast');
  console.log('  GET  /DISTRISUPER/:codigo/stock-confirm  (alias deprecado → stock-check-fast)');
  console.log('  GET  /DISTRISUPER/:codigo/confirmations-check?min=');
  console.log('  POST /DISTRISUPER/:codigo/add-to-cart  (alias GET con ?qty=)');
  console.log('  POST /DISTRISUPER/cart-confirm');
  console.log('  GET  /ZERBINI/health');
  console.log('  GET  /ZERBINI/login-test');
  console.log('  GET  /ZERBINI/:codigo/search');
  console.log('  GET  /ZERBINI/:codigo/add-to-cart?qty=');
});
