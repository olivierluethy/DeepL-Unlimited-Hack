// ============================================
// js/deepl-utils.js — DeepL-aware helpers shared across surfaces
// ============================================
// Loaded into:
//   - SW (background.js)  via importScripts('js/deepl-utils.js')
//   - popup.html          via <script src="js/deepl-utils.js" defer>
//   - fullpage.html       via <script src="js/deepl-utils.js"></script>
//
// Pure functions, no side effects. Single source of truth for:
//   - parseDeepLLangs(url)     → {lang_from, lang_to} for analytics
//   - normalizeErrorType(raw)  → canonical error_type vocabulary
//
// Both helpers must be identical between popup-flow and SW-flow events
// — otherwise PostHog filters across main_translation_failed and
// documents_translation_failed produce mismatched bucket counts.

(function (root) {
  "use strict";

  // Parse {lang_from, lang_to} out of a DeepL tab URL. DeepL encodes
  // the active source/target pair in either:
  //   - the hash:  /<ui>/translator#<from>/<to>/<text>
  //   - the query: ?source=<from>&target=<to>   (also ?sl=, ?tl=)
  //
  // Returns nulls when neither shape matches — DO NOT fall back to a
  // default like "en/de"; that would silently corrupt language-pair
  // distributions in PostHog. Null means "we couldn't detect it",
  // which is itself useful signal.
  function parseDeepLLangs(url) {
    if (!url || typeof url !== "string") {
      return { lang_from: null, lang_to: null };
    }
    try {
      const u = new URL(url);
      const isLang = (s) => /^[a-z]{2}$/.test(s);
      const hash = (u.hash || "").replace(/^#/, "");
      if (hash) {
        const parts = hash.split("/");
        if (parts.length >= 2) {
          const from = (parts[0] || "").toLowerCase().split("-")[0];
          const to = (parts[1] || "").toLowerCase().split("-")[0];
          if (isLang(from) && isLang(to)) {
            return { lang_from: from, lang_to: to };
          }
        }
      }
      const src = u.searchParams.get("source") || u.searchParams.get("sl");
      const tgt = u.searchParams.get("target") || u.searchParams.get("tl");
      if (src && tgt) {
        const from = src.toLowerCase().slice(0, 2);
        const to = tgt.toLowerCase().slice(0, 2);
        if (isLang(from) && isLang(to)) {
          return { lang_from: from, lang_to: to };
        }
      }
    } catch (_) {
      /* invalid URL — fall through to nulls */
    }
    return { lang_from: null, lang_to: null };
  }

  // Canonical error_type vocabulary for *_translation_failed events.
  // Anything outside this set is normalized to "other" so PostHog
  // filters work uniformly across main and documents flows.
  //
  // Don't extend without also extending the popup-side and SW-side
  // tagging logic that produces these values. Adding a new value here
  // alone won't make events emit it.
  const KNOWN_ERROR_TYPES = new Set([
    "char_limit",     // DeepL paywall hit
    "timeout",        // batch / run timed out
    "dom",            // DeepL UI elements not found
    "network",        // fetch / connectivity error
    "no_deepl_tab",   // no DeepL tab open at run-start
    "rate_limited",   // 429 from DeepL
    // --- added 2026-06: replace opaque "other" with specific classes so
    // large-PDF failures are observable. Transient classes are eligible
    // for capped, backed-off auto-resume; deterministic ones stop at once.
    "batch_size_exceeded",     // a single batch was rejected for being too large (deterministic)
    "extraction_error",        // PDF/text extraction produced no usable text (deterministic)
    "deepl_rejected",          // DeepL refused the input / paywall persisted after recovery (deterministic)
    "reassembly_error",        // translated batches could not be joined/saved (deterministic)
    "tab_closed",              // DeepL tab was closed/navigated away mid-run (transient)
    "script_injection_failed", // chrome.scripting.executeScript failed to reach the tab (transient)
    "stagnation",              // watchdog forced a stalled batch to fail (transient)
    "worker_restarted",        // MV3 service worker was torn down mid-run (transient)
  ]);

  // Error classes that can plausibly succeed on a clean retry. Anything not
  // listed here is treated as deterministic: surface it, do NOT auto-retry.
  const TRANSIENT_ERROR_TYPES = new Set([
    "char_limit",
    "timeout",
    "network",
    "rate_limited",
    "tab_closed",
    "script_injection_failed",
    "stagnation",
    "worker_restarted",
  ]);

  function isTransientErrorType(t) {
    return TRANSIENT_ERROR_TYPES.has(t);
  }

  function normalizeErrorType(raw) {
    if (raw && KNOWN_ERROR_TYPES.has(raw)) return raw;
    return "other";
  }

  root.parseDeepLLangs = parseDeepLLangs;
  root.normalizeErrorType = normalizeErrorType;
  root.KNOWN_ERROR_TYPES = KNOWN_ERROR_TYPES;
  root.TRANSIENT_ERROR_TYPES = TRANSIENT_ERROR_TYPES;
  root.isTransientErrorType = isTransientErrorType;
})(typeof self !== "undefined" ? self : this);
