const CACHE_NAME = "koala-v29";
const ASSETS = [
  "/",
  "/static/css/style.css",
  "/static/js/crypto/e2ee.js",
  "/static/js/crypto/koalamix.js",
  "/static/js/crypto/group_crypto.js",
  "/static/js/vendor/qrcode.min.js",
  "/static/js/vendor/html5-qrcode.min.js",
  "/static/js/ws.js",
  "/static/js/friends.js",
  "/static/js/groups.js",
  "/static/js/messages.js",
  "/static/js/media.js",
  "/static/js/purge.js",
  "/static/js/antitamper.js",
  "/static/js/app.js",
  "/static/icons/logo.png",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const keys = await cache.keys();
      await Promise.all(keys.map((req) => cache.delete(req)));
      await cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
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
  const url = new URL(event.request.url);
  if (
    event.request.url.includes("/ws/") ||
    event.request.url.includes("/api/") ||
    url.pathname === "/sw.js" ||
    url.pathname === "/health" ||
    url.pathname === "/ready"
  ) {
    return;
  }
  const isStatic = url.pathname.startsWith("/static/");
  const isNav = event.request.mode === "navigate" || url.pathname === "/";
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        if (response.ok && event.request.method === "GET" && isStatic) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
      return fetched.catch(() => {
        if (isStatic || isNav) return cached;
      });
    })
  );
});