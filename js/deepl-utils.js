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
  ]);

  function normalizeErrorType(raw) {
    if (raw && KNOWN_ERROR_TYPES.has(raw)) return raw;
    return "other";
  }

  root.parseDeepLLangs = parseDeepLLangs;
  root.normalizeErrorType = normalizeErrorType;
  root.KNOWN_ERROR_TYPES = KNOWN_ERROR_TYPES;
})(typeof self !== "undefined" ? self : this);
