#!/usr/bin/env node
/**
 * playwright_facebook_grupos.js — GuiaCrucerista
 *
 * Modos de uso:
 *   1) Archivo JSON (recomendado, sin problemas de escape):
 *      node playwright_facebook_grupos.js --input /tmp/fb_post.json
 *
 *   2) Argumentos CLI:
 *      node playwright_facebook_grupos.js --text "Texto" --url "https://..." --groups "id1,id2"
 *
 * Variables de entorno (.env):
 *   FB_EMAIL    = tu@email.com
 *   FB_PASSWORD = tu_contraseña
 *   HEADLESS    = true (false para ver el navegador en local)
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

let postText, postUrl, groupIds;

const inputFile = getArg('input');
if (inputFile && fs.existsSync(inputFile)) {
  const d = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  postText = d.text   || '';
  postUrl  = d.url    || '';
  groupIds = Array.isArray(d.groups) ? d.groups : [];
} else {
  postText = getArg('text')    || '';
  postUrl  = getArg('url')     || '';
  groupIds = (getArg('groups') || '').split(',').map(function(g) { return g.trim(); }).filter(Boolean);
}

if (!postText || !groupIds.length) {
  console.error('ERROR: Proporciona --input o --text + --groups');
  process.exit(1);
}
if (!FB_EMAIL || !FB_PASSWORD) {
  console.error('ERROR: Variables FB_EMAIL y FB_PASSWORD no definidas');
  process.exit(1);
}

// ─── Utilidades ────────────────────────────────────────────────────────────
const results = {};
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
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

    // Click en compositor de publicaciones
    const composerSels = [
      '[aria-label="Crear una publicacion"]',
      '[aria-label="Crear una publicación"]',
      '[aria-label="Create a public post"]',
      '[aria-label="Crear publicacion"]',
      '[aria-label="Crear publicación"]',
      'span:text-is("Escribe algo...")',
      'span:text-is("Escribe algo")',
      'span:text-is("Write something...")',
      '[placeholder*="Escribe algo"]',
      '[placeholder*="Write something"]'
    ];

    var clicked = false;
    for (var i = 0; i < composerSels.length; i++) {
      try {
        var el = page.locator(composerSels[i]).first();
        if (await el.count() > 0) {
          await el.scrollIntoViewIfNeeded();
          await el.click({ timeout: 3000 });
          clicked = true;
          log('Composer OK: ' + composerSels[i]);
          break;
        }
      } catch(e) { log('skip: ' + composerSels[i]); }
    }

    if (!clicked) {
      log('AVISO: Composer no encontrado, probando tecla p...');
      await page.keyboard.press('p');
    }

    await sleep(2500);
    await shot(page, groupId + '_2_after_click');

    // Campo de texto del modal
    var textSels = [
      'div[role="dialog"] [contenteditable="true"]',
      'div[role="dialog"] [role="textbox"]',
      '[contenteditable="true"][aria-label*="publicaci"]',
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"]'
    ];

    var textarea = null;
    for (var j = 0; j < textSels.length; j++) {
      try {
        var candidate = page.locator(textSels[j]).first();
        if (await candidate.count() > 0) {
          textarea = candidate;
          log('Textarea OK: ' + textSels[j]);
          break;
        }
      } catch(e) {}
    }

    if (!textarea) {
      await shot(page, groupId + '_ERROR_no_textarea');
      throw new Error('Campo de texto no encontrado. Ver debug/');
    }

    await textarea.click();
    await sleep(500);
    await textarea.type(text, { delay: 40 });
    await sleep(1500);
    await shot(page, groupId + '_3_typed');

    // Botón Publicar
    var pubSels = [
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

    var published = false;
    for (var k = 0; k < pubSels.length; k++) {
      try {
        var btn = page.locator(pubSels[k]).first();
        if (await btn.count() > 0) {
          var disabled = await btn.getAttribute('aria-disabled');
          if (disabled === 'true') { log('Btn deshabilitado: ' + pubSels[k]); continue; }
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ timeout: 5000 });
          published = true;
          log('Publicar OK: ' + pubSels[k]);
          break;
        }
      } catch(e) { log('pub skip: ' + pubSels[k]); }
    }

    if (!published) {
      await shot(page, groupId + '_ERROR_no_publish_btn');
      throw new Error('Boton Publicar no encontrado. Ver debug/');
    }

    await sleep(5000);
    await shot(page, groupId + '_4_done');
    log('URL final: ' + page.url());

    // Primer comentario con URL
    if (url) {
      log('Comentario URL...');
      await addComment(page, url);
    }

    results[groupId] = { status: 'ok' };
    log('OK grupo ' + groupId);

  } catch(err) {
    results[groupId] = { status: 'error', message: err.message };
    log('ERROR grupo ' + groupId + ': ' + err.message);
    try { await shot(page, groupId + '_FATAL'); } catch(e) {}
  }
}

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
  log('=== GuiaCrucerista Playwright ===');
  log('Grupos: ' + groupIds.join(', '));
  log('Texto: ' + postText.substring(0, 60) + '...');

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
      log('Sesion activa');
    }

    for (var g = 0; g < groupIds.length; g++) {
      await postToGroup(page, groupIds[g], postText, postUrl);
      await sleep(4000);
    }
  } catch(err) {
    log('FATAL: ' + err.message);
  }

  await browser.close();

  var output = {
    success: Object.values(results).every(function(r) { return r.status === 'ok'; }),
    groups:  results,
    timestamp: new Date().toISOString()
  };

  console.log(JSON.stringify(output));
  process.exit(output.success ? 0 : 1);
})();
