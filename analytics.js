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

  async function capture(eventName, properties = {}) {
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
      if (msg.type === "analytics:getDistinctId") {
        getDistinctId().then((id) => sendResponse({ id }));
        return true;
      }
      if (msg.type === "analytics:flush") {
        flush().then(() => sendResponse({ ok: true }));
        return true;
      }
    });

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
  };
})();
