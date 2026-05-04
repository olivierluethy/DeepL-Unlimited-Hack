// ============================================
// track.js — page-side analytics helper (popup, options, consent, upload page)
// ============================================
// Loaded via a <script> tag on every extension page that needs to emit
// events. Forwards everything to the service worker (analytics.js) over
// chrome.runtime.sendMessage. The service worker is the single place
// that decides whether an event is allowed to leave the device.
//
// Exposes window.track / window.setConsent / window.getConsent /
// window.bucketChars so callers don't have to know about the message
// protocol.

(function () {
  "use strict";

  function track(eventName, properties = {}) {
    try {
      chrome.runtime.sendMessage({
        type: "analytics:capture",
        event: eventName,
        properties,
      });
    } catch (_err) {
      // Extension context can be torn down (e.g. popup closing mid-flight).
      // Dropping the event is the right call — analytics must never
      // surface user-visible errors.
    }
  }

  function setConsent(value) {
    return chrome.runtime.sendMessage({
      type: "analytics:setConsent",
      value,
    });
  }

  function getConsent() {
    return chrome.runtime
      .sendMessage({ type: "analytics:getConsent" })
      .then((res) => (res && res.value) || null)
      .catch(() => null);
  }

  // Shared bucket function so popup / loop / upload all report the same
  // distribution. Keep in sync with bucketChars() in background.js.
  function bucketChars(n) {
    if (n < 500) return "0-500";
    if (n < 2000) return "500-2k";
    if (n < 5000) return "2k-5k";
    if (n < 10000) return "5k-10k";
    if (n < 25000) return "10k-25k";
    return "25k+";
  }

  if (typeof window !== "undefined") {
    window.track = track;
    window.setConsent = setConsent;
    window.getConsent = getConsent;
    window.bucketChars = bucketChars;
  }
})();
