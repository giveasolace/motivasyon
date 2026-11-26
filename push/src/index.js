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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// ---------- Fiyatlar (Cüzdan) ----------
const SYM_RE = /^[A-Z0-9.=^-]{1,15}$/;
const OZ = 31.1034768;
const VIRTUAL = { GRAM: 'GC=F', CEYREK: 'GC=F', YARIM: 'GC=F', TAM: 'GC=F', ATA: 'GC=F', GUMUS: 'SI=F' };
const GOLD_PURE = { GRAM: 1, CEYREK: 1.6065, YARIM: 3.213, TAM: 6.426, ATA: 6.6152 }; // saf altın gramı (22 ayar sikkeler; Ata 7,216 g × 0,9167)
async function yahoo(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl: 600, cacheEverything: true } });
  if (!r.ok) return null;
  const m = (await r.json())?.chart?.result?.[0]?.meta;
  return m && typeof m.regularMarketPrice === 'number' ? { p: m.regularMarketPrice, prev: m.chartPreviousClose, cur: m.currency } : null;
}
async function prices(syms) {
  const need = new Set(['USDTRY=X']);
  for (const s of syms) need.add(VIRTUAL[s] || s);
  const raw = {};
  await Promise.all([...need].map(async s => { raw[s] = await yahoo(s).catch(() => null); }));
  const usd = raw['USDTRY=X']?.p, usdPrev = raw['USDTRY=X']?.prev;
  const out = {};
  for (const s of syms) {
    const r = raw[VIRTUAL[s] || s];
    if (!r) { out[s] = null; continue; }
    let p = r.p, prev = r.prev;
    if (VIRTUAL[s]) { const g = GOLD_PURE[s] || 1; p = r.p / OZ * usd * g; prev = r.prev && usdPrev ? r.prev / OZ * usdPrev * g : null; }
    else if (r.cur === 'USD' && s !== 'USDTRY=X') { p = r.p * usd; prev = r.prev && usdPrev ? r.prev * usdPrev : null; }
    else if (r.cur && r.cur !== 'TRY' && r.cur !== 'USD') { out[s] = { p: null, err: 'kur desteklenmiyor: ' + r.cur }; continue; }
    out[s] = { p: Math.round(p * 10000) / 10000, chg: prev ? Math.round((p / prev - 1) * 10000) / 100 : null };
  }
  return out;
}

// h: İstanbul saati, mi: dakika, day: YYYY-MM-DD, keys: son 5 dakikanın 'YYYY-MM-DDTHH:MM' anahtarları
export function isDue(p, h, day, mi = 0, keys = []) {
  const top = mi < 5; // saat başı bildirimleri sadece saatin ilk tetiklemesinde
  if (p.app === 'cuzdan') return top && p.hour === h && (p.dates || []).includes(day);
  if (top && ['sum', 'morn', 'mid'].some(t => p.on?.[t] && p[t] === h)) return true;
  return Array.isArray(p.pt) && p.pt.some(x => keys.includes(x));
}
function windowKeys(local) { // local: İstanbul saatine kaydırılmış Date (UTC alanları yerel saati gösterir)
  const out = [];
  for (let i = 0; i < 5; i++) { const d = new Date(local.getTime() - i * 60000); out.push(d.toISOString().slice(0, 16)); }
  return out;
}

export default {
  async fetch(req, env) {
    const o = req.headers.get('Origin') || '';
    const path = new URL(req.url).pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(o) });
    // Cüzdan gelen kutusu: içerik uçtan uca şifreli; sunucu sadece kodun özetini (id) bilir
    if (req.method === 'GET' && path === '/inbox') {
      const id = new URL(req.url).searchParams.get('id') || '';
      if (!/^[a-f0-9]{24}$/.test(id)) return json({ error: 'bad id' }, 400, o);
      const l = await env.SUBS.list({ prefix: `inbox:${id}:` });
      const items = [];
      for (const k of l.keys.slice(0, 20)) { const v = await env.SUBS.get(k.name); if (v) items.push({ k: k.name, data: v }); }
      return json({ items }, 200, o);
    }
    if (req.method === 'GET' && path === '/prices') {
      const syms = [...new Set((new URL(req.url).searchParams.get('s') || '').toUpperCase().split(',').map(x => x.trim()).filter(x => SYM_RE.test(x)))].slice(0, 30);
      if (!syms.length) return json({ error: 'sembol yok' }, 400, o);
      const cache = caches.default, ck = new Request('https://cache.local/prices?s=' + syms.sort().join(','));
      let hit = await cache.match(ck);
      if (!hit) {
        hit = new Response(JSON.stringify({ prices: await prices(syms), at: Date.now() }), { headers: { 'content-type': 'application/json', 'Cache-Control': 'max-age=600' } });
        await cache.put(ck, hit.clone());
      }
      return new Response(hit.body, { headers: { 'content-type': 'application/json', ...cors(o) } });
    }
    if (req.method !== 'POST') return json({ ok: true, service: 'motive-push' }, 200, o);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400, o); }

    if (path === '/subscribe') {
      const sub = body.sub;
      if (!sub || !validSub(sub) || !sub.keys) return json({ error: 'geçersiz abonelik' }, 400, o);
      const p = body.prefs || {};
      const hour = v => (Number.isInteger(v) && v >= 0 && v < 24 ? v : null);
      const prefs = p.app === 'cuzdan'
        ? { app: 'cuzdan', hour: hour(p.hour) ?? 10, dates: (Array.isArray(p.dates) ? p.dates : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 120) }
        : { sum: hour(p.sum) ?? 22, morn: hour(p.morn) ?? 9, mid: hour(p.mid) ?? 16, on: { sum: !!p.on?.sum, morn: !!p.on?.morn, mid: !!p.on?.mid },
            pt: (Array.isArray(p.pt) ? p.pt : []).filter(x => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x)).slice(0, 120) };
      await env.SUBS.put(await keyOf(sub.endpoint), JSON.stringify({ sub: { endpoint: sub.endpoint, keys: sub.keys }, prefs, at: Date.now() }));
      return json({ ok: true }, 200, o);
    }
    if (path === '/inbox') {
      const id = String(body.id || '');
      if (!/^[a-f0-9]{24}$/.test(id) || typeof body.data !== 'string' || body.data.length > 400_000) return json({ error: 'bad request' }, 400, o);
      const n = (await env.SUBS.list({ prefix: `inbox:${id}:` })).keys.length;
      if (n >= 20) return json({ error: 'inbox full' }, 429, o);
      await env.SUBS.put(`inbox:${id}:${Date.now()}`, body.data, { expirationTtl: 30 * 86400 });
      return json({ ok: true }, 200, o);
    }
    if (path === '/inbox/ack') {
      const id = String(body.id || '');
      if (!/^[a-f0-9]{24}$/.test(id) || !Array.isArray(body.keys)) return json({ error: 'bad request' }, 400, o);
      for (const k of body.keys.slice(0, 20)) if (typeof k === 'string' && k.startsWith(`inbox:${id}:`)) await env.SUBS.delete(k);
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
    const local = new Date(event.scheduledTime + TZ_OFFSET * 3600 * 1000);
    const h = local.getUTCHours(), mi = local.getUTCMinutes(), day = local.toISOString().slice(0, 10), keys = windowKeys(local);
    let cursor;
    do {
      const list = await env.SUBS.list({ cursor });
      cursor = list.list_complete ? null : list.cursor;
      for (const k of list.keys) {
        const rec = await env.SUBS.get(k.name, 'json');
        if (!rec) continue;
        const p = rec.prefs || {};
        if (!isDue(p, h, day, mi, keys)) continue;
        const r = await sendPush(rec.sub, env);
        console.log('push', h, r.status);
        if (r.status === 404 || r.status === 410) await env.SUBS.delete(k.name);
      }
    } while (cursor);
  },
};
