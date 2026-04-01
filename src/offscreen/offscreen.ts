// Offscreen document — keeps the service worker alive during long operations
// by sending periodic pings every 25 seconds.

setInterval(() => {
  chrome.runtime.sendMessage({ type: "KEEPALIVE_PING" });
}, 25_000);
