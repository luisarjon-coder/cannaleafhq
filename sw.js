// Canna Leaf HQ -- background push notification service worker.
// This file must be served from the SITE ROOT (same folder as index.html) so its
// default scope covers the whole app. Deployed as-is, no build step needed.

self.addEventListener("install", function (event) {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

// Fired when the Vercel function (api/send-product-push.js) sends a push message
// through the browser's push service -- this runs even if no Canna Leaf HQ tab is
// open, which is the whole point.
self.addEventListener("push", function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: "Canna Leaf HQ", body: (event.data && event.data.text()) || "New product request" };
  }
  var title = payload.title || "Canna Leaf HQ";
  var options = {
    body: payload.body || "",
    tag: payload.tag || "product-request",
    renotify: true,
    requireInteraction: false,
    data: { url: payload.url || "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an already-open tab if there is one, otherwise
// opens a new one.
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
