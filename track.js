// ============================================
// track.js — page-side analytics helper (popup, options, upload page,
// fullpage Documents surface, history-detail page)
// ============================================
// Anonymous usage analytics — see privacy policy at <PRIVACY_URL>.
// No translated text, no file contents, no DOM data from DeepL's UI is
// ever transmitted. Only feature-usage metadata.
//
// Forwards every event to the service worker (analytics.js) over
// chrome.runtime.sendMessage. Exposes window.trackEvent (the new helper)
// and window.bucketChars / window.bucketFileSize so callers don't have
// to know about the message protocol.

(function () {
  "use strict";

  // Manual sanity check — confirms in which surfaces (popup, fullpage,
  // history-detail, options, upload-page) track.js actually loaded.
  // Keep this — it's the only signal at runtime that PostHog wiring is
  // present in a given page.
  console.log("📡 track.js loaded in:", location.pathname);

  // Map known surfaces to the tab_context property attached to every
  // event. Anything else falls back to "unknown" — that's intentional
  // so a typo in a future page doesn't silently mislabel events.
  const TAB_CONTEXTS = {
    "popup.html": "popup",
    "fullpage.html": "documents_fullpage",
    "history-detail.html": "history_detail",
    "options.html": "options",
    "upload-page.html": "upload_page",
  };

  function detectTabContext() {
    const path = location.pathname || "";
    for (const key of Object.keys(TAB_CONTEXTS)) {
      if (path.endsWith("/" + key) || path.endsWith(key)) {
        return TAB_CONTEXTS[key];
      }
    }
    return "unknown";
  }

  const TAB_CONTEXT = detectTabContext();

  // popup_session_id — generated only when track.js loads inside the
  // popup. Identifies one popup-open lifecycle so PostHog can correlate
  // sequences like paste → magic_fix → send → copy across the Main /
  // Loop / History / Documents tabs within the same popup mount. This
  // is sequence-scope, distinct from PostHog's distinct_id (user-scope).
  // fullpage.html and history-detail.html are separate surfaces and
  // intentionally do NOT carry a popup_session_id.
  const POPUP_SESSION_ID =
    TAB_CONTEXT === "popup"
      ? "ps-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
      : null;

  // Central event helper. Every page-side track call should go through
  // here so:
  //   1. base properties (tab_context, popup_session_id) are uniform
  //   2. missing chrome.runtime is logged loud, not dropped silently —
  //      that was Phase 1's failure mode in fullpage.html.
  //   3. console.log gives manual-test visibility that an event fired.
  function trackEvent(eventName, properties) {
    const enrichedProps = {
      ...(properties || {}),
      tab_context: TAB_CONTEXT,
      ...(POPUP_SESSION_ID ? { popup_session_id: POPUP_SESSION_ID } : {}),
    };

    console.log("📊 Tracked: " + eventName, enrichedProps);

    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
      console.warn(
        "[trackEvent] chrome.runtime unavailable — event dropped:",
        eventName,
      );
      return;
    }

    try {
      chrome.runtime.sendMessage({
        type: "analytics:capture",
        event: eventName,
        properties: enrichedProps,
      });
    } catch (err) {
      // Extension context can be torn down (e.g. popup closing
      // mid-flight). Warn so test runs surface the loss instead of
      // silently dropping — analytics-loss should be visible during
      // development, even if it's never user-visible.
      console.warn("[trackEvent] sendMessage failed:", eventName, err);
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

  // File-size buckets for documents tab. Different domain from
  // bucketChars (counts vs bytes), so kept as a separate function.
  function bucketFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1_000_000) return "<1MB";
    if (n < 5_000_000) return "1-5MB";
    if (n < 20_000_000) return "5-20MB";
    return ">20MB";
  }

  if (typeof window !== "undefined") {
    window.trackEvent = trackEvent;
    window.getDistinctId = getDistinctId;
    window.bucketChars = bucketChars;
    window.bucketFileSize = bucketFileSize;
    window.popupSessionId = function () {
      return POPUP_SESSION_ID;
    };
    window.tabContext = function () {
      return TAB_CONTEXT;
    };
  }
})();
