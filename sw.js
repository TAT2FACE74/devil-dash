// Devil Dash service worker — minimal pass-through (enables app install).
// Requests always go to the network so the live site is never stale.
self.addEventListener('install', function (event) {
  self.skipWaiting();
});
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', function (event) {
  // Pass-through: do not intercept. The browser handles the request normally.
});
