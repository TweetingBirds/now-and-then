// The app's old address, now-or-later.tweetingbirds.com.
//
// Browsers keep localStorage per address, so a device's lists and sync settings
// can't follow a plain redirect to now-or-later.app. Instead:
//   /, /index.html  A page that reads this device's storage (it's the same address,
//                   so it can) and opens now-or-later.app/#move=<payload>. The app
//                   there writes it into its own storage (readMove in app/app.js).
//   /sw.js          A service worker that clears the old app's offline copy and
//                   removes itself, so installed copies stop showing the old app.
//   anything else   A permanent redirect to the same path on now-or-later.app.
// Invite, device and shared-list links (#join=, #device=, ...) and quick-add links
// (?add=) keep their # and ? on the way over.

const DEFAULT_ORIGIN = "https://now-or-later.app";

const SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
})()));
`;

const page = (NEW_ORIGIN) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Now or Later has moved</title>
<style>
  body { font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 15vh 24px; background: #eef0f3; color: #1d2330; text-align: center; }
  @media (prefers-color-scheme: dark) { body { background: #16191f; color: #e8eaee; } a { color: #9cc3ff; } }
  h1 { font-size: 1.4em; margin: 0 0 .5em; }
  p { max-width: 30em; margin: 0 auto .8em; }
</style>
</head>
<body>
<h1>Now or Later has moved</h1>
<p>It now lives at <a id="go" href="${NEW_ORIGIN}/">now-or-later.app</a>. Taking your lists there&hellip;</p>
<p id="home" hidden>If you added the app to your Home Screen or Dock, add now-or-later.app too, and remove this one once your lists show up there.</p>
<script>
(async () => {
  const NEW = ${JSON.stringify(NEW_ORIGIN)};
  const KEYS = ["nat.board.v1", "nat.local.v1", "nat.synced.v1"];
  const go = document.getElementById("go");
  if (matchMedia("(display-mode: standalone)").matches) document.getElementById("home").hidden = false;
  if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  const hash = location.hash.slice(1);
  let target = NEW + location.pathname + location.search;
  let dest = target + location.hash;
  try {
    // A link's own # (invites, device links) wins; lists move on a later visit.
    // Every visit sends the lists along. The app there says "already here" when it
    // syncs with the same board, and asks before replacing lists it already has.
    if (!hash && localStorage.getItem("nat.board.v1")) {
      const keys = {};
      for (const k of KEYS) { const v = localStorage.getItem(k); if (v != null) keys[k] = v; }
      let bytes = new TextEncoder().encode(JSON.stringify({ v: 1, keys })), kind = "j.";
      if (typeof CompressionStream === "function") {
        bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
        kind = "z.";
      }
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      dest = target + "#move=" + kind + btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    }
  } catch (e) {}
  go.href = dest;
  location.replace(dest);
})();
</script>
</body>
</html>
`;

export default {
  async fetch(request, env = {}) {
    const NEW_ORIGIN = env.NEW_ORIGIN || DEFAULT_ORIGIN; // tests point it elsewhere
    const url = new URL(request.url);
    const noStore = { "Cache-Control": "no-store" };
    if (url.pathname === "/sw.js") {
      return new Response(SW, { headers: { ...noStore, "Content-Type": "text/javascript; charset=utf-8" } });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(page(NEW_ORIGIN), { headers: { ...noStore, "Content-Type": "text/html; charset=utf-8" } });
    }
    return Response.redirect(NEW_ORIGIN + url.pathname + url.search, 301);
  },
};
