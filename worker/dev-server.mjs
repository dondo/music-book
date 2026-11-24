// Runs the Worker locally with an in-memory KV, for testing:  node worker/dev-server.mjs [port]
import http from 'node:http';
import worker from './music-book-sync.js';

class KV {
  constructor() { this.m = new Map(); }
  async get(k) { const e = this.m.get(k); return e ? (typeof e.v === 'string' ? e.v : e.v.slice(0)) : null; }
  async getWithMetadata(k) { const e = this.m.get(k); return { value: e ? e.v.slice(0) : null, metadata: e ? e.meta : null }; }
  async put(k, v, o) { this.m.set(k, { v, meta: o && o.metadata }); }
  async delete(k) { this.m.delete(k); }
}
const env = { STORE: new KV() };
const port = +process.argv[2] || 8787;
http.createServer(async (rq, rs) => {
  const chunks = []; for await (const c of rq) chunks.push(c);
  const body = Buffer.concat(chunks);
  const r = new Request('http://localhost:' + port + rq.url, { method: rq.method, headers: rq.headers, body: ['GET', 'HEAD'].includes(rq.method) ? undefined : body });
  const res = await worker.fetch(r, env);
  rs.writeHead(res.status, Object.fromEntries(res.headers));
  rs.end(Buffer.from(await res.arrayBuffer()));
}).listen(port, () => console.log('worker on ' + port));
globalThis.__env = env;
