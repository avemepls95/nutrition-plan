// Версию меняем при каждой публикации, чтобы телефон забрал новые файлы.
const CACHE = "plan-2026-11-01-1";
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "plan.js",
  "foods.js",
  "manifest.webmanifest",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

// GitHub Pages отдаёт файлы с max-age=600, поэтому запросы идут в обход HTTP-кэша браузера.
self.addEventListener("install", (event) => {
  const requests = ASSETS.map((url) => new Request(url, { cache: "reload" }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(requests)).then(() => self.skipWaiting()));
});

// На avemepls95.github.io живут и другие проекты, их кэши не трогаем.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("plan-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Ответ сразу из кэша, а свежая копия подтягивается в фоне к следующему запуску.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  const network = fetch(request.url, { cache: "no-cache" }).then(async (response) => {
    if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
    return response;
  });
  event.respondWith(caches.match(request, { cacheName: CACHE, ignoreSearch: true }).then((cached) => cached || network));
  event.waitUntil(network.catch(() => undefined));
});
