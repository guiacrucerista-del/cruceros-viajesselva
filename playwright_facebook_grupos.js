#!/usr/bin/env node
/**
 * playwright_facebook_grupos.js
 * GuiaCrucerista — Publicador automático en grupos de Facebook
 *
 * Uso:
 *   node playwright_facebook_grupos.js \
 *     --text "Texto del post" \
 *     --url "https://guiacrucerista.com?utm_source=..." \
 *     --groups "811550587597467,1116074769675601,1882092085657041"
 *
 * Variables de entorno:
 *   FB_EMAIL    → email de Facebook
 *   FB_PASSWORD → contraseña de Facebook
 *   HEADLESS    → 'false' para ver el navegador (local), 'true' en VPS
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_FILE = path.join(__dirname, '.fb_session.json');
const DEBUG_DIR    = path.join(__dirname, 'debug');
const FB_EMAIL     = process.env.FB_EMAIL;
const FB_PASSWORD  = process.env.FB_PASSWORD;
const HEADLESS     = process.env.HEADLESS !== 'false';

if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// ─── Args ──────────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const getArg  = (k) => { const i = argv.indexOf(`--${k}`); return i !== -1 ? argv[i + 1] : null; };
const postText = getArg('text')   || '';
const postUrl  = getArg('url')    || '';
const groupIds = (getArg('groups') || '').split(',').map(g => g.trim()).filter(Boolean);

if (!postText || !groupIds.length) { console.error('ERROR: --text y --groups son obligatorios'); process.exit(1); }
if (!FB_EMAIL || !FB_PASSWORD)     { console.error('ERROR: Variables FB_EMAIL y FB_PASSWORD no definidas'); process.exit(1); }

const results = {};
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));
const log     = (msg) => console.error(`[${new Date().toISOString()}] ${msg}`);
const shot    = async (page, label) => {
  const f = path.join(DEBUG_DIR, `${Date.now()}_${label}.png`);
  try { await page.screenshot({ path: f }); log(`📸 ${f}`); } catch {}
};

// ─── Session ───────────────────────────────────────────────────────────────
async function saveCookies(ctx) {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(await ctx.cookies(), null, 2));
  log('Sesión guardada');
}
async function loadCookies(ctx) {
  if (!fs.existsSync(COOKIES_FILE)) return false;
  await ctx.addCookies(JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')));
  log('Sesión cargada');
  return true;
}
async function isLoggedIn(page) {
  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);
    return !page.url().includes('/login');
  } catch { return false; }
}
async function login(page) {
  log('Login en Facebook...');
  await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await page.fill('#email', FB_EMAIL);
  await sleep(400);
  await page.fill('#pass', FB_PASSWORD);
  await sleep(400);
  await page.click('[name="login"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(3000);
  if (page.url().includes('/login') || page.url().includes('checkpoint'))
    throw new Error('Login fallido o requiere 2FA');
  log('Login OK');
}

// ─── Post to group ─────────────────────────────────────────────────────────
async function postToGroup(page, groupId, text, url) {
  log(`\n--- Grupo ${groupId} ---`);
  try {
    // 1. Cargar el grupo
    await page.goto(`https://www.facebook.com/groups/${groupId}`, {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);
    await shot(page, `${groupId}_1_loaded`);

    // 2. Log aria-labels para debug
    const labels = await page.$$eval('[aria-label]', els =>
      els.map(e => e.getAttribute('aria-label')).filter(Boolean).slice(0, 30)
    );
    log(`aria-labels: ${labels.join(' | ')}`);

    // 3. Click en el composer (área de crear publicación)
    const composerSels = [
      '[aria-label="Crear una publicación"]',
      '[aria-label="Create a public post"]',
      '[aria-label="Crear publicación"]',
      '[aria-label="Crea una publicación"]',
      'span:text-is("Escribe algo...")',
      'span:text-is("Escribe algo")',
      'span:text-is("Write something...")',
      '[placeholder*="Escribe algo"]',
      '[placeholder*="Write something"]'
    ];

    let clicked = false;
    for (const sel of composerSels) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          await el.scrollIntoViewIfNeeded();
          await el.click({ timeout: 3000 });
          clicked = true;
          log(`✅ Composer click: ${sel}`);
          break;
        }
      } catch (e) { log(`  skip ${sel}: ${e.message.split('\n')[0]}`); }
    }

    if (!clicked) {
      log('⚠️ No se encontró composer, intentando con keyboard shortcut...');
      await page.keyboard.press('p');
    }

    await sleep(2500);
    await shot(page, `${groupId}_2_composer_clicked`);

    // 4. Encontrar el campo de texto (contenteditable del modal)
    const textSels = [
      'div[role="dialog"] [contenteditable="true"]',
      'div[role="dialog"] [role="textbox"]',
      '[contenteditable="true"][aria-label*="publicación"]',
      '[contenteditable="true"][aria-label*="post"]',
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"]'
    ];

    let textarea = null;
    for (const sel of textSels) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          textarea = el;
          log(`✅ Textarea: ${sel}`);
          break;
        }
      } catch {}
    }

    if (!textarea) {
      await shot(page, `${groupId}_ERROR_no_textarea`);
      throw new Error('No se encontró el campo de texto. Ver debug/');
    }

    await textarea.click();
    await sleep(500);
    await textarea.type(text, { delay: 40 });
    await sleep(1500);
    await shot(page, `${groupId}_3_typed`);

    // 5. Click en botón Publicar
    const pubSels = [
      'div[aria-label="Publicar"]',
      'div[aria-label="Post"]',
      'span[aria-label="Publicar"]',
      'button[aria-label="Publicar"]',
      '[data-testid="react-composer-post-button"]',
      'div[role="button"]:has-text("Publicar")',
      'div[role="button"]:has-text("Post")',
      'button:has-text("Publicar")',
      'button:has-text("Post")'
    ];

    let published = false;
    for (const sel of pubSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0) {
          const disabled = await btn.getAttribute('aria-disabled');
          if (disabled === 'true') { log(`  ⚠️ Botón deshabilitado: ${sel}`); continue; }
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ timeout: 5000 });
          published = true;
          log(`✅ Publicar click: ${sel}`);
          break;
        }
      } catch (e) { log(`  skip ${sel}: ${e.message.split('\n')[0]}`); }
    }

    if (!published) {
      await shot(page, `${groupId}_ERROR_no_publish_btn`);
      throw new Error('No se encontró botón Publicar activo. Ver debug/');
    }

    await sleep(5000);
    await shot(page, `${groupId}_4_published`);
    log(`URL final: ${page.url()}`);

    // 6. Comentar URL
    if (url) {
      log('Añadiendo comentario con URL...');
      await addComment(page, url);
    }

    results[groupId] = { status: 'ok' };
    log(`✅ Grupo ${groupId} publicado`);

  } catch (err) {
    results[groupId] = { status: 'error', message: err.message };
    log(`❌ Grupo ${groupId} ERROR: ${err.message}`);
    try { await shot(page, `${groupId}_FATAL`); } catch {}
  }
}

async function addComment(page, url) {
  await sleep(2000);
  const sels = [
    '[aria-label="Escribe un comentario"]',
    '[aria-label="Write a comment"]',
    '[aria-label*="comentario"]',
    '[contenteditable="true"][role="textbox"]'
  ];
  for (const sel of sels) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click();
        await sleep(400);
        await page.keyboard.type(url, { delay: 20 });
        await sleep(400);
        await page.keyboard.press('Enter');
        log('Comentario con URL añadido');
        return;
      }
    } catch {}
  }
  log('ADVERTENCIA: No se pudo añadir comentario URL');
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  log('=== GuiaCrucerista — Playwright Facebook Grupos ===');
  log(`Grupos: ${groupIds.join(', ')}`);
  log(`Texto: ${postText.substring(0, 60)}...`);
  log(`HEADLESS: ${HEADLESS}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'es-ES'
  });
  const page = await context.newPage();

  try {
    await loadCookies(context);
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      await login(page);
      await saveCookies(context);
    } else {
      log('Sesión activa');
    }

    for (const gid of groupIds) {
      await postToGroup(page, gid, postText, postUrl);
      await sleep(4000);
    }
  } catch (err) {
    log(`FATAL: ${err.message}`);
  }

  await browser.close();

  const output = {
    success: Object.values(results).every(r => r.status === 'ok'),
    groups: results,
    timestamp: new Date().toISOString()
  };

  // JSON al stdout para que n8n lo procese
  console.log(JSON.stringify(output));
  process.exit(output.success ? 0 : 1);
})();
