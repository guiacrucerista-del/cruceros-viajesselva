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
 * Variables de entorno requeridas:
 *   FB_EMAIL    → email de Facebook
 *   FB_PASSWORD → contraseña de Facebook
 *   FB_PROFILE  → (opcional) ruta al perfil de Chromium persistente
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────
const COOKIES_FILE = path.join(__dirname, '.fb_session.json');
const PROFILE_DIR  = process.env.FB_PROFILE || path.join(__dirname, '.fb_profile');
const FB_EMAIL     = process.env.FB_EMAIL;
const FB_PASSWORD  = process.env.FB_PASSWORD;
const HEADLESS     = process.env.HEADLESS !== 'false'; // true por defecto en VPS

// ─── Parse argumentos CLI ──────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (key) => {
  const idx = argv.indexOf(`--${key}`);
  return idx !== -1 ? argv[idx + 1] : null;
};

const postText  = getArg('text')   || '';
const postUrl   = getArg('url')    || '';
const groupsRaw = getArg('groups') || '';
const groupIds  = groupsRaw.split(',').map(g => g.trim()).filter(Boolean);

if (!postText || !groupIds.length) {
  console.error('ERROR: --text y --groups son obligatorios');
  process.exit(1);
}

if (!FB_EMAIL || !FB_PASSWORD) {
  console.error('ERROR: Variables FB_EMAIL y FB_PASSWORD no definidas');
  process.exit(1);
}

// ─── Resultado global ──────────────────────────────────────────────────────
const results = {};

// ─── Helpers ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function saveCookies(context) {
  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  log('Sesión guardada en ' + COOKIES_FILE);
}

async function loadCookies(context) {
  if (fs.existsSync(COOKIES_FILE)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    await context.addCookies(cookies);
    log('Sesión cargada desde ' + COOKIES_FILE);
    return true;
  }
  return false;
}

async function isLoggedIn(page) {
  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);
    // Si redirige a login, no hay sesión
    const url = page.url();
    return !url.includes('/login');
  } catch {
    return false;
  }
}

async function login(page) {
  log('Iniciando sesión en Facebook...');
  await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  await page.fill('#email', FB_EMAIL);
  await sleep(500);
  await page.fill('#pass', FB_PASSWORD);
  await sleep(500);
  await page.click('[name="login"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(3000);

  const url = page.url();
  if (url.includes('/login') || url.includes('checkpoint')) {
    throw new Error('Login fallido o requiere verificación 2FA. Revisar credenciales.');
  }
  log('Login exitoso');
}

async function postToGroup(page, groupId, text, url) {
  log(`Publicando en grupo ${groupId}...`);
  
  try {
    // Navegar al grupo
    await page.goto(`https://www.facebook.com/groups/${groupId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    await sleep(3000);

    // Buscar el área de "Crear publicación"
    // Facebook usa varios selectores según el idioma/versión
    const createPostSelectors = [
      '[data-pagelet="GroupInFeed"] [role="button"][tabindex="0"]',
      'div[aria-label="Crear una publicación"]',
      'div[aria-label="Create a public post"]',
      'div[data-testid="status-attachment-mentions-input"]',
      'div[role="button"]:has-text("Escribe algo")',
      'div[role="button"]:has-text("Write something")',
      '[aria-label*="publicación"]',
      '[aria-label*="post"]'
    ];

    let clicked = false;
    for (const sel of createPostSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          clicked = true;
          log(`  Click en área de post (selector: ${sel})`);
          break;
        }
      } catch {}
    }

    if (!clicked) {
      // Intento alternativo: buscar por texto parcial de crear post
      const fallbackTexts = ['Escribe algo', 'Write something', 'Qué tienes en mente', 'En qué estás pensando'];
      for (const t of fallbackTexts) {
        try {
          const el = await page.getByText(t, { exact: false }).first();
          if (el) { await el.click(); clicked = true; break; }
        } catch {}
      }
    }

    await sleep(2000);

    // Escribir el texto en el área activa
    await page.keyboard.type(text, { delay: 30 });
    await sleep(1500);

    // Buscar y hacer clic en "Publicar"
    const publishSelectors = [
      '[aria-label="Publicar"]',
      '[aria-label="Post"]',
      'div[role="button"]:has-text("Publicar")',
      'div[role="button"]:has-text("Post")',
      'button:has-text("Publicar")',
      'button:has-text("Post")'
    ];

    let published = false;
    for (const sel of publishSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const isDisabled = await btn.getAttribute('aria-disabled');
          if (isDisabled !== 'true') {
            await btn.click();
            published = true;
            log(`  Click en Publicar (selector: ${sel})`);
            break;
          }
        }
      } catch {}
    }

    if (!published) {
      await page.keyboard.press('Tab');
      await sleep(500);
      await page.keyboard.press('Enter');
      published = true;
    }

    // Esperar a que se publique
    await sleep(4000);

    // Si hay URL, buscar el post recién creado y añadir comentario
    if (url) {
      log(`  Añadiendo comentario con URL en grupo ${groupId}...`);
      await addFirstComment(page, url);
    }

    results[groupId] = { status: 'ok' };
    log(`✅ Publicado en grupo ${groupId}`);

  } catch (err) {
    results[groupId] = { status: 'error', message: err.message };
    log(`❌ Error en grupo ${groupId}: ${err.message}`);
  }
}

async function addFirstComment(page, url) {
  await sleep(2000);
  
  const commentSelectors = [
    '[data-testid="UFI2CommentBox/input"]',
    '[aria-label="Escribe un comentario"]',
    '[aria-label="Write a comment"]',
    '[aria-label*="comentario"]',
    '[aria-label*="comment"]',
    '[contenteditable="true"][role="textbox"]'
  ];

  for (const sel of commentSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await sleep(500);
        await page.keyboard.type(url, { delay: 20 });
        await sleep(500);
        await page.keyboard.press('Enter');
        log(`  Comentario con URL añadido`);
        return;
      }
    } catch {}
  }
  log(`  ADVERTENCIA: No se pudo añadir comentario con URL`);
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  log('=== GuiaCrucerista — Playwright Facebook Grupos ===');
  log(`Grupos objetivo: ${groupIds.join(', ')}`);
  log(`Texto (primeros 60 chars): ${postText.substring(0, 60)}...`);

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
    const hasSession = await loadCookies(context);
    const loggedIn = await isLoggedIn(page);

    if (!loggedIn) {
      await login(page);
      await saveCookies(context);
    } else {
      log('Sesión activa, sin necesidad de login');
    }

    // Publicar en cada grupo secuencialmente
    for (const groupId of groupIds) {
      await postToGroup(page, groupId, postText, postUrl);
      await sleep(3000); // Pausa entre grupos para evitar rate limiting
    }

  } catch (err) {
    log(`ERROR FATAL: ${err.message}`);
    console.error(JSON.stringify({ error: err.message, results }));
    await browser.close();
    process.exit(1);
  }

  await browser.close();

  // Output JSON para que n8n lo procese
  const output = {
    success: Object.values(results).every(r => r.status === 'ok'),
    groups: results,
    timestamp: new Date().toISOString()
  };

  console.log(JSON.stringify(output));
  process.exit(0);
})();
