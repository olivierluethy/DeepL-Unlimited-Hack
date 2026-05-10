// ============================================
// background.js — popup-driven document translation coordinator
// ============================================
// The popup window closes the moment the user clicks back into the DeepL
// tab, so the translation loop cannot live there. The service worker
// owns the loop, persists progress to chrome.storage so the popup can
// reflect it live, and survives across the popup opening/closing.
//
// fullpage.js still has its own in-page translate button (existing
// flow). To avoid a double-run when a user kicks off a translation from
// both surfaces, fullpage.js removes its document from pendingDocuments
// on completion. Both flows reuse content.js's DEEPL_TRANSLATE protocol.

// Shared bucket helpers (bucketChars, bucketFileSize). MUST load before
// analytics.js / paywall.js so anything they fire from top-level has the
// helpers available. Single source of truth — see js/buckets.js.
importScripts('js/buckets.js');

// Shared DeepL helpers (parseDeepLLangs, normalizeErrorType). Same
// rationale — load before any module that fires translation events.
importScripts('js/deepl-utils.js');

// Anonymous usage analytics. Loaded as a classic script so it can hang
// off `self.analytics` and we don't have to flip the SW to module type.
// Listeners (alarm, onMessage for analytics:*) register inside
// initAnalytics() at top level — safe under MV3 SW restart semantics.
importScripts('analytics.js');
self.analytics.initAnalytics();

chrome.runtime.setUninstallURL("https://forms.gle/cFNf17u5CxSQ8d6t6");

// bucketChars() lives in js/buckets.js (shared with popup-side track.js)
// and is attached to `self`. Reference here only.

function classifyError(err) {
  const msg = (err && err.message ? err.message : String(err || '')).toLowerCase();
  if (msg.includes('rate') || msg.includes('429')) return 'rate_limited';
  if (msg.includes('network') || msg.includes('fetch')) return 'network';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  return 'other';
}

// ─── Constants ────────────────────────────────────────────────────────────────
const BATCH_SIZE = 8_000;
const BATCH_TIMEOUT_MS = 8 * 60 * 1_000; // 8 minutes per batch

// ─── In-memory job state (rebuilt on SW wake-up) ──────────────────────────────
// pendingResolvers: requestId -> resolve fn for the in-flight batch promise.
const pendingResolvers = new Map();
// activeBatches: requestId -> { docId, startChars, totalChars } for live progress.
const activeBatches = new Map();
// stopFlags: docId -> { stopRequested } so STOP_DOC can interrupt the loop.
const stopFlags = new Map();

// ─── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'START_DOC') {
    startDocumentTranslation(msg.id, { resume: false })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'RESUME_DOC') {
    // trigger forwarded from popup.js — today only "explicit_button"
    // is wired; "auto_on_load" is reserved for a future auto-resume
    // path on tab open (not implemented yet, see tracking-events.md).
    startDocumentTranslation(msg.id, {
      resume: true,
      resumeTrigger: msg.trigger || 'explicit_button',
    })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'STOP_DOC') {
    const flag = stopFlags.get(msg.id);
    if (flag) flag.stopRequested = true;
    self.analytics.capture('documents_translation_stopped_by_user', {
      run_id: flag ? flag.runId : null,
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'DEEPL_TRANSLATION_COMPLETE') {
    const resolve = pendingResolvers.get(msg.requestId);
    if (resolve) {
      pendingResolvers.delete(msg.requestId);
      resolve(msg);
    }
    return false;
  }

  if (msg.type === 'DEEPL_CHUNK_PROGRESS') {
    const ctx = activeBatches.get(msg.requestId);
    if (!ctx) return false;
    const charsTranslated = ctx.startChars + (msg.charsTranslatedInBatch || 0);
    const progress = Math.min(99, Math.round((charsTranslated / ctx.totalChars) * 100));
    updatePendingDoc(ctx.docId, { progress, charsTranslated });
    return false;
  }
});

// ─── Translation orchestration ────────────────────────────────────────────────
// Fault-tolerant loop. Every batch is a checkpoint: translatedParts +
// lastProcessedIndex are persisted to chrome.storage.local *after* each
// successful batch, so a SW restart, a network glitch, or a user-initiated
// stop never loses already-translated work. The resume path picks up at
// lastProcessedIndex + 1 and re-uses the stored translatedParts.
async function startDocumentTranslation(docId, opts = {}) {
  const { resume = false, resumeTrigger = 'explicit_button' } = opts;
  const doc = await readPendingDoc(docId);
  if (!doc) throw new Error('Document not found.');
  if (doc.status === 'processing') return; // already running — idempotent

  // Synthetic per-run ID so failure/completion events correlate with the
  // start event in PostHog, without leaking the real docId.
  const runId = crypto.randomUUID();
  const runStartedAt = Date.now();
  const totalCharsForAnalytics = (doc.originalText || '').length;
  const batchCountForAnalytics = splitIntoBatches(doc.originalText, BATCH_SIZE).length;

  // Tab + language detection up front, BEFORE the started/resumed
  // event fires. This way every analytics event for this run carries
  // the same {lang_from, lang_to} pair derived from the same tab URL.
  // If there's no DeepL tab, langs stay null — never fall back to a
  // default like en/de; that would silently corrupt language-pair
  // distributions in PostHog.
  const deeplTab = await findDeepLTab();
  const langs = self.parseDeepLLangs
    ? self.parseDeepLLangs(deeplTab && deeplTab.url)
    : { lang_from: null, lang_to: null };

  // Stuck-user counter snapshot at run-start. Attached to every event
  // for this run as `consecutive_char_limit_failures`. Failed events
  // with error_type === 'char_limit' override this with the bumped
  // value (post-increment); the completed event resets it and emits
  // the prior value as `consecutive_char_limit_failures_before_success`.
  const consecutiveAtStart = self.analytics.getConsecutiveCharLimitFailures
    ? await self.analytics.getConsecutiveCharLimitFailures()
    : 0;

  // Properties shared by every analytics event in this run. Spread
  // into each capture() call so they stay consistent — never edit
  // these fields per-event without thinking about whether the event
  // is the right place for the divergence.
  const runEventBase = {
    run_id: runId,
    file_type: doc.fileType || 'unknown',
    lang_from: langs.lang_from,
    lang_to: langs.lang_to,
    total_char_count_bucket: bucketChars(totalCharsForAnalytics),
    // PRIVACY: char count only, never the source/translated text.
    total_char_count_exact: totalCharsForAnalytics,
    consecutive_char_limit_failures: consecutiveAtStart,
  };

  // For resumes, measure how long the doc sat in paused/error state
  // before the user came back. doc.updatedAt is stamped by checkpoint()
  // on every storage write, so it reflects the moment the doc entered
  // the resumable state (last successful batch boundary or pause).
  let timeSinceFailureMs = null;
  if (resume && doc.updatedAt) {
    const ts = new Date(doc.updatedAt).getTime();
    if (!Number.isNaN(ts)) timeSinceFailureMs = Date.now() - ts;
  }

  if (resume) {
    self.analytics.capture('documents_translation_resumed', {
      ...runEventBase,
      page_count: doc.pageCount || 0,
      batch_count: batchCountForAnalytics,
      resume_trigger: resumeTrigger,
      time_since_failure_ms: timeSinceFailureMs,
      previous_status: doc.status || 'unknown',
    });
  } else {
    // Paywall-readiness baseline — only on fresh starts, not resumes
    // (resumes belong to a previously-started run that was already
    // counted from the user's intent-side perspective).
    if (self.analytics && self.analytics.paywallEligibilityCheck) {
      await self.analytics.paywallEligibilityCheck(
        'documents',
        totalCharsForAnalytics,
        doc.fileType || 'unknown',
      );
    }
    self.analytics.capture('documents_translation_started', {
      ...runEventBase,
      page_count: doc.pageCount || 0,
      batch_count: batchCountForAnalytics,
    });
  }

  if (!deeplTab) {
    await pauseDoc(docId, {
      pausedReason: 'no_deepl_tab',
      errorMessage: 'Open www.deepl.com/translator in a tab and click Resume.',
      currentStep: resume ? 'resume_blocked_no_tab' : 'start_blocked_no_tab',
    });
    self.analytics.capture('documents_translation_failed', {
      ...runEventBase,
      error_type: self.normalizeErrorType
        ? self.normalizeErrorType('no_deepl_tab')
        : 'no_deepl_tab',
      batches_completed: 0,
      batches_total: batchCountForAnalytics,
      duration_ms: Date.now() - runStartedAt,
    });
    throw new Error('No DeepL tab found.');
  }

  // First-run cookie cleanup matches the fullpage flow: stops DeepL from
  // showing the free-tier paywall mid-batch. On resume we skip it to avoid
  // tripping the paywall again right after the user just cleared it.
  if (!resume) {
    await cleanDeepLCookies().catch(() => {});
  }

  const stopFlag = { stopRequested: false, runId };
  stopFlags.set(docId, stopFlag);

  const totalChars = (doc.originalText || '').length;
  const batches = splitIntoBatches(doc.originalText, BATCH_SIZE);

  // Resume from the last persisted checkpoint, or start from scratch.
  const startIndex = resume && Number.isInteger(doc.lastProcessedIndex)
    ? Math.max(0, doc.lastProcessedIndex + 1)
    : 0;
  const translatedParts = resume && Array.isArray(doc.translatedParts)
    ? doc.translatedParts.slice()
    : [];
  let completedBatchChars = 0;
  for (let k = 0; k < startIndex && k < batches.length; k++) {
    completedBatchChars += batches[k].length;
  }
  // Counter visible to the catch branch. `let i` in the for-loop is
  // block-scoped, so the unexpected-error handler below can't read
  // the loop index directly. Resumes start at startIndex (those
  // batches were completed in a previous run-effort).
  let batchesCompletedCount = startIndex;

  // Initial checkpoint. On a fresh start we wipe stale fields so a re-run
  // of a completed doc begins clean. On resume we keep translatedParts and
  // lastProcessedIndex untouched.
  await checkpoint(docId, {
    status: 'processing',
    pausedReason: '',
    errorMessage: '',
    progress: pctOf(completedBatchChars, totalChars),
    charsTranslated: completedBatchChars,
    processedCharacters: completedBatchChars,
    totalCharacters: totalChars,
    currentStep: resume
      ? `resuming_at_batch_${startIndex}_of_${batches.length}`
      : `starting_${batches.length}_batches`,
    ...(resume
      ? {}
      : {
          translatedText: '',
          translatedLength: 0,
          completedAt: '',
          translatedParts: [],
          lastProcessedIndex: -1,
        }),
  });

  try {
    for (let i = startIndex; i < batches.length; i++) {
      if (stopFlag.stopRequested) {
        await pauseDoc(docId, {
          pausedReason: 'user',
          errorMessage: '',
          translatedParts,
          lastProcessedIndex: i - 1,
          progress: pctOf(completedBatchChars, totalChars),
          charsTranslated: completedBatchChars,
          processedCharacters: completedBatchChars,
          totalCharacters: totalChars,
          currentStep: `paused_before_batch_${i}`,
        });
        return;
      }

      const batch = batches[i];
      const requestId = `bg-${docId}-${i}-${Date.now()}`;
      activeBatches.set(requestId, {
        docId,
        startChars: completedBatchChars,
        totalChars,
      });

      await checkpoint(docId, {
        currentStep: `translating_batch_${i + 1}_of_${batches.length}`,
      });

      const result = await runBatchOnDeepL({
        tabId: deeplTab.id,
        batch,
        requestId,
      });
      activeBatches.delete(requestId);

      if (!result.success) {
        if (stopFlag.stopRequested) {
          await pauseDoc(docId, {
            pausedReason: 'user',
            errorMessage: '',
            translatedParts,
            lastProcessedIndex: i - 1,
            progress: pctOf(completedBatchChars, totalChars),
            charsTranslated: completedBatchChars,
            processedCharacters: completedBatchChars,
            totalCharacters: totalChars,
            currentStep: `paused_during_batch_${i}`,
          });
          return;
        }

        const reason = result.errorType || 'batch_failed';

        // Char-limit recovery: clear deepl.com cookies via both the
        // chrome.cookies API (covers HttpOnly) and the in-page cookieStore
        // script (covers JS-visible cookies). Then pause so the user can
        // hit Resume — auto-retrying here would re-trip the same paywall.
        if (reason === 'char_limit') {
          await cleanDeepLCookies().catch(() => {});
          await runInPageCookieCleanup(deeplTab.id).catch(() => {});
        }

        const message =
          reason === 'char_limit'
            ? 'DeepL character limit reached. Cookies cleared — click Resume to continue.'
            : reason === 'timeout'
              ? 'Batch timed out. Click Resume to retry from the same checkpoint.'
              : reason === 'dom'
                ? 'DeepL UI changed unexpectedly. Reload DeepL and click Resume.'
                : result.error || 'Translation interrupted — click Resume to continue.';

        await pauseDoc(docId, {
          pausedReason: reason,
          errorMessage: message,
          translatedParts,
          lastProcessedIndex: i - 1,
          progress: pctOf(completedBatchChars, totalChars),
          charsTranslated: completedBatchChars,
          processedCharacters: completedBatchChars,
          totalCharacters: totalChars,
          currentStep: `paused_at_batch_${i}_${reason}`,
        });
        // Bump the stuck-user counter on char_limit failures — the
        // ONLY classifier that produces 'char_limit'. Override the
        // runEventBase value so this event reflects the post-bump
        // count. Other failure types leave the counter alone.
        const normalizedReason = self.normalizeErrorType
          ? self.normalizeErrorType(reason)
          : reason;
        let consecutiveForEvent = consecutiveAtStart;
        if (
          normalizedReason === 'char_limit' &&
          self.analytics.bumpConsecutiveCharLimitFailures
        ) {
          consecutiveForEvent = await self.analytics.bumpConsecutiveCharLimitFailures();
        }
        self.analytics.capture('documents_translation_failed', {
          ...runEventBase,
          consecutive_char_limit_failures: consecutiveForEvent,
          error_type: normalizedReason,
          batches_completed: i,
          batches_total: batches.length,
          duration_ms: Date.now() - runStartedAt,
        });
        return;
      }

      translatedParts.push(result.translatedText || '');
      completedBatchChars += batch.length;
      batchesCompletedCount = i + 1;

      // Atomic checkpoint at the batch boundary: this is the durable
      // resume point. Chunk-level progress is best-effort UI; this row
      // is what survives a SW shutdown / browser crash.
      await checkpoint(docId, {
        progress: pctOf(completedBatchChars, totalChars),
        charsTranslated: completedBatchChars,
        processedCharacters: completedBatchChars,
        totalCharacters: totalChars,
        translatedParts,
        lastProcessedIndex: i,
        currentStep: `completed_batch_${i + 1}_of_${batches.length}`,
      });
    }

    const translatedText = translatedParts.join('\n\n');
    await completeDocument(doc, translatedText);
    // PRIVACY: char counts only — translatedText.length is an integer
    // we already compute for the doc record; we do NOT send the text.
    const outputCharsExact = translatedText.length;

    // Reset the stuck-user counter. The prior value goes onto the
    // event as consecutive_char_limit_failures_before_success — that
    // single property answers "how many times did this user hit the
    // wall before this run finally succeeded?" without correlating
    // sequences in PostHog.
    const consecutiveBeforeSuccess = self.analytics.resetConsecutiveCharLimitFailures
      ? await self.analytics.resetConsecutiveCharLimitFailures()
      : 0;

    self.analytics.capture('documents_translation_completed', {
      ...runEventBase,
      // Override runEventBase value — the counter has just been reset.
      consecutive_char_limit_failures: 0,
      consecutive_char_limit_failures_before_success: consecutiveBeforeSuccess,
      batch_count: batches.length,
      batches_total: batches.length,
      batches_completed: batches.length,
      // Input chars in the canonical naming (alongside total_char_*
      // from runEventBase, which we keep for backward-compat).
      input_char_count_bucket: bucketChars(totalCharsForAnalytics),
      input_char_count_exact: totalCharsForAnalytics,
      output_char_count_bucket: bucketChars(outputCharsExact),
      output_char_count_exact: outputCharsExact,
      duration_ms: Date.now() - runStartedAt,
    });
    // Single end-of-document notification. content.js suppressed the
    // per-batch toasts via the silent flag, so this is the only popup the
    // user sees for a whole-document translation.
    fireDocCompleteToast(deeplTab.id);
  } catch (err) {
    // Network blip, scripting.executeScript failure, or batch-timeout
    // reject. We don't know which batch index has been persisted, so we
    // just flip status without touching translatedParts/lastProcessedIndex
    // — the last-good checkpoint is still in storage.
    const isTimeout = /timed out/i.test(err && err.message || '');
    await pauseDoc(docId, {
      pausedReason: isTimeout ? 'timeout' : 'network',
      errorMessage:
        (err && err.message) || 'Translation failed. Click Resume to retry.',
      currentStep: 'paused_unexpected_error',
    });
    self.analytics.capture('documents_translation_failed', {
      ...runEventBase,
      error_type: self.normalizeErrorType
        ? self.normalizeErrorType(classifyError(err))
        : classifyError(err),
      batches_completed: batchesCompletedCount,
      batches_total: batches.length,
      duration_ms: Date.now() - runStartedAt,
    });
  } finally {
    stopFlags.delete(docId);
    // Wipe any leftover activeBatches entries owned by this doc.
    for (const [reqId, ctx] of activeBatches.entries()) {
      if (ctx.docId === docId) activeBatches.delete(reqId);
    }
  }
}

// Sends one batch to the DeepL tab and waits for content.js to signal
// completion. Resolves with { success, errorType?, error?, translatedText? }
// — never rejects on an in-page failure, only on a hard 8-minute timeout
// (which is a network/SW-stall signal worth surfacing to the catch).
function runBatchOnDeepL({ tabId, batch, requestId }) {
  return new Promise((resolve, reject) => {
    pendingResolvers.set(requestId, resolve);

    const timer = setTimeout(() => {
      if (pendingResolvers.has(requestId)) {
        pendingResolvers.delete(requestId);
        reject(new Error('Batch timed out after 8 minutes.'));
      }
    }, BATCH_TIMEOUT_MS);

    chrome.scripting
      .executeScript({
        target: { tabId },
        function: (payload, reqId) => {
          window.postMessage(
            { type: 'DEEPL_TRANSLATE', payload, requestId: reqId, silent: true },
            '*',
          );
        },
        args: [batch, requestId],
      })
      .catch((err) => {
        clearTimeout(timer);
        if (pendingResolvers.has(requestId)) {
          pendingResolvers.delete(requestId);
        }
        reject(err);
      });
  });
}

// Stamps every storage write so the popup can show "last updated N seconds
// ago" and so the persisted shape matches the documented spec
// (documentId / status / currentStep / lastProcessedIndex / processedCharacters /
//  totalCharacters / updatedAt).
function checkpoint(docId, patch) {
  return updatePendingDoc(docId, {
    documentId: docId,
    updatedAt: new Date().toISOString(),
    ...patch,
  });
}

function pauseDoc(docId, patch) {
  return checkpoint(docId, {
    status: 'paused',
    ...patch,
  });
}

function pctOf(done, total) {
  if (!total) return 0;
  return Math.min(99, Math.round((done / total) * 100));
}

// In-page cookieStore cleanup. Runs in MAIN world so we get the page's
// own cookieStore (the isolated content-script world doesn't always
// expose it). Defensive: cookieStore is only on https + relatively new
// Chrome, and individual deletes can throw on session/HttpOnly cookies
// — every per-cookie call is caught so one failure can't abort the rest.
async function runInPageCookieCleanup(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      try {
        if (typeof cookieStore === 'undefined') return;
        const cookies = await cookieStore.getAll();
        await Promise.all(
          cookies.map((cookie) =>
            cookieStore
              .delete({
                name: cookie.name,
                domain: cookie.domain,
                path: cookie.path,
              })
              .catch(() => {}),
          ),
        );
        console.log('[DeepL Unlimited] Removable cookies cleared.');
      } catch (e) {
        // Swallow — cookieStore failures must not abort the workflow.
      }
    },
  });
}

// ─── Storage helpers ──────────────────────────────────────────────────────────
function readPendingDoc(docId) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ pendingDocuments: [] }, ({ pendingDocuments }) => {
      resolve(pendingDocuments.find((d) => d.id === docId) || null);
    });
  });
}

function updatePendingDoc(docId, patch) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ pendingDocuments: [] }, ({ pendingDocuments }) => {
      const next = pendingDocuments.map((d) => (d.id === docId ? { ...d, ...patch } : d));
      chrome.storage.local.set({ pendingDocuments: next }, resolve);
    });
  });
}

function removePendingDoc(docId) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ pendingDocuments: [] }, ({ pendingDocuments }) => {
      const next = pendingDocuments.filter((d) => d.id !== docId);
      chrome.storage.local.set({ pendingDocuments: next }, resolve);
    });
  });
}

// On success, archive a copy to pdfHistory (so the full-page History list
// still picks it up untouched) AND mark the source doc as 'completed' in
// pendingDocuments so it stays visible in the popup. The user can then
// re-run it via Start, or remove it via the Delete button.
//
// Also writes a SINGLE verlauf entry per completed document so the popup's
// History tab shows exactly one row per Documents-tab translation,
// regardless of how many internal batches were used.
async function completeDocument(doc, translatedText) {
  const timestamp = new Date().toISOString();

  const pdfEntry = {
    id: crypto.randomUUID(),
    sourceId: doc.id,
    timestamp,
    createdAt: doc.createdAt || timestamp,
    filename: doc.filename,
    fileType: doc.fileType,
    pageCount: doc.pageCount || 0,
    originalText: doc.originalText,
    originalLength: (doc.originalText || '').length,
    translatedLength: translatedText.length,
    translatedText,
  };

  const verlaufEntry = {
    id: crypto.randomUUID(),
    timestamp,
    original: doc.originalText,
    translated: translatedText,
  };

  // Single combined storage write — both archives populated atomically.
  await new Promise((resolve) => {
    chrome.storage.local.get({ pdfHistory: [], verlauf: [] }, ({ pdfHistory, verlauf }) => {
      chrome.storage.local.set(
        {
          pdfHistory: [...pdfHistory, pdfEntry],
          verlauf: [...verlauf, verlaufEntry],
        },
        resolve,
      );
    });
  });

  await updatePendingDoc(doc.id, {
    status: 'completed',
    progress: 100,
    charsTranslated: (doc.originalText || '').length,
    translatedText,
    translatedLength: translatedText.length,
    completedAt: timestamp,
    errorMessage: '',
  });
}

// Best-effort one-shot toast in the DeepL tab. The .catch swallows the
// error if the user closed the tab between the last batch and now —
// translation already succeeded, the toast is just confirmation.
function fireDocCompleteToast(tabId) {
  return chrome.scripting
    .executeScript({
      target: { tabId },
      function: () => {
        window.postMessage(
          {
            type: 'DEEPL_DOC_TOAST',
            message: '✅ Done! Entry saved. Viewable in history.',
          },
          '*',
        );
      },
    })
    .catch(() => {});
}

// ─── Helpers shared with fullpage.js (kept inline so the SW is standalone) ────
async function findDeepLTab() {
  const deeplRegex = /^https:\/\/www\.deepl\.com\/[^/]+\/(translate|translator|write)/;
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.url && deeplRegex.test(t.url)) || null;
}

async function cleanDeepLCookies() {
  const cookies = await chrome.cookies.getAll({ domain: 'deepl.com' });
  if (!cookies.length) return 0;
  await Promise.all(
    cookies.map((c) => {
      const scheme = c.secure ? 'https' : 'http';
      const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      return chrome.cookies.remove({ url: `${scheme}://${host}${c.path}`, name: c.name });
    }),
  );
  return cookies.length;
}

// Splits `text` into chunks ≤ batchSize chars at paragraph or word boundaries.
// Mirrors the splitter in fullpage.js so behavior is identical.
function splitIntoBatches(text, batchSize) {
  if (!text) return [];
  if (text.length <= batchSize) return [text];

  const batches = [];
  let start = 0;
  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= batchSize) {
      const last = text.slice(start);
      if (last.trim()) batches.push(last);
      break;
    }
    let end = start + batchSize;
    const half = start + Math.floor(batchSize / 2);
    const paraIdx = text.lastIndexOf('\n\n', end);
    if (paraIdx >= half) {
      end = paraIdx + 2;
    } else {
      const spaceIdx = text.lastIndexOf(' ', end);
      if (spaceIdx >= half) end = spaceIdx + 1;
    }
    const chunk = text.slice(start, end);
    if (chunk.trim()) batches.push(chunk);
    start = end;
  }
  return batches;
}
