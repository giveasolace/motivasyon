// Motive push sunucusu (Cloudflare Worker)
// - POST /subscribe   {sub, prefs}  → aboneliği KV'ye kaydeder / günceller
// - POST /unsubscribe {endpoint}    → siler
// - POST /test        {endpoint}    → hemen bir push gönderir
// - cron (her saat başı) → İstanbul saatine göre zamanı gelen aboneliklere push gönderir
// Push'lar payload'sızdır; bildirim metnini telefondaki service worker kendi verisinden kurar.

const ORIGINS = ['https://giveasolace.github.io', 'http://localhost:8765'];
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.mozilla\.com$/, /\.notify\.windows\.com$/];
const TZ_OFFSET = 3; // Türkiye: UTC+3, yaz saati yok

const cors = o => ({
  'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});
const json = (d, status, o) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...cors(o) } });

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function keyOf(endpoint) {
  return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
}
function validSub(sub) {
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some(r => r.test(u.hostname));
  } catch { return false; }
}

let signKey;
async function vapidJWT(aud, env) {
  signKey ||= await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, new TextEncoder().encode(unsigned));
  return unsigned + '.' + b64u(sig);
}
async function sendPush(sub, env) {
  const jwt = await vapidJWT(new URL(sub.endpoint).origin, env);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: { TTL: '3600', Urgency: 'high', 'Content-Length': '0', Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}` },
  });
}

export default {
  async fetch(req, env) {
    const o = req.headers.get('Origin') || '';
    const path = new URL(req.url).pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(o) });
    if (req.method !== 'POST') return json({ ok: true, service: 'motive-push' }, 200, o);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400, o); }

    if (path === '/subscribe') {
      const sub = body.sub;
      if (!sub || !validSub(sub) || !sub.keys) return json({ error: 'geçersiz abonelik' }, 400, o);
      const p = body.prefs || {};
      const hour = v => (Number.isInteger(v) && v >= 0 && v < 24 ? v : null);
      const prefs = { sum: hour(p.sum) ?? 22, morn: hour(p.morn) ?? 9, mid: hour(p.mid) ?? 16, on: { sum: !!p.on?.sum, morn: !!p.on?.morn, mid: !!p.on?.mid } };
      await env.SUBS.put(await keyOf(sub.endpoint), JSON.stringify({ sub: { endpoint: sub.endpoint, keys: sub.keys }, prefs, at: Date.now() }));
      return json({ ok: true }, 200, o);
    }
    if (path === '/unsubscribe') {
      if (body.endpoint) await env.SUBS.delete(await keyOf(body.endpoint));
      return json({ ok: true }, 200, o);
    }
    if (path === '/test') {
      const rec = body.endpoint && (await env.SUBS.get(await keyOf(body.endpoint), 'json'));
      if (!rec) return json({ error: 'abonelik bulunamadı' }, 404, o);
      const r = await sendPush(rec.sub, env);
      return json({ ok: r.ok, status: r.status, detail: r.ok ? '' : (await r.text()).slice(0, 200) }, r.ok ? 200 : 502, o);
    }
    return json({ error: 'not found' }, 404, o);
  },

  async scheduled(event, env) {
    const h = (new Date(event.scheduledTime).getUTCHours() + TZ_OFFSET) % 24;
    let cursor;
    do {
      const list = await env.SUBS.list({ cursor });
      cursor = list.list_complete ? null : list.cursor;
      for (const k of list.keys) {
        const rec = await env.SUBS.get(k.name, 'json');
        if (!rec) continue;
        const p = rec.prefs || {};
        if (!['sum', 'morn', 'mid'].some(t => p.on?.[t] && p[t] === h)) continue;
        const r = await sendPush(rec.sub, env);
        console.log('push', h, r.status);
        if (r.status === 404 || r.status === 410) await env.SUBS.delete(k.name);
      }
    } while (cursor);
  },
};
