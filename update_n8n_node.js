#!/usr/bin/env node
/**
 * update_n8n_node.js
 * Actualiza el nodo "Fetch y Parsear RSS" en n8n via REST API interna
 * Uso: N8N_API_KEY=xxx node update_n8n_node.js
 */

const https = require('https');
const http  = require('http');

const N8N_HOST    = process.env.N8N_HOST    || 'localhost';
const N8N_PORT    = process.env.N8N_PORT    || 5678;
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const WORKFLOW_ID = process.env.WORKFLOW_ID || 'MA26X0UAvQM85gcj';
const USE_HTTPS   = process.env.USE_HTTPS   === 'true';

const NEW_CODE = `const feeds = [
  { company:'msc',    name:'MSC Cruceros',      rssUrl:'https://news.google.com/rss/search?q=MSC+cruceros&hl=es&gl=ES&ceid=ES:es',                  groups:'811550587597467',  page:'guiacrucerista' },
  { company:'royal',  name:'Royal Caribbean',   rssUrl:'https://news.google.com/rss/search?q=Royal+Caribbean+cruceros&hl=es&gl=ES&ceid=ES:es',         groups:'1116074769675601', page:'guiacrucerista' },
  { company:'costa',  name:'Costa Cruceros',    rssUrl:'https://news.google.com/rss/search?q=Costa+Cruceros&hl=es&gl=ES&ceid=ES:es',                   groups:'1882092085657041', page:'guiacrucerista' },
  { company:'general',name:'Cruceros General',  rssUrl:'https://news.google.com/rss/search?q=cruceros+Mediterraneo+noticias&hl=es&gl=ES&ceid=ES:es',    groups:'',                page:'guiacrucerista' },
  { company:'fluvial',name:'Cruceros Fluviales',rssUrl:'https://news.google.com/rss/search?q=cruceros+fluviales+Europa&hl=es&gl=ES&ceid=ES:es',          groups:'',                page:'guiacrucerista' }
];

const getTag = (str, tag) => {
  const s = str.indexOf('<' + tag + '>');
  const e = str.indexOf('</' + tag + '>');
  if (s < 0 || e < 0) return '';
  return str.substring(s + tag.length + 2, e)
    .replace('<![CDATA[', '').replace(']]>', '')
    .replace(/<[^>]+>/g, '').trim();
};

const allItems = [];
for (const feed of feeds) {
  try {
    const response = await $http.get(feed.rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 GuiaCrucerista/1.0' },
      responseType: 'text'
    });
    const xml = String(response.data);
    console.log('Feed ' + feed.company + ' bytes: ' + xml.length);
    const parts = xml.split('<item>');
    for (let i = 1; i < Math.min(parts.length, 3); i++) {
      const item = parts[i].split('</item>')[0];
      const title   = getTag(item, 'title');
      const link    = getTag(item, 'link');
      const pubDate = getTag(item, 'pubDate');
      const desc    = getTag(item, 'description').substring(0, 300);
      if (title && link) {
        allItems.push({ json: { title, link, pubDate, desc, company: feed.company, feedName: feed.name, groups: feed.groups, page: feed.page } });
      }
    }
  } catch(e) { console.log('Error ' + feed.company + ': ' + e.message); }
}
return allItems.length ? allItems : [{ json: { skip: true, reason: 'Sin noticias' } }];`;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: N8N_HOST,
      port:     N8N_PORT,
      path,
      method,
      headers: {
        'X-N8N-API-KEY':  N8N_API_KEY,
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      },
      rejectUnauthorized: false
    };
    const mod = USE_HTTPS ? https : http;
    const req = mod.request(opts, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch(e) { resolve({ status: res.statusCode, body: out }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('=== Actualizando nodo RSS en n8n ===');
  console.log('Workflow ID:', WORKFLOW_ID);

  // 1. GET workflow
  console.log('\n1. Obteniendo workflow...');
  const get = await request('GET', `/api/v1/workflows/${WORKFLOW_ID}`);
  if (get.status !== 200) {
    console.error('ERROR GET:', get.status, JSON.stringify(get.body).substring(0, 300));
    process.exit(1);
  }
  const wf = get.body;
  console.log('   Workflow:', wf.name);
  console.log('   Nodos:', wf.nodes?.length || 0);

  // 2. Encontrar nodo
  const node = wf.nodes?.find(n => n.name === 'Fetch y Parsear RSS');
  if (!node) {
    console.error('ERROR: Nodo "Fetch y Parsear RSS" no encontrado');
    console.log('Nodos disponibles:', wf.nodes?.map(n => n.name).join(', '));
    process.exit(1);
  }
  console.log('\n2. Nodo encontrado:', node.name);

  // 3. Actualizar código
  node.parameters.jsCode = NEW_CODE;
  console.log('   Código actualizado (', NEW_CODE.length, 'chars)');

  // 4. PATCH workflow
  console.log('\n3. Guardando en n8n...');
  const patch = await request('PUT', `/api/v1/workflows/${WORKFLOW_ID}`, wf);
  if (patch.status === 200) {
    console.log('✅ ÉXITO — Workflow guardado correctamente');
    console.log('   ID:', patch.body.id, '| Nombre:', patch.body.name);
  } else {
    console.error('ERROR PATCH:', patch.status, JSON.stringify(patch.body).substring(0, 500));
    process.exit(1);
  }
}

main().catch(err => { console.error('Error fatal:', err.message); process.exit(1); });
