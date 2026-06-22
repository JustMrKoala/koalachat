const CACHE_NAME = "koala-v4";
const ASSETS = [
  "/",
  "/static/css/style.css",
  "/static/js/crypto/e2ee.js",
  "/static/js/crypto/koalamix.js",
  "/static/js/ws.js",
  "/static/js/friends.js",
  "/static/js/messages.js",
  "/static/js/purge.js",
  "/static/js/antitamper.js",
  "/static/js/offline.js",
  "/static/js/app.js",
  "/static/icons/logo.png",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith("koala") && k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.url.includes("/ws/") || event.request.url.includes("/api/")) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        if (response.ok && event.request.method === "GET") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
      return cached || fetched;
    })
  );
});