// ============================================
// analytics.js — PostHog client for Chrome MV3 service worker
// ============================================
// Anonymous usage analytics — see privacy policy at <PRIVACY_URL>.
// No translated text, no file contents, no contact data, no DOM text
// from DeepL's UI is ever transmitted. Only feature-usage metadata
// (button clicks, error types, character-count buckets, durations).
//
// Loaded into background.js via importScripts(). Exposes self.analytics
// as the integration surface; pages talk to it via
// chrome.runtime.sendMessage with type "analytics:*". See track.js for
// the page-side helper.

(function () {
  "use strict";

  const POSTHOG_API_KEY = "phc_vdh5V2RdTvv78E778stRjmNqXf7LNwEEhPhHteafYvLG";
  const POSTHOG_HOST = "https://eu.i.posthog.com";

  const STORAGE_KEYS = {
    DISTINCT_ID: "analytics_distinct_id",
    QUEUE: "analytics_queue",
    MONTHLY_TRACKER: "analyticsMonthlyTracker_v1",
  };

  const FLUSH_INTERVAL_SECONDS = 30;
  const MAX_QUEUE_SIZE = 200;
  const MAX_BATCH_SIZE = 50;

  // ─── Monthly aggregate tracker ─────────────────────────────────────────────
  // Per-user counters for the current calendar month, snapshotted as
  // `user_monthly_summary` on the first popup_opened of the next month.
  // Lets us answer "what does a heavy user look like?" with one PostHog
  // query instead of aggregating thousands of raw events.
  //
  // Single-writer design: the tracker is only mutated inside this file,
  // and only inside `capture()`. Page-side events route through the
  // `analytics:capture` message → the SW's onMessage handler calls
  // capture() here → tracker update happens here. The popup never
  // touches the tracker directly. This is the user-stated preference
  // ("all increments from the SW only") combined with an in-memory
  // mutex below to serialize the storage read-modify-write inside one
  // SW lifetime.
  const MONTHLY_SUMMARY_EVENT = "user_monthly_summary";

  // In-memory mutex. Every storage read-modify-write on the monthly
  // tracker chains onto this promise so concurrent capture() calls
  // can't race. JS is single-threaded but `await` boundaries let
  // operations interleave — without this lock, two near-simultaneous
  // events would each read the same tracker state and one increment
  // would silently win.
  let monthlyTrackerOp = Promise.resolve();
  function withMonthlyTrackerLock(fn) {
    const next = monthlyTrackerOp.then(fn, fn);
    // Keep the chain alive even if `fn` throws — never let one failed
    // op block all subsequent operations.
    monthlyTrackerOp = next.catch(() => {});
    return next;
  }

  function periodKeyFor(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  function dayKeyFor(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function defaultMonthlyTracker() {
    const nowIso = new Date().toISOString();
    return {
      periodKey: periodKeyFor(nowIso),
      initializedAt: nowIso,
      counters: emptyCounters(),
    };
  }

  function emptyCounters() {
    return {
      main_translation_count: 0,
      main_translation_completed_count: 0,
      main_translation_total_chars_input: 0,
      main_translation_total_chars_output: 0,
      main_translation_max_single_chars: 0,
      documents_pdf_completed_count: 0,
      documents_xlsx_completed_count: 0,
      documents_pptx_completed_count: 0,
      documents_total_chars_input: 0,
      loop_runs_count: 0,
      // Stored as an array; deduped on every increment. `.length` at
      // rollover gives unique_active_days. UTC YYYY-MM-DD strings only.
      active_days: [],
    };
  }

  async function loadMonthlyTracker() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.MONTHLY_TRACKER);
    return data[STORAGE_KEYS.MONTHLY_TRACKER] || defaultMonthlyTracker();
  }

  async function saveMonthlyTracker(tracker) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.MONTHLY_TRACKER]: tracker,
    });
  }

  // Documents flow uses `excel` for .xlsx/.xls files; the spec property
  // name is `documents_xlsx_completed_count`. Map at the increment site
  // so the codebase stays internally consistent and PostHog gets the
  // canonical name. `docx` (legacy upload-page) and any other type
  // fall through with no counter — those numbers belong on the raw
  // documents_translation_completed event, not in the rollup.
  function fileTypeCounterKey(fileType) {
    if (fileType === "pdf") return "documents_pdf_completed_count";
    if (fileType === "excel") return "documents_xlsx_completed_count";
    if (fileType === "pptx") return "documents_pptx_completed_count";
    return null;
  }

  // Mutate the tracker in-place based on the event being captured.
  // Pure switch — never fires events itself. Returns the tracker for
  // chaining clarity but the mutation is in-place.
  function applyEventToMonthlyTracker(tracker, eventName, properties) {
    if (!tracker || !tracker.counters) return tracker;
    if (eventName === MONTHLY_SUMMARY_EVENT) return tracker; // never self-count

    const c = tracker.counters;

    // Active-day stamp on every captured event. Dedup as we go;
    // ordering doesn't matter since we only ever read .length.
    const today = dayKeyFor(new Date());
    if (today && !c.active_days.includes(today)) {
      c.active_days.push(today);
    }

    const numOrZero = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

    switch (eventName) {
      case "main_translation_started":
        // Count of all main translation attempts. Pairs with
        // main_translation_completed_count to compute success rate
        // post-hoc in PostHog.
        c.main_translation_count += 1;
        break;
      case "main_translation_completed": {
        c.main_translation_completed_count += 1;
        const inChars = numOrZero(properties.input_char_count_exact);
        const outChars = numOrZero(properties.output_char_count_exact);
        c.main_translation_total_chars_input += inChars;
        c.main_translation_total_chars_output += outChars;
        if (inChars > c.main_translation_max_single_chars) {
          c.main_translation_max_single_chars = inChars;
        }
        break;
      }
      case "documents_translation_completed": {
        const key = fileTypeCounterKey(properties.file_type);
        if (key) c[key] += 1;
        // total_char_count_exact comes from background.js's runEventBase.
        // Fall back to the bucketed midpoint estimate? No — we'd rather
        // null-skew here than synthesise a number. Add only when exact
        // is present.
        const inChars = numOrZero(properties.total_char_count_exact);
        c.documents_total_chars_input += inChars;
        break;
      }
      case "loop_run_completed":
        c.loop_runs_count += 1;
        break;
      default:
        // No counter movement — but we still stamped the active day above.
        break;
    }

    return tracker;
  }

  // Decide whether the now-closed period should fire a summary, and
  // build the event payload if so. Returns null when we should skip.
  // Caller is responsible for resetting the tracker afterward.
  //
  // Skip rules (per chunk-4 design notes):
  //   1. Same period as before — nothing to close.
  //   2. Previous period had zero activity (no counter > 0, no active
  //      days) — covers both the "user installed mid-month and didn't
  //      do anything" case and the "user inactive for months" case
  //      (where we'd otherwise emit empty rollups for every skipped
  //      month). We only ever close the most recent active period.
  function buildSummaryEventForClosedPeriod(tracker, currentPeriod) {
    if (!tracker || !tracker.counters) return null;
    if (tracker.periodKey === currentPeriod) return null;

    const c = tracker.counters;
    const hasActivity =
      (c.active_days && c.active_days.length > 0) ||
      c.main_translation_count > 0 ||
      c.main_translation_completed_count > 0 ||
      c.documents_pdf_completed_count > 0 ||
      c.documents_xlsx_completed_count > 0 ||
      c.documents_pptx_completed_count > 0 ||
      c.loop_runs_count > 0;

    if (!hasActivity) return null;

    // period_full_month: false when the period summarized is the
    // user's install month (partial by definition). Lets the caller
    // filter out partial-month rollups in PostHog without us having
    // to drop them outright.
    const installPeriod = periodKeyFor(tracker.initializedAt);
    const periodFullMonth = installPeriod !== tracker.periodKey;

    return {
      eventName: MONTHLY_SUMMARY_EVENT,
      properties: {
        period: tracker.periodKey,
        period_full_month: periodFullMonth,
        main_translation_count: c.main_translation_count,
        main_translation_completed_count: c.main_translation_completed_count,
        main_translation_total_chars_input: c.main_translation_total_chars_input,
        main_translation_total_chars_output: c.main_translation_total_chars_output,
        main_translation_max_single_chars: c.main_translation_max_single_chars,
        documents_pdf_completed_count: c.documents_pdf_completed_count,
        documents_xlsx_completed_count: c.documents_xlsx_completed_count,
        documents_pptx_completed_count: c.documents_pptx_completed_count,
        documents_total_chars_input: c.documents_total_chars_input,
        loop_runs_count: c.loop_runs_count,
        // The set's size — never the dates themselves, since a list of
        // exact UTC dates a user was active on is more identifying
        // than a count.
        unique_active_days: (c.active_days || []).length,
      },
    };
  }

  function generateUUID() {
    return crypto.randomUUID();
  }

  async function getDistinctId() {
    const { [STORAGE_KEYS.DISTINCT_ID]: id } = await chrome.storage.local.get(
      STORAGE_KEYS.DISTINCT_ID,
    );
    if (id) return id;
    const newId = generateUUID();
    await chrome.storage.local.set({ [STORAGE_KEYS.DISTINCT_ID]: newId });
    return newId;
  }

  // Internal: build the event envelope (distinct_id, $lib, version, ts).
  async function buildEventObject(eventName, properties) {
    const distinctId = await getDistinctId();
    const manifest = chrome.runtime.getManifest();
    return {
      event: eventName,
      properties: {
        ...properties,
        distinct_id: distinctId,
        $lib: "chrome-extension",
        extension_version: manifest.version,
        browser_language:
          typeof navigator !== "undefined" ? navigator.language : undefined,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // Internal: append a built event onto the persistent send queue.
  async function enqueueEvent(event) {
    const { [STORAGE_KEYS.QUEUE]: queue = [] } = await chrome.storage.local.get(
      STORAGE_KEYS.QUEUE,
    );
    queue.push(event);
    if (queue.length > MAX_QUEUE_SIZE) {
      queue.splice(0, queue.length - MAX_QUEUE_SIZE);
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: queue });
  }

  async function capture(eventName, properties = {}) {
    // Monthly tracker: rollover check + counter increment, all
    // serialized through withMonthlyTrackerLock so two near-simultaneous
    // events can't lose updates on the storage read-modify-write.
    // The summary event (if one fires) is enqueued from inside the
    // lock so it lands before this event in the queue, preserving
    // the chronological order in PostHog.
    await withMonthlyTrackerLock(async () => {
      const tracker = await loadMonthlyTracker();
      const currentPeriod = periodKeyFor(new Date());

      // popup_opened is the only event that triggers a rollover check.
      // Any event would work in principle, but pinning it to popup_opened
      // means rollovers happen at user-visible boundaries instead of
      // arbitrary background events, which is easier to reason about.
      if (eventName === "popup_opened") {
        const summary = buildSummaryEventForClosedPeriod(tracker, currentPeriod);
        if (summary) {
          const summaryEvent = await buildEventObject(
            summary.eventName,
            summary.properties,
          );
          await enqueueEvent(summaryEvent);

          // Reset the tracker for the new period. Preserve initializedAt
          // — that's a per-install constant, not per-period.
          tracker.periodKey = currentPeriod;
          tracker.counters = emptyCounters();
        } else if (tracker.periodKey !== currentPeriod) {
          // Period changed but the closed period had no activity. Just
          // roll forward silently — no summary, fresh counters.
          tracker.periodKey = currentPeriod;
          tracker.counters = emptyCounters();
        }
      }

      applyEventToMonthlyTracker(tracker, eventName, properties);
      await saveMonthlyTracker(tracker);
    });

    const event = await buildEventObject(eventName, properties);
    await enqueueEvent(event);
  }

  async function flush() {
    const { [STORAGE_KEYS.QUEUE]: queue = [] } = await chrome.storage.local.get(
      STORAGE_KEYS.QUEUE,
    );
    if (queue.length === 0) return;

    const batch = queue.slice(0, MAX_BATCH_SIZE);
    const remaining = queue.slice(MAX_BATCH_SIZE);

    const payload = {
      api_key: POSTHOG_API_KEY,
      batch: batch.map((e) => ({
        event: e.event,
        properties: e.properties,
        timestamp: e.timestamp,
        distinct_id: e.properties.distinct_id,
      })),
    };

    try {
      const res = await fetch(`${POSTHOG_HOST}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (!res.ok) throw new Error(`PostHog returned ${res.status}`);
      await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: remaining });
    } catch (err) {
      // Leave the queue alone — next flush retries from the same head.
      console.warn("[analytics] flush failed, will retry:", err);
    }
  }

  // ─── Stuck-user state (consecutive char_limit failures) ──────────────────
  // Per-install counter that increments on each documents_translation_failed
  // with error_type === 'char_limit', and resets to 0 on the next
  // successful documents run. Surfaces "users bashing their head
  // against the wall" without correlating sequences in PostHog.
  //
  // Stored separately from the monthly tracker because this counter
  // is NOT month-scoped — it persists across rollovers until the user
  // gets a successful run. The 162 char_limit failures from 2 users
  // observation that motivated this counter spanned weeks.
  const STUCK_USER_KEY = "analyticsStuckUserState_v1";

  // Same single-writer + serialized-RMW pattern as the monthly tracker.
  let stuckUserOp = Promise.resolve();
  function withStuckUserLock(fn) {
    const next = stuckUserOp.then(fn, fn);
    stuckUserOp = next.catch(() => {});
    return next;
  }

  async function getConsecutiveCharLimitFailures() {
    let value = 0;
    await withStuckUserLock(async () => {
      const data = await chrome.storage.local.get(STUCK_USER_KEY);
      const state = data[STUCK_USER_KEY] || { consecutive_char_limit_failures: 0 };
      value = state.consecutive_char_limit_failures || 0;
    });
    return value;
  }

  async function bumpConsecutiveCharLimitFailures() {
    let value = 0;
    await withStuckUserLock(async () => {
      const data = await chrome.storage.local.get(STUCK_USER_KEY);
      const state = data[STUCK_USER_KEY] || { consecutive_char_limit_failures: 0 };
      state.consecutive_char_limit_failures =
        (state.consecutive_char_limit_failures || 0) + 1;
      await chrome.storage.local.set({ [STUCK_USER_KEY]: state });
      value = state.consecutive_char_limit_failures;
    });
    return value;
  }

  // Returns the value BEFORE reset — caller emits it as
  // consecutive_char_limit_failures_before_success on the success event.
  async function resetConsecutiveCharLimitFailures() {
    let prior = 0;
    await withStuckUserLock(async () => {
      const data = await chrome.storage.local.get(STUCK_USER_KEY);
      const state = data[STUCK_USER_KEY] || { consecutive_char_limit_failures: 0 };
      prior = state.consecutive_char_limit_failures || 0;
      state.consecutive_char_limit_failures = 0;
      await chrome.storage.local.set({ [STUCK_USER_KEY]: state });
    });
    return prior;
  }

  // ─── Paywall eligibility (read-only against monthly tracker) ──────────────
  // Fires `paywall_eligibility_check` with the projected post-action
  // counters, so each event reflects the user's tracker state INCLUDING
  // the action that's about to happen — i.e. the snapshot a paywall
  // would see at decision time.
  //
  // - For main: count == completed_count + 1, chars == total_chars + projected.
  // - For documents: count == sum of pdf+xlsx+pptx + 1, chars == total + projected.
  //
  // The action itself does not get pre-counted in the tracker — the
  // real `*_completed` event is still what increments the counters.
  // We compute the +1 view here so the boolean flags answer "would
  // this attempt have been blocked by a paywall at threshold X?".
  async function paywallEligibilityCheck(surface, projectedChars, fileType) {
    let count = null;
    let chars = null;
    await withMonthlyTrackerLock(async () => {
      const tracker = await loadMonthlyTracker();
      const c = tracker.counters || emptyCounters();
      const projected = typeof projectedChars === "number" ? projectedChars : 0;
      if (surface === "main") {
        count = c.main_translation_completed_count + 1;
        chars = c.main_translation_total_chars_input + projected;
      } else if (surface === "documents") {
        count =
          c.documents_pdf_completed_count +
          c.documents_xlsx_completed_count +
          c.documents_pptx_completed_count +
          1;
        chars = c.documents_total_chars_input + projected;
      }
    });
    if (count == null) return;

    // capture() acquires its own lock — no deadlock, separate
    // acquisition from the read above. Stamps active_day; no
    // counter switch case for paywall_eligibility_check, so no
    // counter movement.
    const props = {
      surface,
      current_period_count: count,
      current_period_chars: chars,
      would_paywall_at_count_3: count >= 3,
      would_paywall_at_chars_5k: chars >= 5000,
      would_paywall_at_chars_25k: chars >= 25000,
    };
    if (fileType) props.file_type = fileType;
    await capture("paywall_eligibility_check", props);
  }

  // ─── Popup tab dwell (port-based popup-close detection) ───────────────────
  // popup_tab_dwell is emitted in two places:
  //   1. popup-side, on tab-switch — for the leaving tab
  //   2. SW-side, on port disconnect — for the tab that was active
  //      when the popup closed
  //
  // Path 2 exists because beforeunload/pagehide are unreliable in MV3
  // popups: the popup window can close before any synchronous async
  // call has time to land. A long-lived port via chrome.runtime.connect
  // gives a reliable disconnect signal on the SW side regardless of
  // how the popup goes away.
  //
  // Per-port state map. Keyed by Port instance. Cleared on disconnect.
  const dwellPortState = new WeakMap();

  function handleDwellPortConnect(port) {
    if (!port || port.name !== "popup_dwell") return;

    // Initial empty state — populated as the popup messages it.
    dwellPortState.set(port, {
      popup_session_id: null,
      tab: null,
      entered_at: null,
      had_interaction: false,
    });

    port.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "state") return;
      const cur = dwellPortState.get(port);
      if (!cur) return;
      if (typeof msg.popup_session_id === "string") {
        cur.popup_session_id = msg.popup_session_id;
      }
      if (typeof msg.tab === "string") cur.tab = msg.tab;
      if (typeof msg.entered_at === "number") cur.entered_at = msg.entered_at;
      if (typeof msg.had_interaction === "boolean") {
        cur.had_interaction = msg.had_interaction;
      }
    });

    port.onDisconnect.addListener(() => {
      const state = dwellPortState.get(port);
      dwellPortState.delete(port);
      if (!state || !state.tab || !state.entered_at) return;
      // SW-side capture: manually attach the page-side base props
      // (popup_session_id, tab_context) so this event has the same
      // shape as the popup-side popup_tab_dwell from tab-switches.
      capture("popup_tab_dwell", {
        tab: state.tab,
        dwell_ms: Date.now() - state.entered_at,
        had_interaction: state.had_interaction,
        closed_via: "popup_close",
        popup_session_id: state.popup_session_id,
        tab_context: "popup",
      });
    });
  }

  function initAnalytics() {
    chrome.alarms.create("analytics_flush", {
      periodInMinutes: FLUSH_INTERVAL_SECONDS / 60,
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "analytics_flush") flush();
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === "analytics:capture") {
        capture(msg.event, msg.properties).then(() =>
          sendResponse({ ok: true }),
        );
        return true;
      }
      if (msg.type === "analytics:getDistinctId") {
        getDistinctId().then((id) => sendResponse({ id }));
        return true;
      }
      if (msg.type === "analytics:flush") {
        flush().then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg.type === "analytics:paywallEligibilityCheck") {
        paywallEligibilityCheck(
          msg.surface,
          msg.projectedChars,
          msg.fileType,
        ).then(() => sendResponse({ ok: true }));
        return true;
      }
    });

    // Long-lived port from popup → SW. The SW-side disconnect handler
    // is the only reliable signal for "the popup just closed", and
    // that's what fires the popup-close popup_tab_dwell event.
    chrome.runtime.onConnect.addListener(handleDwellPortConnect);

    chrome.runtime.onStartup.addListener(() => flush());

    // Install / update markers. previousVersion comes from Chrome's own
    // event payload, so we don't need to track it ourselves in storage.
    chrome.runtime.onInstalled.addListener((details) => {
      const currentVersion = chrome.runtime.getManifest().version;
      if (details.reason === "install") {
        capture("extension_installed", { version: currentVersion }).then(flush);
      } else if (details.reason === "update") {
        capture("extension_updated", {
          from: details.previousVersion || "unknown",
          to: currentVersion,
        }).then(flush);
      }
    });
  }

  self.analytics = {
    initAnalytics,
    capture,
    flush,
    getDistinctId,
    paywallEligibilityCheck,
    getConsecutiveCharLimitFailures,
    bumpConsecutiveCharLimitFailures,
    resetConsecutiveCharLimitFailures,
  };
})();
