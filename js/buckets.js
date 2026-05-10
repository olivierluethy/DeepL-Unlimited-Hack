// ============================================
// js/buckets.js — analytics bucket helpers (single source of truth)
// ============================================
// Loaded into:
//   - SW (background.js)  via importScripts('js/buckets.js')
//   - popup.html          via <script src="js/buckets.js" defer>
//   - fullpage.html       via <script src="js/buckets.js"></script>
//
// Both popup-side track.js and SW-side analytics.js / background.js
// consume these. If the bucket boundaries drift between surfaces,
// PostHog dashboards mix two different value sets under the same
// property name — keep the definitions here and only here.
//
// Pure functions, no side effects. Safe to load multiple times.

(function (root) {
  "use strict";

  // Char-count buckets used wherever we attach a *_char_count_bucket
  // analytics property. Boundaries chosen to match DeepL's free-tier
  // limit (5k) and the practical ceiling for "long text" use-cases (25k+).
  function bucketChars(n) {
    if (n < 500) return "0-500";
    if (n < 2000) return "500-2k";
    if (n < 5000) return "2k-5k";
    if (n < 10000) return "5k-10k";
    if (n < 25000) return "10k-25k";
    return "25k+";
  }

  // File-size buckets for the Documents tab. Different domain from
  // char counts (bytes vs characters), kept as a separate function so
  // the two never collide.
  function bucketFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1_000_000) return "<1MB";
    if (n < 5_000_000) return "1-5MB";
    if (n < 20_000_000) return "5-20MB";
    return ">20MB";
  }

  root.bucketChars = bucketChars;
  root.bucketFileSize = bucketFileSize;
})(typeof self !== "undefined" ? self : this);
