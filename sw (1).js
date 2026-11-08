/* Finans Paneli servis çalışanı: çevrimdışı açılış */
const CACHE = 'finans-v2';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './favicon-32.png', './badge-96.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // yalnızca bu uygulamanın eski önbelleklerini sil (aynı adresteki diğer uygulamalara dokunma)
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('finans-') && k !== CACHE && k !== 'finans-ozet').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    // önce internetten yeni sürüm; sayfa bulunamazsa (404) ya da internet yoksa son çalışan sürüm
    e.respondWith(fetch(req).then(r => {
      if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', cp)); return r; }
      return caches.match('./index.html').then(hit => hit || r);
    }).catch(() => caches.match('./index.html')));
    return;
  }
  if (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com/.test(url.host)) {
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});

/* ---- günlük özet bildirimi (uygulama kapalıyken de) ---- */
const OZET_CACHE = 'finans-ozet';
const ozetUrl = n => new URL('./' + n, self.registration.scope).href;
const ymdSW = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
async function ozetGoster(force) {
  const c = await caches.open(OZET_CACHE);
  const r = await c.match(ozetUrl('__ozet.json'));
  if (!r) return;
  const plan = await r.json();
  if (!plan.enabled && !force) return;
  const now = new Date(), day = ymdSW(now);
  const it = plan.days && plan.days[day];
  if (!it) return;
  if (!force) {
    const p = String(plan.morning || '08:00').split(':').map(Number);
    const mins = now.getHours() * 60 + now.getMinutes();
    if (mins < (p[0] * 60 + (p[1] || 0)) || now.getHours() >= 22) return;
    const s = await c.match(ozetUrl('__ozet-shown.json'));
    const shown = s ? await s.json() : {};
    if ((shown.key || shown.day) === (it.key || day)) return;
  }
  await self.registration.showNotification(it.title, {
    body: it.body, icon: 'icon-192.png', badge: 'badge-96.png', tag: 'finans-ozet', renotify: true,
    data: { url: plan.url || self.registration.scope }
  });
  if (!force) await c.put(ozetUrl('__ozet-shown.json'), new Response(JSON.stringify({ day, key: it.key || day }), { headers: { 'Content-Type': 'application/json' } }));
}
self.addEventListener('periodicsync', e => { if (e.tag === 'gunluk-ozet') e.waitUntil(ozetGoster(false)); });
self.addEventListener('message', e => { if (e.data && e.data.type === 'ozet-goster') e.waitUntil(ozetGoster(!!e.data.force)); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) { if (w.url.startsWith(self.registration.scope) && 'focus' in w) return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
