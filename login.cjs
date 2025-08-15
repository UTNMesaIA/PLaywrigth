// login.cjs
require('dotenv').config();

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

// ---- Config (.env) ----
const BASE     = process.env.DISTRISUPER_URL || 'https://lupa.distrisuper.com';
const USER     = process.env.DISTRISUPER_USER || '';
const PASS     = process.env.DISTRISUPER_PASS || '';
const HEADLESS = process.env.PW_HEADLESS !== 'false'; // true por defecto

const TIMEOUTS = { nav: 35000, action: 30000 };
const DEFAULT_MAX_CONFIRM_MS = 3 * 60 * 60 * 1000; // 3 horas

// ---- Selectores centrales ----
const SEL = {
  // Login + buscador
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

  // Compra (carrito/modal)
  btnEnviarPedido: 'button.btn.btn-dark:has-text("Enviar el pedido")',
  obsTextarea: '#observaciones',
  btnConfirmar: 'button.btn.btn-primary:has-text("Confirmar")',
};

// ---- Estado de autenticación persistido ----
const AUTH_DIR  = path.join(process.cwd(), 'playwright', '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'state.json');
fs.mkdirSync(AUTH_DIR, { recursive: true });

// ---- Browser singleton ----
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
  await page.waitForSelector(SEL.stockBar, { timeout: TIMEOUTS.nav });
}

/** Fila/card que contiene el texto del código (y sube al contenedor con barra de stock e input de cantidad) */
function rowForCode(page, codigo) {
  const codeText = String(codigo).trim();
  const xpath = 'xpath=ancestor-or-self::div[' +
    './/div[contains(@class,"justify-content-center") and contains(@class,"align-items-center")]' + // stockBar
    ' and .//input[@type="number" and contains(@class,"text-center")]' + // qtyInput
    '][1]';
  // Usa selector de texto estándar de Playwright
  return page.locator(`text=${codeText}`).locator(xpath);
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
  return await page.evaluate(() => {
    const tbody = document.querySelector('div.table-responsive table tbody');
    if (!tbody) return null;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    for (const tr of rows) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 2) continue;
      const codeCell = (tds[0].textContent || '').trim().toUpperCase();
      const cantRaw  = (tds[1].textContent || '').trim(); // 2do td = Cant
      const m = cantRaw.match(/\d+/);
      const qty = m ? parseInt(m[0], 10) : null;
      // Retornamos todo el texto por si hace falta debug
      tr.dataset._debugText = tr.innerText;
      rows; // no-op para contentEditable
      // Valor retornado si coincide está fuera; no hacemos filtro aquí para volver universal
    }
    return null;
  }).then(async (res) => {
    // No podemos filtrar por código arriba porque no tenemos el valor; lo hacemos aquí con un segundo pass
    return await page.evaluate((codeUpper) => {
      const tbody = document.querySelector('div.table-responsive table tbody');
      if (!tbody) return null;
      const rows = Array.from(tbody.querySelectorAll('tr'));
      for (const tr of rows) {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 2) continue;
        const codeCell = (tds[0].textContent || '').trim().toUpperCase();
        if (codeCell === codeUpper) {
          const cantRaw = (tds[1].textContent || '').trim();
          const m = cantRaw.match(/\d+/);
          const qty = m ? parseInt(m[0], 10) : null;
          return { qty, rowText: tr.innerText };
        }
      }
      return null;
    }, String(codigo).trim().toUpperCase());
  });
}

// ---- Exports ----
module.exports = {
  // env / config
  BASE, USER, PASS, HEADLESS,
  TIMEOUTS, DEFAULT_MAX_CONFIRM_MS,

  // selectors
  SEL,

  // browser / session
  getBrowser, newContextWithState, ensureLoggedIn, doLogin,

  // utils
  searchByQuery, rowForCode, readBAInRow,
  clickBAConsult, openConfirmationsPanel, readConfirmationsOnce,
};
