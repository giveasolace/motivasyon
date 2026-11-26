const CACHE = 'motive-v3';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Önce ağ, olmazsa önbellek: güncellemeler hemen gelir, internetsiz de çalışır
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});

// ---------- Push bildirimleri ----------
// Sunucu boş (payload'sız) push gönderir; mesajı uygulamanın IndexedDB'ye yazdığı özetten burada kurarız.
function readSnap() {
  return new Promise(res => {
    const r = indexedDB.open('motive', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => res(null);
    r.onsuccess = () => {
      try {
        const g = r.result.transaction('kv').objectStore('kv').get('snap');
        g.onsuccess = () => res(g.result || null);
        g.onerror = () => res(null);
      } catch (e) { res(null); }
    };
  });
}
const pad = n => String(n).padStart(2, '0');
const dkey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

function buildMessage(s) {
  const now = new Date(), h = now.getHours(), t = dkey(now);
  if (s && s.testAt && Date.now() - s.testAt < 5 * 60 * 1000)
    return { title: '✅ Bildirimler çalışıyor!', body: 'Seçtiğin saatlerde burada olacağım 💪', url: './' };

  const n = (s && s.notif) || { sum: 22, morn: 9, mid: 16, on: { sum: true, morn: true, mid: true } };
  const types = ['morn', 'mid', 'sum'].filter(k => n.on && n.on[k]);
  const type = types.find(k => n[k] === h) || types.filter(k => n[k] <= h).sort((a, b) => n[b] - n[a])[0] || 'sum';
  const fresh = s && s.date === t;

  if (type === 'morn') {
    let cnt = 0, first = '';
    if (fresh) { cnt = s.total - s.done; first = s.first; }
    else if (s) { const p = (s.plan && s.plan[t]) || { n: 0, r: [], first: '' }; cnt = p.n + p.r.length + (s.carry || 0); first = p.first || p.r[0] || ''; }
    return {
      title: '☀️ Günaydın!',
      body: cnt ? `Bugün ${cnt} işin var${first ? ', ilki: ' + first : ''}. Hadi başlayalım!` : 'Bugün için plan yok. 1 dakikada günü planla 📅',
      url: './'
    };
  }
  if (type === 'mid') {
    if (!s || !s.hTotal) {
      const left = fresh ? s.total - s.done : 0;
      return { title: '⏰ Gün yarılandı', body: left ? `${left} görev bekliyor. Bir pomodoro ile bitir 🍅` : 'Kısa bir odak seansına ne dersin? 🍅', url: './' };
    }
    const pend = fresh ? s.hPending : s.hTotal;
    return pend
      ? { title: '🔥 Serin tehlikede', body: `${pend} alışkanlık bugün seni bekliyor. Zinciri kırma!`, url: './' }
      : { title: '💪 Alışkanlıklar tamam', body: 'Bugünün tüm alışkanlıklarını yaptın. Harikasın!', url: './' };
  }
  if (!fresh) return { title: '🌙 Günün özeti', body: 'Bugün uygulamayı hiç açmadın. Yarını planlamak için 1 dakikan var mı?', url: './?ozet=1' };
  return { title: '🌙 Günün özeti', body: `${s.done}/${s.total} görev · ${s.m} dk odak · +${Math.max(0, s.x)} XP. Yarını planla →`, url: './?ozet=1' };
}

self.addEventListener('push', e => {
  e.waitUntil(readSnap().then(s => {
    const m = buildMessage(s);
    return self.registration.showNotification(m.title, { body: m.body, icon: 'icon-192.png', badge: 'icon-192.png', tag: 'motive', data: { url: m.url } });
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (cs.length) {
      const c = cs[0];
      if (url.includes('ozet')) c.postMessage('ozet');
      return c.focus();
    }
    return self.clients.openWindow(url);
  }));
});
