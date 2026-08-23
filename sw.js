/* DBZ Money Maker service worker — network-first app shell, auto-updating */
const CACHE = 'dbz-v11';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./manifest.json','./icon-192.png','./icon-512.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Never intercept eBay or cross-origin CDN navigations we open in a new tab
  if (url.hostname.includes('ebay.')) return;
  const isShell = url.origin === location.origin && /\.(html|css|js)$|\/$/.test(url.pathname);
  if (isShell) {
    event.respondWith(
      fetch(event.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(event.request, c)); } return r; })
        .catch(() => caches.match(event.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }
  // cache-first for other assets (icons, Tesseract CDN) so OCR works offline after first load
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(r => {
    if (r.ok) { const cc = r.clone(); caches.open(CACHE).then(x => x.put(event.request, cc)); } return r;
  }).catch(() => cached)));
});
