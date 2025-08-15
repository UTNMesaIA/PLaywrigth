// bot.cjs — LOGIN + SEARCH (?searchText) + STOCK(BA) + CONFIRMACIONES "C" (banner flotante) + ADD TO CART

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

  // Dentro de cada fila/card de producto:
  stockBar:  'div.d-flex.w-100.justify-content-center.align-items-center', // barra con 4 semáforos
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
  await page.fill(SEL.loginUser, USER,    { timeout: TIMEOUTS.action });
  await page.fill(SEL.loginPass, PASS,    { timeout: TIMEOUTS.action });
  await Promise.all([
    page.click(SEL.loginBtn,             { timeout: TIMEOUTS.action }),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(() => {})
  ]);
  await page.waitForSelector(SEL.buscador, { timeout: TIMEOUTS.nav });
}
async function ensureLoggedIn(context) {
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});

    // Si estamos logueados, debería existir el buscador
    if (await page.$(SEL.buscador)) return page;

    // Si no, logueamos
    await doLogin(page);

    // Verificamos de nuevo que el buscador esté tras login
    await page.waitForSelector(SEL.buscador, { timeout: TIMEOUTS.nav });
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

  // Esperar que termine de pedir cosas (APIs, imágenes, etc.)
  await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.nav }).catch(()=>{});
  await page.waitForTimeout(1000).catch(()=>{}); // pequeña gracia

  // Cualquiera de estas señales indica que cargó el listado
  const ok = await Promise.race([
    page.waitForSelector(SEL.stockBar, { timeout: TIMEOUTS.nav }).then(()=>true).catch(()=>false),
    page.waitForSelector(`:text("${String(codigo).trim()}")`, { timeout: TIMEOUTS.nav }).then(()=>true).catch(()=>false),
    page.waitForSelector(SEL.buscador, { timeout: TIMEOUTS.nav }).then(()=>true).catch(()=>false) // por si quedó en otra vista pero cargó
  ]);

  if (!ok) {
    // Debug: te devolvemos URL y un pantallazo si falla
    const dbgUrl = page.url();
    try { await page.screenshot({ path: `debug-search-${Date.now()}.png`, fullPage: true }); } catch {}
    throw new Error(`No se renderizó el listado para ${codigo}. URL actual: ${dbgUrl}`);
  }
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

/** Setea la cantidad en el input de la fila del producto y dispara eventos */
async function setQtyInRow(row, qty) {
  const input = row.locator(SEL.qtyInput).first();
  await input.waitFor({ state: 'visible', timeout: TIMEOUTS.nav });

  // Seleccionar todo + limpiar + tipear
  await input.click({ clickCount: 3 }).catch(()=>{});
  await input.fill('');
  await input.type(String(qty));

  // Disparar blur/cambio por las dudas
  await input.press('Tab').catch(()=>{});
  await row.page().waitForTimeout(200).catch(()=>{});

  const finalValue = await input.inputValue().catch(() => null);
  return { finalValue };
}

// ---------------- Confirmaciones: banner flotante moderno ----------------
const SEL_CONFIRM_FLOAT = {
  // texto del banner (menos frágil que encadenar todas las clases utilitarias)
  bannerText: 'text=Tenés confirmaciones de stock',
  // contenedor blanco del popup (cuando se abre)
  modalContainer: 'div.bg-white.text-black',
  // tbody de la tabla dentro del popup
  tableBody: 'div.bg-white.text-black .table-responsive table tbody'
};

// Abre el banner flotante (si existe) y espera que aparezca el modal/tabla
async function openFloatingConfirmations(page) {
  // gracia inicial: la UI tarda en “pintar” el toast
  await page.waitForTimeout(5000).catch(() => {});

  const deadline = Date.now() + 20000; // hasta 20s total
  const findBanner = () => page.locator(SEL_CONFIRM_FLOAT.bannerText).first();

  while (Date.now() < deadline) {
    const t = findBanner();
    if (await t.count()) {
      // Subimos al div “position-fixed ... cursor-pointer” si existe; si no, clickeamos el texto.
      const clickable = t.locator('xpath=ancestor-or-self::div[contains(@class,"position-fixed") and contains(@class,"cursor-pointer")][1]');
      try {
        if (await clickable.count()) {
          await clickable.click({ timeout: 2000 });
        } else {
          await t.click({ timeout: 2000 });
        }
      } catch {
        // Fallback por si hay overlay o z-index raro
        await page.evaluate((selector) => {
          const el = document.querySelector(selector) || Array.from(document.querySelectorAll('*')).find(n => (n.textContent||'').includes('Tenés confirmaciones de stock'));
          if (el) el.click();
        }, SEL_CONFIRM_FLOAT.bannerText);
      }

      // Esperamos el modal/tabla
      await page.waitForSelector(`${SEL_CONFIRM_FLOAT.modalContainer}, ${SEL_CONFIRM_FLOAT.tableBody}`, { timeout: 5000 }).catch(() => {});
      if (await page.locator(SEL_CONFIRM_FLOAT.tableBody).count()) return true;
      if (await page.locator(SEL_CONFIRM_FLOAT.modalContainer).count()) return true;
    }

    await page.waitForTimeout(1000).catch(() => {});
  }
  return false;
}

// Lee la tabla del modal flotante y busca el código y sucursal BA
async function readFloatingConfirmations(page, codigo) {
  const args = {
    codeUpper: String(codigo).trim().toUpperCase(),
    selTbody: SEL_CONFIRM_FLOAT.tableBody
  };

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

// Buscar y devolver BA del match real (útil para debug / monitoreo rápido)
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

// Handler compartido para revisión inmediata del semáforo (sin esperar confirmaciones)
async function stockCheckFastHandler(req, res) {
  const { codigo } = req.params;
  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);

    await searchByQuery(page, codigo);
    const row = rowForCode(page, codigo);
    if (await row.count() === 0) throw new Error(`No encontré una fila que contenga "${codigo}"`);
    const row0 = row.first();

    const ba = await readBAInRow(row0);

    if (ba.isConsult) {
      await clickBAConsult(row0);
      await page.waitForTimeout(5000).catch(()=>{});
      await page.close();
      return res.json({
        ok: true,
        step: 'CONSULTED_DUE_TO_YELLOW',
        codigo,
        mode: 'consult-clicked',
        consulted: true,
        message: 'Semáforo amarillo con "C". Se hizo click para consultar y se terminó la ejecución.'
      });
    }

    if (ba.isGreen) {
      const available = (typeof ba.numero === 'number') ? ba.numero : null;
      await page.close();
      return res.json({
        ok: true,
        step: 'GREEN_STOCK',
        codigo,
        mode: 'immediate-green',
        stock: available !== null ? available > 0 : false,
        available,
        ba
      });
    }

    // Rojo / sin stock
    await page.close();
    return res.json({
      ok: true,
      step: 'NO_STOCK_RED',
      codigo,
      mode: 'unavailable',
      stock: false,
      available: 0,
      ba
    });

  } catch (err) {
    res.status(500).json({ ok: false, step: 'STOCK_CHECK_FAST_FAIL', codigo, message: err?.message || 'Error' });
  } finally {
    if (context) await context.close();
  }
}

app.get('/DISTRISUPER/:codigo/stock-check-fast', stockCheckFastHandler);

// Confirmaciones: abrir banner flotante y leer modal (Suc=BA)
app.get('/DISTRISUPER/:codigo/confirmations-check', async (req, res) => {
  const { codigo } = req.params;
  const min = req.query.min !== undefined ? Number(req.query.min) : null;

  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);

    // Entramos a home
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav }).catch(()=>{});
    // pequeña gracia adicional por arriba de la de openFloatingConfirmations
    await page.waitForTimeout(1500).catch(()=>{});

    let opened = await openFloatingConfirmations(page);

    // Fallback: si en la home no aparece el toast, probamos abrir un listado
    if (!opened) {
      await searchByQuery(page, ' ');
      opened = await openFloatingConfirmations(page);
    }

    if (!opened) {
      await page.close();
      const out = {
        ok: true,
        step: 'NO_CONFIRM_BANNER',
        codigo,
        hasConfirmations: false,
        message: 'No se encontró el banner de "Tenés confirmaciones de stock".'
      };
      if (min !== null) out.min = min;
      return res.json(out);
    }

    await page.waitForTimeout(500).catch(()=>{});
    const matches = await readFloatingConfirmations(page, codigo);
    await page.close();

    if (!matches || matches.length === 0) {
      const out = {
        ok: true,
        step: 'CONFIRM_MODAL_EMPTY_FOR_CODE',
        codigo,
        hasConfirmations: true,
        results: [],
        message: 'Se abrió el modal, pero no hay filas para ese código con Suc=BA.'
      };
      if (min !== null) out.min = min;
      return res.json(out);
    }

    let bestQty = 0;
    for (const r of matches) bestQty = Math.max(bestQty, r.qty);

    const out = {
      ok: true,
      step: 'CONFIRM_MODAL_RESULTS',
      codigo,
      hasConfirmations: true,
      results: matches
    };
    if (min !== null) {
      out.min = min;
      out.available = bestQty;
      out.enough = bestQty >= min;
    }
    return res.json(out);

  } catch (err) {
    const out = { ok: false, step: 'CONFIRMATIONS_CHECK_FAIL', codigo, message: err?.message || 'Error' };
    if (req.query.min !== undefined) out.min = Number(req.query.min);
    res.status(500).json(out);
  } finally {
    if (context) await context.close();
  }
});

// ---------- ADD TO CART: setear cantidad en la fila ----------
async function addToCartHandler(req, res) {
  const { codigo } = req.params;
  const qty = Number(req.query.qty);
  const requireGreen = ['1', 'true', 'yes'].includes(String(req.query.requireGreen || '').toLowerCase());

  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({
      ok: false,
      step: 'ADD_TO_CART_INVALID_QTY',
      codigo,
      message: 'Falta ?qty= (número > 0).'
    });
  }

  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);

    await searchByQuery(page, codigo);
    const row = rowForCode(page, codigo);
    if (await row.count() === 0) throw new Error(`No encontré una fila que contenga "${codigo}"`);
    const row0 = row.first();

    let ba = await readBAInRow(row0);
    if (requireGreen && !ba.isGreen) {
      await page.close();
      return res.status(409).json({
        ok: false,
        step: 'BA_NOT_GREEN',
        codigo,
        required: 'green',
        ba,
        message: 'El semáforo BA no está en verde y requireGreen=1.'
      });
    }

    const { finalValue } = await setQtyInRow(row0, qty);

    // ⏳ Esperar 10 segundos para que la web procese la cantidad en el carrito
    await page.waitForTimeout(10000).catch(()=>{});

    // Releer BA por si la UI cambió algo (opcional)
    ba = await readBAInRow(row0).catch(() => ba);

    await page.close();
    return res.json({
      ok: true,
      step: 'QTY_SET_OK',
      codigo,
      qtyRequested: qty,
      qtyInputValue: finalValue !== null ? Number(finalValue) : null,
      waitedMs: 10000,
      ba,
      message: 'Cantidad cargada en el input del producto (espera de 10s aplicada).'
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      step: 'ADD_TO_CART_FAIL',
      codigo,
      message: err?.message || 'Error'
    });
  } finally {
    if (context) await context.close();
  }
}

app.post('/DISTRISUPER/:codigo/add-to-cart', addToCartHandler);
app.get('/DISTRISUPER/:codigo/add-to-cart', addToCartHandler);

// Alias deprecado para compatibilidad: redirige a stock-check-fast
app.get('/DISTRISUPER/:codigo/stock-confirm', stockCheckFastHandler);
// ---------- CART CONFIRM: confirmar pedido actual ----------
app.post('/DISTRISUPER/cart-confirm', async (req, res) => {
  let context;
  try {
    context = await newContextWithState();
    const page = await ensureLoggedIn(context);

    // Ir directo al carrito
    await page.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });
    await page.waitForSelector('button.btn.btn-dark:has-text("Enviar el pedido")', { timeout: TIMEOUTS.action });

    // Abrir modal de confirmación
    await page.click('button.btn.btn-dark:has-text("Enviar el pedido")');

    // Completar observaciones
    await page.waitForSelector('#observaciones', { timeout: TIMEOUTS.action });
    await page.fill('#observaciones', 'urg');

    // Capturar respuesta POST de confirmación
    const [resp] = await Promise.all([
      page.waitForResponse(
        r => r.request().method() === 'POST' && /pedido|order|checkout/i.test(r.url()),
        { timeout: TIMEOUTS.action }
      ).catch(() => null),
      page.click('button.btn.btn-primary:has-text("Confirmar")'),
    ]);

    let pedidoId = null;
    if (resp) {
      try { pedidoId = (await resp.json())?.id ?? null; } catch {}
    }

    await page.close();
    return res.json({
      ok: true,
      step: 'CART_CONFIRMED',
      pedidoId,
      message: 'Pedido confirmado desde el carrito.'
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      step: 'CART_CONFIRM_FAIL',
      message: err?.message || 'Error'
    });
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
