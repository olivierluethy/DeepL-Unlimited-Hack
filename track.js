// ============================================
// track.js — page-side analytics helper (popup, options, upload page)
// ============================================
// Anonymous usage analytics — see privacy policy at <PRIVACY_URL>.
// No translated text, no file contents, no DOM data from DeepL's UI is
// ever transmitted. Only feature-usage metadata.
//
// Forwards every event to the service worker (analytics.js) over
// chrome.runtime.sendMessage. Exposes window.track and window.bucketChars
// so callers don't have to know about the message protocol.

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

  function getDistinctId() {
    return chrome.runtime
      .sendMessage({ type: "analytics:getDistinctId" })
      .then((res) => (res && res.id) || null)
      .catch(() => null);
  }

  // Keep in sync with bucketChars() in background.js.
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
    window.getDistinctId = getDistinctId;
    window.bucketChars = bucketChars;
  }
})();
