// Minimal service worker: no offline caching (this app is live-data only).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
