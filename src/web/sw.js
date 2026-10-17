// Service worker for the web build: caches the app shell so TalkPrompter
// opens offline. (Voice packs are cached by vosk-browser in IndexedDB.)
// Bump VERSION whenever app files change.
const VERSION = 'tp-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.mjs', 'speech.mjs', 'defaults.mjs',
  'platform/index.mjs', 'platform/common.mjs', 'platform/web.mjs',
  'core/text.mjs', 'core/numbers.mjs', 'core/matcher.mjs', 'core/smoothDamp.mjs', 'core/languages.mjs',
  'vendor/vosk.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for the app shell (so updates show up), cache as fallback.
// Voice packs and other origins pass straight through.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/voice-packs/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('index.html')))
  );
});
