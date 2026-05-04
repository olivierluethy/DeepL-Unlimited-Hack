// ============================================
// analytics.js — PostHog client for Chrome MV3 service worker
// ============================================
// Loaded into background.js via importScripts(). Exposes self.analytics
// as the integration surface; other contexts (popup, options, content
// scripts on extension pages) talk to it via chrome.runtime.sendMessage
// with type "analytics:*". See track.js for the page-side helper.
//
// Hard rules enforced here:
//   - No event leaves the device unless consent === "granted".
//   - Translated text never enters this module (callers send metadata).
//   - The queue is bounded (MAX_QUEUE_SIZE) so a long offline stretch
//     can't grow chrome.storage indefinitely.

(function () {
  "use strict";

  // TODO: replace before publishing — see README/Web Store dashboard.
  const POSTHOG_API_KEY = "phc_vdh5V2RdTvv78E778stRjmNqXf7LNwEEhPhHteafYvLG";
  const POSTHOG_HOST = "https://eu.i.posthog.com";

  const STORAGE_KEYS = {
    DISTINCT_ID: "analytics_distinct_id",
    CONSENT: "analytics_consent",
    QUEUE: "analytics_queue",
    EXTENSION_VERSION: "analytics_last_version",
  };

  const FLUSH_INTERVAL_SECONDS = 30;
  const MAX_QUEUE_SIZE = 200;
  const MAX_BATCH_SIZE = 50;

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

  async function getConsent() {
    const { [STORAGE_KEYS.CONSENT]: consent } = await chrome.storage.local.get(
      STORAGE_KEYS.CONSENT,
    );
    return consent;
  }

  async function setConsent(value) {
    await chrome.storage.local.set({ [STORAGE_KEYS.CONSENT]: value });

    if (value === "granted") {
      // First-grant emits an install/update marker so we can age the
      // user-base in PostHog. Skipped on every subsequent grant flip.
      const { [STORAGE_KEYS.EXTENSION_VERSION]: lastVersion } =
        await chrome.storage.local.get(STORAGE_KEYS.EXTENSION_VERSION);
      const currentVersion = chrome.runtime.getManifest().version;
      if (!lastVersion) {
        await capture("extension_installed", { version: currentVersion });
      } else if (lastVersion !== currentVersion) {
        await capture("extension_updated", {
          from: lastVersion,
          to: currentVersion,
        });
      }
      await chrome.storage.local.set({
        [STORAGE_KEYS.EXTENSION_VERSION]: currentVersion,
      });
      await flush();
    } else {
      // Withdrawal of consent: drop everything that hasn't shipped yet.
      await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: [] });
    }
  }

  async function capture(eventName, properties = {}) {
    const consent = await getConsent();
    if (consent !== "granted") return;

    const distinctId = await getDistinctId();
    const manifest = chrome.runtime.getManifest();

    const event = {
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

    const { [STORAGE_KEYS.QUEUE]: queue = [] } = await chrome.storage.local.get(
      STORAGE_KEYS.QUEUE,
    );
    queue.push(event);
    if (queue.length > MAX_QUEUE_SIZE) {
      queue.splice(0, queue.length - MAX_QUEUE_SIZE);
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: queue });
  }

  async function flush() {
    const consent = await getConsent();
    if (consent !== "granted") return;

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
      if (msg.type === "analytics:setConsent") {
        setConsent(msg.value).then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg.type === "analytics:getConsent") {
        getConsent().then((value) => sendResponse({ value }));
        return true;
      }
      if (msg.type === "analytics:flush") {
        flush().then(() => sendResponse({ ok: true }));
        return true;
      }
    });

    chrome.runtime.onStartup.addListener(() => flush());
  }

  self.analytics = {
    initAnalytics,
    capture,
    flush,
    setConsent,
    getConsent,
    getDistinctId,
  };
})();
