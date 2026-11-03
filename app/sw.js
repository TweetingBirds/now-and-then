// Offline support: the app shell is cached on install; fonts are cached as they load.
// The deploy workflow stamps the build into VERSION, so every deploy gets a fresh
// cache and the old one is cleared. No need to bump it by hand.
const VERSION = "nat-__BUILD_NUMBER__-__BUILD_SHA__";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/icon-maskable-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: cache-first, so the handwriting font works offline.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Our own files: network first (so updates show up), falling back to the cache offline.
  // "no-cache" revalidates with the server instead of trusting the browser's HTTP
  // cache, which GitHub Pages lets hold files for up to 10 minutes.
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith("/version.json")) return; // always straight from the network
    e.respondWith(
      fetch(req, { cache: "no-cache" }).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
    );
  }
  // Anything else (the sync Worker) goes straight to the network.
});
