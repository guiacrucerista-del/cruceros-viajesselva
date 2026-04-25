#!/usr/bin/env node
/**
 * playwright_facebook_grupos.js — GuiaCrucerista
 *
 * Modos de uso:
 *   1) Archivo JSON (recomendado, sin problemas de escape):
 *      node playwright_facebook_grupos.js --input /tmp/fb_post.json
 *
 *   2) Argumentos CLI:
 *      node playwright_facebook_grupos.js --text "Texto" --url "https://..." --groups "id1,id2" --page "guiacrucerista"
 *
 * Variables de entorno (.env):
 *   FB_EMAIL    = tu@email.com
 *   FB_PASSWORD = tu_contraseña
 *   HEADLESS    = true (false para ver el navegador en local)
 *   FB_GROUPS   = id1,id2,id3  (grupos por defecto)
 *   FB_PAGE     = guiacrucerista (slug de la página por defecto)
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const COOKIES_FILE = path.join(__dirname, '.fb_session.json');
const DEBUG_DIR    = path.join(__dirname, 'debug');
const FB_EMAIL     = process.env.FB_EMAIL;
const FB_PASSWORD  = process.env.FB_PASSWORD;
const HEADLESS     = process.env.HEADLESS !== 'false';

if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// ─── Parsear argumentos ────────────────────────────────────────────────────
const argv   = process.argv.slice(2);
function getArg(k) { const i = argv.indexOf('--' + k); return i !== -1 ? argv[i + 1] : null; }

let postText, postUrl, groupIds, pageSlug;

const inputFile = getArg('input');
if (inputFile && fs.existsSync(inputFile)) {
  const d = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  postText  = d.text   || '';
  postUrl   = d.url    || '';
  groupIds  = Array.isArray(d.groups) ? d.groups : (d.groups || '').split(',').map(function(g) { return g.trim(); }).filter(Boolean);
  pageSlug  = d.page   || process.env.FB_PAGE || '';
} else {
  postText  = getArg('text')    || '';
  postUrl   = getArg('url')     || '';
  groupIds  = (getArg('groups') || process.env.FB_GROUPS || '').split(',').map(function(g) { return g.trim(); }).filter(Boolean);
  pageSlug  = getArg('page')    || process.env.FB_PAGE   || '';
}

if (!postText) {
  console.error('ERROR: Proporciona --input o --text');
  process.exit(1);
}
if (!groupIds.length && !pageSlug) {
  console.error('ERROR: Proporciona --groups y/o --page (o define FB_GROUPS/FB_PAGE en .env)');
  process.exit(1);
}
if (!FB_EMAIL || !FB_PASSWORD) {
  console.error('ERROR: Variables FB_EMAIL y FB_PASSWORD no definidas');
  process.exit(1);
}

// ─── Utilidades ────────────────────────────────────────────────────────────
const results = { groups: {}, page: null };
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function sleepRandom(min, max) { return sleep(min + Math.floor(Math.random() * (max - min))); }
function log(msg)  { console.error('[' + new Date().toISOString() + '] ' + msg); }
async function shot(page, label) {
  const f = path.join(DEBUG_DIR, Date.now() + '_' + label + '.png');
  try { await page.screenshot({ path: f }); log('Foto: ' + f); } catch(e) {}
}

// ─── Sesión ────────────────────────────────────────────────────────────────
async function saveCookies(ctx) {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(await ctx.cookies(), null, 2));
  log('Sesion guardada');
}
async function loadCookies(ctx) {
  if (!fs.existsSync(COOKIES_FILE)) return false;
  await ctx.addCookies(JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')));
  log('Sesion cargada');
  return true;
}
async function isLoggedIn(page) {
  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);
    return !page.url().includes('/login');
  } catch(e) { return false; }
}
async function login(page) {
  log('Login...');
  await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await page.fill('#email', FB_EMAIL);
  await sleepRandom(400, 900);
  await page.fill('#pass', FB_PASSWORD);
  await sleepRandom(400, 900);
  await page.click('[name="login"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(3000);
  if (page.url().includes('/login') || page.url().includes('checkpoint'))
    throw new Error('Login fallido o requiere 2FA');
  log('Login OK');
}

// ─── Selectores compartidos ────────────────────────────────────────────────
const COMPOSER_SELS = [
  '[aria-label="Crear una publicacion"]',
  '[aria-label="Crear una publicación"]',
  '[aria-label="Create a public post"]',
  '[aria-label="Crear publicacion"]',
  '[aria-label="Crear publicación"]',
  '[aria-label="¿Qué tienes en mente?"]',
  '[aria-label="What\'s on your mind?"]',
  'span:text-is("Escribe algo...")',
  'span:text-is("Escribe algo")',
  'span:text-is("Write something...")',
  'span:text-is("¿Qué tienes en mente?")',
  '[placeholder*="Escribe algo"]',
  '[placeholder*="Write something"]'
];

const TEXTAREA_SELS = [
  'div[role="dialog"] [contenteditable="true"]',
  'div[role="dialog"] [role="textbox"]',
  '[contenteditable="true"][aria-label*="publicaci"]',
  '[contenteditable="true"][aria-label*="mente"]',
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"]'
];

const PUBLISH_SELS = [
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

// ─── Función genérica de escritura y publicación ────────────────────────────
async function typeAndPublish(page, label, text) {
  // Campo de texto
  var textarea = null;
  for (var j = 0; j < TEXTAREA_SELS.length; j++) {
    try {
      var candidate = page.locator(TEXTAREA_SELS[j]).first();
      if (await candidate.count() > 0) {
        textarea = candidate;
        log('Textarea OK: ' + TEXTAREA_SELS[j]);
        break;
      }
    } catch(e) {}
  }
  if (!textarea) {
    await shot(page, label + '_ERROR_no_textarea');
    throw new Error('Campo de texto no encontrado. Ver debug/');
  }

  await textarea.click();
  await sleep(500);
  // Escribir en bloques para parecer humano
  const words = text.split(' ');
  for (var w = 0; w < words.length; w++) {
    await textarea.type(words[w] + (w < words.length - 1 ? ' ' : ''), { delay: 30 + Math.floor(Math.random() * 60) });
    if (w % 10 === 9) await sleepRandom(200, 500); // pausa cada 10 palabras
  }
  await sleep(1500);
  await shot(page, label + '_3_typed');

  // Botón Publicar
  var published = false;
  for (var k = 0; k < PUBLISH_SELS.length; k++) {
    try {
      var btn = page.locator(PUBLISH_SELS[k]).first();
      if (await btn.count() > 0) {
        var disabled = await btn.getAttribute('aria-disabled');
        if (disabled === 'true') { log('Btn deshabilitado: ' + PUBLISH_SELS[k]); continue; }
        await btn.scrollIntoViewIfNeeded();
        await btn.click({ timeout: 5000 });
        published = true;
        log('Publicar OK: ' + PUBLISH_SELS[k]);
        break;
      }
    } catch(e) { log('pub skip: ' + PUBLISH_SELS[k]); }
  }

  if (!published) {
    await shot(page, label + '_ERROR_no_publish_btn');
    throw new Error('Boton Publicar no encontrado. Ver debug/');
  }

  await sleep(5000);
  await shot(page, label + '_4_done');
  log('URL final: ' + page.url());
}

// ─── Publicar en grupo ─────────────────────────────────────────────────────
async function postToGroup(page, groupId, text, url) {
  log('--- Grupo ' + groupId + ' ---');
  try {
    await page.goto('https://www.facebook.com/groups/' + groupId, {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);
    await shot(page, groupId + '_1_loaded');

    // Log aria-labels para diagnóstico
    const labels = await page.$$eval('[aria-label]', function(els) {
      return els.map(function(e) { return e.getAttribute('aria-label'); }).filter(Boolean).slice(0, 30);
    });
    log('aria-labels: ' + labels.join(' | '));

    // Click en compositor
    var clicked = false;
    for (var i = 0; i < COMPOSER_SELS.length; i++) {
      try {
        var el = page.locator(COMPOSER_SELS[i]).first();
        if (await el.count() > 0) {
          await el.scrollIntoViewIfNeeded();
          await el.click({ timeout: 3000 });
          clicked = true;
          log('Composer OK: ' + COMPOSER_SELS[i]);
          break;
        }
      } catch(e) { log('skip: ' + COMPOSER_SELS[i]); }
    }

    if (!clicked) {
      log('AVISO: Composer no encontrado, probando tecla p...');
      await page.keyboard.press('p');
    }

    await sleep(2500);
    await shot(page, groupId + '_2_after_click');

    await typeAndPublish(page, groupId, text);

    // Primer comentario con URL
    if (url) {
      log('Comentario URL...');
      await addComment(page, url);
    }

    results.groups[groupId] = { status: 'ok' };
    log('OK grupo ' + groupId);

  } catch(err) {
    results.groups[groupId] = { status: 'error', message: err.message };
    log('ERROR grupo ' + groupId + ': ' + err.message);
    try { await shot(page, groupId + '_FATAL'); } catch(e) {}
  }
}

// ─── Publicar en página ─────────────────────────────────────────────────────
async function postToPage(page, slug, text, url) {
  log('--- Página ' + slug + ' ---');
  try {
    await page.goto('https://www.facebook.com/' + slug, {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(3000);
    await shot(page, 'page_' + slug + '_1_loaded');

    // Log aria-labels para diagnóstico
    const labels = await page.$$eval('[aria-label]', function(els) {
      return els.map(function(e) { return e.getAttribute('aria-label'); }).filter(Boolean).slice(0, 30);
    });
    log('aria-labels página: ' + labels.join(' | '));

    // Click en compositor de la página
    var clicked = false;
    var pageComposerSels = COMPOSER_SELS.concat([
      '[aria-label="Escribe algo en tu página..."]',
      '[aria-label="Write something on your Page..."]',
      '[aria-label="Crea una publicación..."]',
      'span:text-is("Escribe algo en tu página...")',
      'span:text-is("Write something on your Page...")',
      '[data-testid="page-composer"]'
    ]);

    for (var i = 0; i < pageComposerSels.length; i++) {
      try {
        var el = page.locator(pageComposerSels[i]).first();
        if (await el.count() > 0) {
          await el.scrollIntoViewIfNeeded();
          await el.click({ timeout: 3000 });
          clicked = true;
          log('Composer página OK: ' + pageComposerSels[i]);
          break;
        }
      } catch(e) { log('page skip: ' + pageComposerSels[i]); }
    }

    if (!clicked) {
      log('AVISO: Compositor de página no encontrado con selectores, intentando click en zona...');
      // Intentar hacer clic directamente en el área de "Qué tienes en mente"
      try {
        await page.locator('[role="main"]').locator('[role="textbox"]').first().click({ timeout: 5000 });
        clicked = true;
      } catch(e) { log('fallback textbox también falló'); }
    }

    await sleep(2500);
    await shot(page, 'page_' + slug + '_2_after_click');

    await typeAndPublish(page, 'page_' + slug, text);

    // Primer comentario con URL
    if (url) {
      log('Comentario URL en página...');
      await addComment(page, url);
    }

    results.page = { status: 'ok', slug: slug };
    log('OK página ' + slug);

  } catch(err) {
    results.page = { status: 'error', slug: slug, message: err.message };
    log('ERROR página ' + slug + ': ' + err.message);
    try { await shot(page, 'page_' + slug + '_FATAL'); } catch(e) {}
  }
}

// ─── Comentario con URL ────────────────────────────────────────────────────
async function addComment(page, url) {
  await sleep(2000);
  var sels = [
    '[aria-label="Escribe un comentario"]',
    '[aria-label="Write a comment"]',
    '[aria-label*="comentario"]',
    '[contenteditable="true"][role="textbox"]'
  ];
  for (var i = 0; i < sels.length; i++) {
    try {
      var el = page.locator(sels[i]).first();
      if (await el.count() > 0) {
        await el.click();
        await sleep(400);
        await page.keyboard.type(url, { delay: 20 });
        await sleep(400);
        await page.keyboard.press('Enter');
        log('Comentario URL OK');
        return;
      }
    } catch(e) {}
  }
  log('AVISO: Comentario URL no añadido');
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async function() {
  log('=== GuiaCrucerista — Playwright Facebook ===');
  log('Grupos: ' + (groupIds.join(', ') || 'ninguno'));
  log('Página: ' + (pageSlug || 'ninguna'));
  log('Texto (primeros 60 chars): ' + postText.substring(0, 60) + '...');

  var browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  var context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'es-ES'
  });
  var page = await context.newPage();

  try {
    await loadCookies(context);
    var loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      await login(page);
      await saveCookies(context);
    } else {
      log('Sesion activa, sin necesidad de login');
    }

    // Publicar en grupos
    for (var g = 0; g < groupIds.length; g++) {
      await postToGroup(page, groupIds[g], postText, postUrl);
      if (g < groupIds.length - 1) {
        var delay = 30000 + Math.floor(Math.random() * 60000); // 30-90s entre grupos
        log('Esperando ' + Math.round(delay / 1000) + 's antes del siguiente grupo (anti-ban)...');
        await sleep(delay);
      }
    }

    // Publicar en página
    if (pageSlug) {
      if (groupIds.length > 0) {
        var pageDelay = 30000 + Math.floor(Math.random() * 60000);
        log('Esperando ' + Math.round(pageDelay / 1000) + 's antes de la página (anti-ban)...');
        await sleep(pageDelay);
      }
      await postToPage(page, pageSlug, postText, postUrl);
    }

  } catch(err) {
    log('FATAL: ' + err.message);
  }

  await browser.close();

  var groupsOk  = Object.values(results.groups).every(function(r) { return r.status === 'ok'; });
  var pageOk    = !pageSlug || (results.page && results.page.status === 'ok');
  var allOk     = groupsOk && pageOk;

  var output = {
    success:   allOk,
    groups:    results.groups,
    page:      results.page,
    timestamp: new Date().toISOString()
  };

  console.log(JSON.stringify(output));
  process.exit(allOk ? 0 : 1);
})();
