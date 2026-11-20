/**
 * Linux hosting adapter for iOS Location Spoofer Web.
 * Original project: https://github.com/akudamatata/iOS-Location-Spoofer-Web
 * Licensed under CC BY-NC-SA 4.0; retain the original attribution.
 */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, stat, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as verify from './functions/verify.js';
import * as location from './functions/loc.json.js';
import * as set from './functions/set.js';
import * as favorites from './functions/favorites/index.js';
import * as favorite from './functions/favorites/[id].js';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(root, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

// Each write replaces the complete file atomically. API requests are serialized
// below so the original handlers' read/modify/write operations cannot overlap.
async function openStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = resolve(directory, 'store.json');
  let data = {};
  try {
    data = JSON.parse(await readFile(filename, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid data store');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    async get(key, options) {
      const value = data[key];
      if (value === undefined) return null;
      return options?.type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) {
      const updated = { ...data, [key]: value };
      const temp = filename + '.' + randomUUID() + '.tmp';
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(updated));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, filename);
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      data = updated;
    }
  };
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('Expected an object'), { status: 400 });
  return data;
}

function validCoordinates(data, requireCoordinates = false) {
  for (const [key, min, max] of [
    ['latitude', -90, 90], ['longitude', -180, 180],
    ['altitude', -12000, 100000], ['horizontalAccuracy', 0, 10000000], ['verticalAccuracy', 0, 10000000]
  ]) {
    const value = data[key];
    if (value == null && !(requireCoordinates && (key === 'latitude' || key === 'longitude'))) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return false;
  }
  return data.name === undefined || typeof data.name === 'string';
}

export async function startServer(options = {}) {
  const token = options.token ?? process.env.TOKEN;
  if (!token || token.length < 16) throw new Error('TOKEN must contain at least 16 characters');
  const external = new URL(options.publicUrl ?? process.env.PUBLIC_URL);
  if (!['http:', 'https:'].includes(external.protocol) || external.pathname !== '/' || external.search || external.hash || external.username || external.password) {
    throw new Error('PUBLIC_URL must be an HTTP(S) origin without a path');
  }
  const origin = external.origin;
  const tokenHash = createHash('sha256').update(token).digest();
  const env = {
    TOKEN: token,
    AMAP_KEY: options.amapKey ?? process.env.AMAP_KEY ?? '',
    SPOOFER_DATA: await openStore(resolve(options.dataDir ?? process.env.DATA_DIR ?? resolve(root, 'data')))
  };
  const index = await readFile(resolve(publicDir, 'index.html'), 'utf8');
  const template = await readFile(resolve(publicDir, 'ios-location-spoofer.sgmodule'), 'utf8');
  const config = JSON.stringify({ hasToken: true, amapKey: env.AMAP_KEY }).replaceAll('<', '\\u003c');
  const html = index.replace('</head>', `<script>window.__CFG__=${config};</script></head>`);
  let queue = Promise.resolve();

  async function route(request) {
    const url = new URL(request.url, origin);
    const pathname = decodeURIComponent(url.pathname);
    const handlers = { '/verify': verify, '/loc.json': location, '/set': set, '/favorites': favorites };
    const favoriteId = pathname.match(/^\/favorites\/([a-z0-9-]+)$/);
    const handler = handlers[pathname] ?? (favoriteId ? favorite : null);
    const isModule = pathname === '/ios-location-spoofer.sgmodule';
    if (handler || isModule) {
      const supplied = url.searchParams.get('token') ?? request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!timingSafeEqual(tokenHash, createHash('sha256').update(supplied).digest())) return json({ error: 'unauthorized' }, 401);
      if (isModule) {
        if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method not allowed' }, 405);
        const content = template.replaceAll('https://你的域名', origin).replaceAll('你的Token', encodeURIComponent(token));
        return new Response(content, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      const method = request.method === 'HEAD' ? 'GET' : request.method;
      const name = 'onRequest' + method[0] + method.slice(1).toLowerCase();
      if (!handler[name]) return json({ error: 'method not allowed' }, 405);
      let body;
      if (method === 'POST') {
        const data = await readBody(request);
        if (!validCoordinates(data, pathname === '/favorites')) return json({ error: 'invalid coordinates or name' }, 400);
        body = JSON.stringify(data);
      }
      url.searchParams.set('token', token);
      const context = {
        request: new Request(url, { method, body, headers: { 'Content-Type': 'application/json' } }),
        env, params: { id: favoriteId?.[1] }
      };
      const result = queue.then(() => handler[name](context));
      queue = result.catch(() => {});
      return await result;
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method not allowed' }, 405);
    if (pathname === '/healthz') return json({ ok: true });
    if (pathname === '/' || pathname === '/index.html') return new Response(html, { headers: { 'Content-Type': types['.html'], 'Cache-Control': 'no-store' } });
    const filename = resolve(publicDir, '.' + pathname);
    if (!filename.startsWith(publicDir + sep) || pathname.split('/').some(part => part.startsWith('.'))) return json({ error: 'not found' }, 404);
    try {
      if (!(await stat(filename)).isFile()) return json({ error: 'not found' }, 404);
      return new Response(await readFile(filename), { headers: { 'Content-Type': types[extname(filename)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=300' } });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return json({ error: 'not found' }, 404);
      throw error;
    }
  }

  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (request, response) => {
    try {
      const result = await route(request);
      const headers = Object.fromEntries(result.headers);
      delete headers['access-control-allow-origin'];
      headers['X-Content-Type-Options'] = 'nosniff';
      headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
      headers['X-Frame-Options'] = 'DENY';
      const body = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, { ...headers, 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const status = error.status ?? (error instanceof URIError ? 400 : 500);
      if (status === 500) console.error('Request failed:', error.code ?? error.name);
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: status === 500 ? 'internal error' : status === 400 ? 'bad request' : error.message }));
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? Number(process.env.PORT ?? 8091), options.host ?? process.env.HOST ?? '127.0.0.1', accept);
  });
  return server;
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer();
  console.log(`GPS server listening on ${server.address().address}:${server.address().port}`);
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
