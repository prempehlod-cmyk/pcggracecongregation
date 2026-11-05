// Local preview only (not used on Netlify): serves public/ and the API with data kept in dev-data.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../netlify/lib/core.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.DEV_DATA ? path.resolve(process.env.DEV_DATA) : path.join(root, 'dev-data.json');
let mem = {}; try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
const persist = () => fs.writeFileSync(file, JSON.stringify(mem));
const store = { get: async (k) => (k in mem ? structuredClone(mem[k]) : null), set: async (k, v) => { mem[k] = structuredClone(v); persist(); }, del: async (k) => { delete mem[k]; persist(); } };
const handle = createHandler(store, { ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'ChangeMe#2026' });
const port = Number(process.env.PORT || 8888);

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const r = await handle(new Request('http://' + req.headers.host + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), { ip: req.socket.remoteAddress });
      const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
      res.writeHead(r.status, h); return res.end(Buffer.from(await r.arrayBuffer()));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(root, 'public', 'index.html')));
  } catch (e) { console.error(e); res.writeHead(500); res.end('error'); }
}).listen(port, () => console.log(`Preview on http://localhost:${port}  (first admin password: ${process.env.ADMIN_PASSWORD || 'ChangeMe#2026'})`));
