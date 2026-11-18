// Kubik service worker. Мета: застосунок відкривається без зв'язку (цех, монтаж), але ніколи не «застрягає» на старій версії.
// - Сторінки (HTML): завжди спершу мережа; кеш віддаємо лише якщо мережі немає або вона мовчить понад NAV_TIMEOUT_MS.
// - /assets/* мають хеш у назві (незмінні), тому кешуються назавжди; застарілі прибираємо після кожного успішного завантаження сторінки.
// - Запити до Supabase (інший домен) сюди не потрапляють: дані й чергу дій обробляє сам застосунок.
const cacheName = 'kubik-shell-v4'
const NAV_TIMEOUT_MS = 4000

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest']).catch(() => undefined)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)))))
  self.clients.claim()
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pruneAssets(html) {
  const used = new Set(html.match(/\/assets\/[A-Za-z0-9_.-]+/g) ?? [])
  if (used.size === 0) return
  const cache = await caches.open(cacheName)
  for (const request of await cache.keys()) {
    const { pathname } = new URL(request.url)
    const index = pathname.indexOf('/assets/')
    if (index !== -1 && !used.has(pathname.slice(index))) await cache.delete(request)
  }
}

async function handleNavigation(request) {
  const network = fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone()
      void caches.open(cacheName).then((cache) => cache.put(request, copy))
      void response.clone().text().then(pruneAssets)
    }
    return response
  })
  network.catch(() => undefined) // якщо кеш виграв гонку, помилка мережі не має стати необробленою
  try {
    const first = await Promise.race([network, delay(NAV_TIMEOUT_MS).then(() => null)])
    if (first) return first
  } catch { /* мережі немає — нижче беремо кеш */ }
  // Навігація може мати ?v=… — саме цього URL у кеші нема, тому віддаємо збережену оболонку.
  const cached = (await caches.match(request)) ?? (await caches.match('./index.html')) ?? (await caches.match('./'))
  if (cached) return cached
  return network.catch(() => new Response('Kubik недоступний без зв’язку. Відкрийте застосунок, коли з’явиться мережа.', { status: 503, statusText: 'Service unavailable', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone()
      void caches.open(cacheName).then((cache) => cache.put(request, copy))
    }
    return response
  })))
})
