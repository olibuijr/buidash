// BúiDash service worker — offline app shell (CDN soundfonts are not cached).
const C = 'buidash-v2'

self.addEventListener('install', (e) => {
  self.skipWaiting()
  e.waitUntil(caches.open(C).then((c) => c.add('/').catch(() => {})))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))))
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const u = new URL(req.url)
  if (req.method !== 'GET' || u.origin !== location.origin) return
  if (req.mode === 'navigate') {
    // network-first for the document so updates show
    e.respondWith(
      fetch(req).then((r) => { caches.open(C).then((c) => c.put('/', r.clone())); return r }).catch(() => caches.match('/')),
    )
    return
  }
  // cache-first for built assets, charts, glb
  e.respondWith(
    caches.match(req).then((r) => r || fetch(req).then((resp) => { const cp = resp.clone(); caches.open(C).then((c) => c.put(req, cp)); return resp })),
  )
})
