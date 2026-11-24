/* Music Book sync Worker (Cloudflare Workers + KV).
 *
 * It only ever stores encrypted bytes: the app encrypts everything in the browser, so nothing here is readable, and nothing here is a secret.
 * It is a separate Worker from the Music Theory app's (its own URL and its own key prefix "mb:" in the KV namespace), so the two apps share
 * no credentials and no data.
 *
 * Routes (every request needs  Authorization: Bearer <64 hex token>):
 *   GET    /v1/<id>/<name>     the object (404 when missing; 403 when <id> belongs to someone else's token)
 *   PUT    /v1/<id>/<name>     store the object; the first write claims <id> for that token
 *   DELETE /v1/<id>/<name>     remove it
 * <id>    64 hex characters (derived in the browser from the name + passphrase)
 * <name>  "manifest" (the index; PUT may carry  X-Rev: <the revision you last read>  and is refused with 409 if someone else wrote since)
 *         "a.<fileId>.<u>"  (a score's markings, as of change time u)    "f.<fileId>.<n>"  (chunk n of a score file)
 */
const ALLOWED = ['https://dondo.github.io', 'null'];     // where the app is served from ('null' = a page opened from a file:// path)
const MAX = 8 * 1024 * 1024;                              // bytes per object (KV allows 25 MiB)
const NAME = /^(manifest|a\.[A-Za-z0-9_-]{6,64}\.[0-9]{1,16}|f\.[A-Za-z0-9_-]{6,64}\.[0-9]{1,5})$/;

async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin');
    const okOrigin = origin === null ? true : ALLOWED.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': origin && okOrigin ? origin : ALLOWED[0], 'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Rev',
      'Access-Control-Expose-Headers': 'X-Rev',
    };
    const reply = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...cors, ...extra } });
    if (req.method === 'OPTIONS') return reply(null, 204);
    if (!okOrigin) return reply('forbidden', 403);

    const m = new URL(req.url).pathname.match(/^\/v1\/([0-9a-f]{64})\/([^/]+)$/);
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    if (!m || !NAME.test(m[2]) || !/^[0-9a-f]{64}$/.test(token)) return reply('bad request', 400);
    const id = m[1], name = m[2], tokenHash = await sha(token);

    const owner = await env.STORE.get('mb:t:' + id);
    if (owner && owner !== tokenHash) return reply('forbidden', 403);
    const key = 'mb:o:' + id + ':' + name;

    if (req.method === 'GET') {
      if (!owner) return reply('not found', 404);
      const r = await env.STORE.getWithMetadata(key, 'arrayBuffer');
      if (r.value === null) return reply('not found', 404);
      return reply(r.value, 200, { 'Content-Type': 'application/octet-stream', 'X-Rev': String((r.metadata && r.metadata.rev) || 0) });
    }
    if (req.method === 'PUT') {
      const body = await req.arrayBuffer();
      if (body.byteLength > MAX) return reply('too large', 413);
      let rev = 0;
      if (name === 'manifest') {
        const cur = await env.STORE.getWithMetadata(key, 'arrayBuffer');
        const have = (cur.metadata && cur.metadata.rev) || 0;
        const want = req.headers.get('X-Rev');
        if (want !== null && Number(want) !== have) return reply('conflict', 409, { 'X-Rev': String(have) });
        rev = have + 1;
      }
      if (!owner) await env.STORE.put('mb:t:' + id, tokenHash);          // the first write claims the ID
      await env.STORE.put(key, body, rev ? { metadata: { rev } } : undefined);
      return reply('ok', 200, { 'X-Rev': String(rev) });
    }
    if (req.method === 'DELETE') {
      if (!owner) return reply('not found', 404);
      await env.STORE.delete(key);
      return reply('ok');
    }
    return reply('method not allowed', 405);
  },
};
