import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { store } from './storage.mjs';

const environment = process.env.APP_ENV ?? 'Local';
const version = '1.1.0';
const port = Number(process.env.PORT ?? 3000);
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
].map(([route, [name, contentType]]) => [route, [readFileSync(new URL('./public/' + name, import.meta.url)), contentType]]));

function send(res, status, data, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error();
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function describe(state) {
  return { ...state, environment, database: store.database };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const file = files.get(url.pathname);
    if (req.method === 'GET' && file) return send(res, 200, ...file);
    if (req.method === 'GET' && url.pathname === '/health') {
      await store.check();
      return send(res, 200, { status: 'ok', database: store.database, environment, version });
    }
    if (req.method === 'GET' && url.pathname === '/api/account') return send(res, 200, describe(await store.account()));
    if (req.method !== 'POST' || url.pathname !== '/api/movements') return send(res, 404, { error: 'Ruta inexistente.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Origen no permitido.' });
    let request;
    try {
      request = await readBody(req);
    } catch {
      return send(res, 400, { error: 'No se pudo leer la operación.' });
    }
    const { type, amount } = request ?? {};
    if (!['deposit', 'withdraw'].includes(type) || !Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000) {
      return send(res, 400, { error: 'Ingresa un monto entre $0.01 y $10,000.00.' });
    }
    const result = await store.record(type, amount);
    return result.error ? send(res, 422, result) : send(res, 201, describe(result));
  } catch (error) {
    console.error('Error de aplicación:', error.code ?? error.name);
    if (!res.headersSent && !res.destroyed) send(res, 500, { error: 'No se pudo completar la operación.' });
  }
});
server.requestTimeout = 15000;
server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log('Cajero U3 listo en el puerto ' + port));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => void store.close()));
