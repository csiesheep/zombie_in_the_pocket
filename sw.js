// Service worker. The game is entirely static, so full offline play costs
// nothing but care about the update path.
//
// Bump CACHE when anything in SHELL changes. The name is the version: a new
// deploy fills a new cache, and activate deletes every older one, so nobody is
// stranded on a stale shell. That is the failure mode worth designing against —
// a cache-first worker with one immortal cache name means players keep a build
// forever and every later fix is invisible to them.

const CACHE = "grave-errand-v18";

// Everything needed to open the game with no network. Relative paths on
// purpose: this ships under a subpath (…/zombie_in_the_pocket/) and absolute
// ones would silently point at the domain root.
const SHELL = [
  "./",
  "index.html",
  "game.html",
  "rulebook.html",
  "tiles.html",
  "credits.html",
  "manifest.webmanifest",
  "favicon.svg",
  "css/style.css",
  "js/app.js",
  "js/portal.js",
  "js/engine.js",
  "js/board.js",
  "js/render.js",
  "js/audio.js",
  "js/menu.js",
  "js/tiles.js",
  "js/shell.js",
  "js/tally.js",
  "js/epilogue.js",
  "assets/icons.svg",
  "assets/fonts/imfellenglish-latin.woff2",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
];

// Data and audio are fetched at runtime and cached as they are used, rather
// than listed above: a first visit should not pay for twelve audio files it may
// never hear, and install must not fail because one optional file 404s.
const RUNTIME = /\/(data|assets\/audio)\//;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // addAll is atomic — one 404 fails the whole install — so each file is
      // added on its own and a missing optional one costs only itself.
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch anything off-site

  // The app.js data fetches ask for `no-cache` deliberately: a re-theme or a
  // rules fix has to reach players who already have the old JSON. Honour that
  // through the worker — network first, cache only as the fallback — or the
  // caching layer would quietly undo the revalidation it was designed around.
  const wantsRevalidation = req.cache === "no-cache" || req.cache === "reload";

  if (wantsRevalidation || RUNTIME.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // The shell: cache first, and refill in the background so the next launch is
  // current without this one waiting on the network.
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
