#!/usr/bin/env node
/**
 * publisher-api.js — GuiaCrucerista
 * Mini API HTTP local que ejecuta el script Playwright
 * Corre en localhost:3456 — n8n le hace peticiones POST
 *
 * Uso:
 *   node publisher-api.js
 *
 * Endpoint:
 *   POST http://localhost:3456/publish
 *   Headers: x-api-token: <API_TOKEN del .env>
 *   Body JSON: { text, url, groups, page }
 *
 * GET http://localhost:3456/health  → { status: 'ok' }
 */

const http = require('http');
const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');

const SCRIPTS_DIR = path.join(__dirname);
const ENV_FILE    = path.join(SCRIPTS_DIR, '.env');
const SCRIPT_PATH = path.join(SCRIPTS_DIR, 'playwright_facebook_grupos.js');
const PORT        = process.env.PUBLISHER_PORT || 3456;
const API_TOKEN   = process.env.API_TOKEN      || 'guiacrucerista-2026';

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }

// ─── Parsear body JSON ──────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch(e) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

// ─── Ejecutar script Playwright ─────────────────────────────────────────────
function runPlaywright(postData) {
  return new Promise((resolve) => {
    const tmpFile = '/tmp/fb_pub_' + Date.now() + '.json';
    fs.writeFileSync(tmpFile, JSON.stringify(postData));

    const cmd = `export $(cat ${ENV_FILE} | xargs) && node ${SCRIPT_PATH} --input ${tmpFile}`;
    log('Ejecutando: ' + cmd.substring(0, 80) + '...');

    exec(cmd, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch(e) {}

      if (stderr) log('STDERR: ' + stderr.substring(0, 500));

      if (error && !stdout) {
        resolve({ success: false, error: error.message, stderr: stderr.substring(0, 500) });
        return;
      }

      // El script imprime JSON en stdout
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      try {
        const result = JSON.parse(lastLine);
        resolve(result);
      } catch(e) {
        resolve({ success: !!stdout && !error, stdout: lastLine, error: e.message });
      }
    });
  });
}

// ─── Servidor HTTP ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  }

  // Publish endpoint
  if (req.method === 'POST' && req.url === '/publish') {
    // Auth
    const token = req.headers['x-api-token'];
    if (token !== API_TOKEN) {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    let body;
    try { body = await parseBody(req); }
    catch(e) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: e.message }));
    }

    const { text, url, groups, page } = body;
    if (!text) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'Campo "text" requerido' }));
    }

    const postData = {
      text,
      url:    url    || '',
      groups: Array.isArray(groups) ? groups : (groups ? groups.split(',').map(g => g.trim()).filter(Boolean) : []),
      page:   page   || ''
    };

    log('Publicando → grupos: ' + postData.groups.join(',') + ' | página: ' + postData.page);
    const result = await runPlaywright(postData);
    log('Resultado: ' + JSON.stringify(result).substring(0, 200));

    res.writeHead(result.success ? 200 : 500);
    return res.end(JSON.stringify(result));
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  log('=== GuiaCrucerista Publisher API ===');
  log('Escuchando en http://127.0.0.1:' + PORT);
  log('API_TOKEN: ' + API_TOKEN.substring(0, 8) + '...');
  log('Script: ' + SCRIPT_PATH);
});

server.on('error', (err) => {
  log('ERROR servidor: ' + err.message);
  process.exit(1);
});
