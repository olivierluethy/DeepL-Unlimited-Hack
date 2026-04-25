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

chrome.runtime.setUninstallURL("https://forms.gle/cFNf17u5CxSQ8d6t6");

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
    startDocumentTranslation(msg.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'STOP_DOC') {
    const flag = stopFlags.get(msg.id);
    if (flag) flag.stopRequested = true;
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
async function startDocumentTranslation(docId) {
  const doc = await readPendingDoc(docId);
  if (!doc) throw new Error('Document not found.');
  if (doc.status === 'processing') return; // already running — idempotent

  const deeplTab = await findDeepLTab();
  if (!deeplTab) {
    await updatePendingDoc(docId, {
      status: 'error',
      errorMessage: 'Open www.deepl.com/translator in a tab and try again.',
    });
    throw new Error('No DeepL tab found.');
  }

  // Best-effort cookie cleanup matches the fullpage flow: stops DeepL from
  // showing the free-tier paywall mid-batch, which would otherwise interrupt
  // long-running translations.
  await cleanDeepLCookies().catch(() => {});

  const stopFlag = { stopRequested: false };
  stopFlags.set(docId, stopFlag);

  // Reset stale fields so a re-run of a completed doc starts clean.
  await updatePendingDoc(docId, {
    status: 'processing',
    progress: 0,
    charsTranslated: 0,
    errorMessage: '',
    translatedText: '',
    translatedLength: 0,
    completedAt: '',
  });

  try {
    const batches = splitIntoBatches(doc.originalText, BATCH_SIZE);
    const totalChars = doc.originalText.length;
    const translatedParts = [];
    let completedBatchChars = 0;

    for (let i = 0; i < batches.length; i++) {
      if (stopFlag.stopRequested) {
        await updatePendingDoc(docId, { status: 'idle', progress: 0, charsTranslated: 0 });
        return;
      }

      const batch = batches[i];
      const requestId = `bg-${docId}-${i}-${Date.now()}`;
      activeBatches.set(requestId, {
        docId,
        startChars: completedBatchChars,
        totalChars,
      });

      const completion = new Promise((resolve, reject) => {
        pendingResolvers.set(requestId, resolve);
        setTimeout(() => {
          if (pendingResolvers.has(requestId)) {
            pendingResolvers.delete(requestId);
            reject(new Error('Batch timed out after 8 minutes.'));
          }
        }, BATCH_TIMEOUT_MS);
      });

      await chrome.scripting.executeScript({
        target: { tabId: deeplTab.id },
        function: (payload, reqId) => {
          window.postMessage({ type: 'DEEPL_TRANSLATE', payload, requestId: reqId }, '*');
        },
        args: [batch, requestId],
      });

      const result = await completion;
      activeBatches.delete(requestId);

      if (!result.success) {
        if (stopFlag.stopRequested) {
          await updatePendingDoc(docId, { status: 'idle', progress: 0, charsTranslated: 0 });
          return;
        }
        throw new Error(result.error || 'Translation cancelled.');
      }

      translatedParts.push(result.translatedText || '');
      completedBatchChars += batch.length;

      // Persist a checkpoint at each batch boundary as well as on every chunk:
      // chunk-level updates may miss the final tick of a batch.
      await updatePendingDoc(docId, {
        progress: Math.min(99, Math.round((completedBatchChars / totalChars) * 100)),
        charsTranslated: completedBatchChars,
      });
    }

    const translatedText = translatedParts.join('\n\n');
    await completeDocument(doc, translatedText);
  } catch (err) {
    await updatePendingDoc(docId, {
      status: 'error',
      errorMessage: err.message || 'Translation failed.',
    });
  } finally {
    stopFlags.delete(docId);
    // Wipe any leftover activeBatches entries owned by this doc.
    for (const [reqId, ctx] of activeBatches.entries()) {
      if (ctx.docId === docId) activeBatches.delete(reqId);
    }
  }
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
async function completeDocument(doc, translatedText) {
  const entry = {
    id: crypto.randomUUID(),
    sourceId: doc.id,
    timestamp: new Date().toISOString(),
    createdAt: doc.createdAt || new Date().toISOString(),
    filename: doc.filename,
    fileType: doc.fileType,
    pageCount: doc.pageCount || 0,
    originalText: doc.originalText,
    originalLength: (doc.originalText || '').length,
    translatedLength: translatedText.length,
    translatedText,
  };

  await new Promise((resolve) => {
    chrome.storage.local.get({ pdfHistory: [] }, ({ pdfHistory }) => {
      chrome.storage.local.set({ pdfHistory: [...pdfHistory, entry] }, resolve);
    });
  });

  await updatePendingDoc(doc.id, {
    status: 'completed',
    progress: 100,
    charsTranslated: (doc.originalText || '').length,
    translatedText,
    translatedLength: translatedText.length,
    completedAt: new Date().toISOString(),
    errorMessage: '',
  });
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
