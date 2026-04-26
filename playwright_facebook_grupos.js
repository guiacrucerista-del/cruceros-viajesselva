const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const COOKIES_FILE = path.join(__dirname, '.fb_session.json');
const DEBUG_DIR    = path.join(__dirname, 'debug');
const FB_EMAIL     = process.env.FB_EMAIL;
const FB_PASSWORD  = process.env.FB_PASSWORD;
const HEADLESS     = process.env.HEADLESS !== 'false';

if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

const argv   = process.argv.slice(2);
function getArg(k) { const i = argv.indexOf('--' + k); return i !== -1 ? argv[i + 1] : null; }

let postText, postUrl, groupIds, pageSlug;
const inputFile = getArg('input');
if (inputFile && fs.existsSync(inputFile)) {
  const d = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  postText  = d.text   || '';
  postUrl   = d.url    || '';
  groupIds  = Array.isArray(d.groups) ? d.groups : (d.groups || '').split(',').map(g => g.trim()).filter(Boolean);
  pageSlug  = d.page   || process.env.FB_PAGE || '';
} else {
  postText  = getArg('text')    || '';
  postUrl   = getArg('url')     || '';
  groupIds  = (getArg('groups') || process.env.FB_GROUPS || '').split(',').map(g => g.trim()).filter(Boolean);
  pageSlug  = getArg('page')    || process.env.FB_PAGE   || '';
}

const results = { groups: {}, page: null };
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.error('[' + new Date().toISOString() + '] ' + msg); }
async function shot(page, label) {
  try { await page.screenshot({ path: path.join(DEBUG_DIR, Date.now() + '_' + label + '.png') }); } catch(e) {}
}

async function loadCookies(ctx) {
  if (!fs.existsSync(COOKIES_FILE)) return false;
  await ctx.addCookies(JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')));
  return true;
}

async function postToGroup(page, groupId, text, url) {
  log('--- Grupo ' + groupId + ' ---');
  try {
    await page.goto('https://www.facebook.com/groups/' + groupId, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500);

    await page.evaluate(() => {
      document.querySelectorAll('[aria-label="Cerrar"],[aria-label="Close"]').forEach(el => el.click());
    });
    await page.keyboard.press('Escape');
    await sleep(1000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(1000);

    const composerClicked = await page.evaluate(() => {
      const candidates = document.querySelectorAll('div[role="button"]');
      const keywords = ['¿qué', 'escribe algo', 'write something', 'pensando', 'publicación anónima'];
      for (const el of candidates) {
        if (el.closest('article, div[role="article"]')) continue;
        const txt = (el.textContent || '').toLowerCase().trim();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (keywords.some(k => txt.startsWith(k) || aria.includes(k))) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return el.textContent.trim().substring(0, 60);
        }
      }
      for (const el of candidates) {
        if (el.closest('article, div[role="article"]')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 30) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return '(fallback): ' + el.textContent.trim().substring(0, 60);
        }
      }
      return null;
    });

    if (!composerClicked) {
      log('Compositor no encontrado JS, URL fallback...');
      await page.goto('https://www.facebook.com/groups/' + groupId + '/?create_post=true', { waitUntil: 'networkidle' });
      await sleep(2000);
      await page.keyboard.press('Escape');
    }
    await sleep(2500);

    const textboxFound = await page.evaluate(() => {
      const boxes = document.querySelectorAll('div[role="textbox"]');
      for (const box of boxes) {
        const placeholder = (box.getAttribute('aria-placeholder') || '').toLowerCase();
        const label = (box.getAttribute('aria-label') || '').toLowerCase();
        if (placeholder.includes('comenta') || label.includes('comenta')) continue;
        box.focus();
        box.click();
        return placeholder || label || '(textbox sin label)';
      }
      return null;
    });

    if (!textboxFound) throw new Error('No se encontró el textbox de publicación');
    await sleep(800);

    await page.keyboard.type(text, { delay: 20 });
    await sleep(2000);

    const publishClicked = await page.evaluate(() => {
      const keywords = ['publicar', 'post'];
      const all = [...document.querySelectorAll('div[role="button"],button')];
      for (const el of all) {
        const txt = (el.textContent || '').toLowerCase().trim();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (keywords.some(k => txt === k || aria === k)) {
          if (el.getAttribute('aria-disabled') === 'true') continue;
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return txt || aria;
        }
      }
      return null;
    });

    if (!publishClicked) throw new Error('Boton Publicar no encontrado');
    await sleep(6000);

    if (url) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(3000);
      const commentBoxFound = await page.evaluate(() => {
        const articles = document.querySelectorAll('div[role="article"]');
        if (!articles.length) return false;
        const boxes = articles[0].querySelectorAll('div[role="textbox"]');
        for (const box of boxes) {
          const ph = (box.getAttribute('aria-placeholder') || '').toLowerCase();
          if (ph.includes('comenta')) { box.focus(); box.click(); return true; }
        }
        return false;
      });
      if (commentBoxFound) {
        await sleep(800);
        await page.keyboard.type(url, { delay: 15 });
        await sleep(1000);
        await page.keyboard.press('Enter');
        await sleep(3000);
      }
    }

    results.groups[groupId] = { status: 'ok' };
    log('OK grupo ' + groupId);
  } catch(err) {
    results.groups[groupId] = { status: 'error', message: err.message };
    log('ERROR grupo ' + groupId + ': ' + err.message);
    await shot(page, groupId + '_FATAL');
  }
}

(async function() {
  const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', locale: 'es-ES' });
  const page = await context.newPage();
  
  try {
    await loadCookies(context);
    for (let g = 0; g < groupIds.length; g++) {
      await postToGroup(page, groupIds[g], postText, postUrl);
    }
  } catch(err) { log('FATAL: ' + err.message); }
  
  await browser.close();
  const allOk = Object.values(results.groups).every(r => r.status === 'ok');
  console.log(JSON.stringify({ success: allOk, groups: results.groups }));
  process.exit(allOk ? 0 : 1);
})();
