// Offline support: the app shell is cached on install; fonts are cached as they load.
// The deploy workflow stamps the build into VERSION, so every deploy gets a fresh
// cache and the old one is cleared. No need to bump it by hand.
// index.html loads styles.css and app.js with ?v=<build>, so a new page can never
// pick up the previous build's script from the browser's HTTP cache or a CDN.
const VERSION = "nat-__BUILD_NUMBER__-__BUILD_SHA__";
// Fonts never change, so they keep their own cache across updates instead of
// downloading again after every deploy.
const FONTS = "nat-fonts-v1";
// On a weak signal, wait this long for the network before using the saved copy.
const NETWORK_WAIT_MS = 3000;
const SHELL = ["./", "index.html", "styles.css", "styles.css?v=__BUILD_NUMBER__", "app.js?v=__BUILD_NUMBER__", "manifest.webmanifest", "pages.css", "pages.js", "whats-new.html", "support.html", "privacy.html", "terms.html", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/icon-maskable-512.png"];

self.addEventListener("install", (e) => {
  // cache: "reload" skips the HTTP cache, which can still hold the previous build
  // for up to 10 minutes after a deploy.
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: cache-first, so the handwriting font works offline.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Our own files: network first (so updates show up), falling back to the cache
  // offline, or after NETWORK_WAIT_MS on a connection too weak to answer (the
  // network copy still lands in the cache for next time).
  // "no-cache" revalidates with the server instead of trusting the browser's HTTP
  // cache, which GitHub Pages lets hold files for up to 10 minutes.
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith("/version.json")) return; // always straight from the network
    const cached = (res) => caches.match(req).then((hit) => hit || caches.match("index.html")).then((hit) => hit || res || Response.error());
    let saving = null;
    const net = fetch(req, { cache: "no-cache" }).then((res) => {
      if (res.ok) { const copy = res.clone(); saving = caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    });
    e.waitUntil(net.then(() => saving, () => {})); // keeps the worker alive to finish saving
    e.respondWith(new Promise((resolve) => {
      let done = false;
      const settle = (r) => { if (!done) { done = true; resolve(r); } };
      const timer = setTimeout(() => caches.match(req).then((hit) => { if (hit) settle(hit); }), NETWORK_WAIT_MS);
      net.then((res) => { clearTimeout(timer); settle(res); }, () => { clearTimeout(timer); settle(cached()); });
    }));
  }
  // Anything else (the sync Worker) goes straight to the network.
});
