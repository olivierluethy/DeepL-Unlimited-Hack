// ============================================
// fullpage.js — PDF Upload & Translation Pipeline
// ============================================

// Configure PDF.js worker (must run before any getDocument call)
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('js/pdf.worker.min.js');
}

// ─── Constants ────────────────────────────────────────────────────────────────
// Each batch is sent as one request to content.js, which further splits it into
// ~1 500-char DeepL chunks internally.  8 000 chars → ≤6 DeepL chunks →
// worst-case batch time ≈ 6 × 31 s = 186 s, well inside the 8-min timeout.
const BATCH_SIZE = 8_000;
const BATCH_TIMEOUT_MS = 8 * 60 * 1_000; // 8 minutes per batch

// ─── Module-level state ───────────────────────────────────────────────────────
let currentFile = null;
let extractedText = '';
let extractedPageCount = 0;
let lastTranslatedPdfBytes = null;
let stopRequested = false;
const pendingTranslations = new Map();

// Filled in startPipeline / translateViaDeepL to let the progress handler know
// which batch is currently in flight.
// Shape: { requestId, startChars, totalChars, batchIdx, batchCount }
let activeBatch = null;

// Ref to the cookie-change listener so we can remove it when done
let cookieMonitorListener = null;

// ─── Runtime message listener ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  // ── Completion signal ──
  if (message.type === 'DEEPL_TRANSLATION_COMPLETE') {
    const resolver = pendingTranslations.get(message.requestId);
    if (resolver) {
      resolver(message);
      pendingTranslations.delete(message.requestId);
    }
    return;
  }

  // ── Per-chunk progress from content.js ──
  // content.js sends this after every ~1 500-char DeepL sub-chunk completes,
  // giving us character-accurate real-time progress.
  if (message.type === 'DEEPL_CHUNK_PROGRESS' && activeBatch) {
    if (message.requestId !== activeBatch.requestId) return; // wrong batch

    const charsTranslated = activeBatch.startChars + message.charsTranslatedInBatch;
    // Map translated chars to 12–90 % of the progress bar (10 % for extraction,
    // 2 % for cookie cleanup already consumed; 10 % reserved for PDF generation).
    const pct = Math.min(89, Math.round((charsTranslated / activeBatch.totalChars) * 78) + 12);

    updateProgress(
      pct,
      `Translating — batch ${activeBatch.batchIdx + 1} / ${activeBatch.batchCount}`,
    );
    updateCharCounter(charsTranslated, activeBatch.totalChars);
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initUploadUI();
  loadPdfHistory();
});

// ─── Upload UI wiring ─────────────────────────────────────────────────────────
function initUploadUI() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('pdfFileInput');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') {
      handleFileSelected(file);
    } else {
      showAlert('Please drop a PDF file.', 'warning');
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFileSelected(e.target.files[0]);
  });

  document.getElementById('translateBtn').addEventListener('click', startPipeline);

  document.getElementById('stopBtn').addEventListener('click', () => {
    stopRequested = true;
    // Cancel any in-flight batch promise immediately
    for (const [key, resolver] of pendingTranslations.entries()) {
      resolver({ success: false, cancelled: true });
      pendingTranslations.delete(key);
    }
    activeBatch = null;
    stopCookieMonitor();
    document.getElementById('stopBtn').classList.add('d-none');
    document.getElementById('translateBtn').disabled = false;
    hideCharCounter();
    hideCookieStatus();
    showAlert('Translation stopped by user.', 'warning');
    resetSteps();
  });

  document.getElementById('downloadBtn').addEventListener('click', () => {
    if (!lastTranslatedPdfBytes) return;
    const baseName = (currentFile?.name || 'translation').replace(/\.pdf$/i, '');
    triggerPdfDownload(lastTranslatedPdfBytes, `${baseName}_translated.pdf`);
  });

  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    if (confirm('Clear all PDF translation history?')) {
      chrome.storage.local.set({ pdfHistory: [] }, loadPdfHistory);
    }
  });
}

// ─── File selection & text extraction ────────────────────────────────────────
async function handleFileSelected(file) {
  currentFile = file;
  extractedText = '';
  extractedPageCount = 0;
  lastTranslatedPdfBytes = null;

  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatFileSize(file.size);
  document.getElementById('fileInfo').classList.remove('d-none');
  document.getElementById('pageCountInfo').classList.add('d-none');
  document.getElementById('charCountInfo').classList.add('d-none');
  document.getElementById('downloadBtn').classList.add('d-none');
  document.getElementById('translateBtn').disabled = true;
  clearAlert();
  resetSteps();
  hideCharCounter();
  hideCookieStatus();

  document.getElementById('progressSection').classList.remove('d-none');
  setStep('extract', 'active');
  updateProgress(5, 'Reading PDF…');

  try {
    const result = await extractTextFromPDF(file);
    extractedText = result.text;
    extractedPageCount = result.pageCount;

    document.getElementById('pageCount').textContent = result.pageCount;
    document.getElementById('charCount').textContent = result.text.length.toLocaleString();
    document.getElementById('pageCountInfo').classList.remove('d-none');
    document.getElementById('charCountInfo').classList.remove('d-none');

    setStep('extract', 'done');
    updateProgress(
      10,
      `Ready — ${result.pageCount} page${result.pageCount !== 1 ? 's' : ''}, ` +
        `${result.text.length.toLocaleString()} characters`,
    );
    document.getElementById('translateBtn').disabled = false;
  } catch (err) {
    setStep('extract', 'error');
    updateProgress(0, 'Extraction failed');
    showAlert('Could not read PDF: ' + err.message, 'danger');
  }
}

async function extractTextFromPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pageTexts = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Collapse whitespace runs; trim each page individually
    const pageText = content.items
      .map((item) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (pageText) pageTexts.push(pageText);
  }

  return { text: pageTexts.join('\n\n'), pageCount: pdf.numPages };
}

// ─── Main pipeline ────────────────────────────────────────────────────────────
async function startPipeline() {
  if (!currentFile || !extractedText) return;

  stopRequested = false;
  lastTranslatedPdfBytes = null;
  activeBatch = null;

  document.getElementById('translateBtn').disabled = true;
  document.getElementById('stopBtn').classList.remove('d-none');
  document.getElementById('downloadBtn').classList.add('d-none');
  clearAlert();

  try {
    // ── 1. Find DeepL translator tab ──────────────────────────────────────────
    const allTabs = await chrome.tabs.query({ url: '*://www.deepl.com/*' });
    const deeplRegex = /^https:\/\/www\.deepl\.com\/[^/]+\/(translate|write|translator)/;
    const deeplTab = allTabs.find((t) => deeplRegex.test(t.url));
    if (!deeplTab) {
      throw new Error(
        'No DeepL translator tab found. Open www.deepl.com/translator and try again.',
      );
    }

    // ── 2. Cookie cleanup ─────────────────────────────────────────────────────
    updateProgress(10, 'Cleaning up DeepL cookies…');
    const removedCount = await cleanDeepLCookies();
    showCookieStatus(
      removedCount > 0
        ? `${removedCount} DeepL cookie${removedCount !== 1 ? 's' : ''} removed`
        : 'No DeepL cookies found',
    );
    cookieMonitorListener = startCookieMonitor(); // delete any new ones during translation

    // ── 3. Split into batches ─────────────────────────────────────────────────
    const batches = splitIntoBatches(extractedText, BATCH_SIZE);
    const totalChars = extractedText.length;
    const totalBatches = batches.length;
    const translatedParts = [];
    let completedBatchChars = 0;

    setStep('translate', 'active');
    showCharCounter(0, totalChars);
    updateProgress(
      12,
      `Starting translation — ${totalBatches} batch${totalBatches !== 1 ? 'es' : ''}…`,
    );

    // ── 4. Translate each batch sequentially ──────────────────────────────────
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      if (stopRequested) break;

      const batch = batches[batchIdx];

      // activeBatch is read by the DEEPL_CHUNK_PROGRESS handler.
      // requestId is filled in by translateViaDeepL below.
      activeBatch = {
        requestId: null,
        startChars: completedBatchChars,
        totalChars,
        batchIdx,
        batchCount: totalBatches,
      };

      const startPct = Math.max(12, Math.round((completedBatchChars / totalChars) * 78) + 12);
      updateProgress(startPct, `Translating — batch ${batchIdx + 1} / ${totalBatches}…`);

      const translated = await translateViaDeepL(batch, deeplTab.id);
      translatedParts.push(translated);
      completedBatchChars += batch.length;
    }

    activeBatch = null;
    if (stopRequested) return;

    // Mark translate step done; show final char count
    setStep('translate', 'done');
    updateCharCounter(totalChars, totalChars);
    updateProgress(90, 'Generating PDF…');

    // ── 5. Generate translated PDF ────────────────────────────────────────────
    setStep('generate', 'active');
    const translatedText = translatedParts.join('\n\n');
    const pdfBytes = await createTranslatedPDF(currentFile.name, translatedText);
    setStep('generate', 'done');
    updateProgress(100, 'Done!');
    lastTranslatedPdfBytes = pdfBytes;

    // ── 6. Persist to PDF history ─────────────────────────────────────────────
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      filename: currentFile.name,
      pageCount: extractedPageCount,
      originalLength: extractedText.length,
      translatedLength: translatedText.length,
      translatedText,
    };
    chrome.storage.local.get({ pdfHistory: [] }, ({ pdfHistory }) => {
      chrome.storage.local.set({ pdfHistory: [...pdfHistory, entry] }, loadPdfHistory);
    });

    document.getElementById('downloadBtn').classList.remove('d-none');
    showAlert('Translation complete! Click "Download PDF" to save.', 'success');
  } catch (err) {
    if (!stopRequested) {
      showAlert(err.message, 'danger');
      setStep('translate', 'error');
    }
  } finally {
    activeBatch = null;
    stopCookieMonitor();
    document.getElementById('stopBtn').classList.add('d-none');
    document.getElementById('translateBtn').disabled = false;
  }
}

// ─── DeepL translation (one batch) ───────────────────────────────────────────
async function translateViaDeepL(text, tabId) {
  const requestId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  // Link this requestId so the DEEPL_CHUNK_PROGRESS handler can filter messages
  if (activeBatch) activeBatch.requestId = requestId;

  // Record time before injecting so the verlauf fallback can find the right entry
  const beforeTime = new Date().toISOString();

  const completionPromise = new Promise((resolve, reject) => {
    pendingTranslations.set(requestId, resolve);
    setTimeout(() => {
      if (pendingTranslations.has(requestId)) {
        pendingTranslations.delete(requestId);
        reject(new Error('Batch timed out after 8 minutes. Try with a shorter PDF.'));
      }
    }, BATCH_TIMEOUT_MS);
  });

  // Inject the window.postMessage into the DeepL tab
  await chrome.scripting.executeScript({
    target: { tabId },
    function: (payload, reqId) => {
      window.postMessage({ type: 'DEEPL_TRANSLATE', payload, requestId: reqId }, '*');
    },
    args: [text, requestId],
  });

  const result = await completionPromise;
  if (!result.success) throw new Error('Translation was cancelled.');

  // Prefer translatedText carried directly in the completion message (content.js
  // now includes it), avoiding an extra storage round-trip.
  if (result.translatedText) return result.translatedText;

  // Fallback: read from verlauf (backward-compat with older content.js versions)
  return new Promise((resolve, reject) => {
    chrome.storage.local.get({ verlauf: [] }, ({ verlauf }) => {
      for (let i = verlauf.length - 1; i >= 0; i--) {
        if (verlauf[i].timestamp >= beforeTime) return resolve(verlauf[i].translated);
      }
      if (verlauf.length > 0) resolve(verlauf[verlauf.length - 1].translated);
      else reject(new Error('No translation result found in history.'));
    });
  });
}

// ─── Batch splitting ──────────────────────────────────────────────────────────
// Splits `text` into chunks ≤ `batchSize` chars, preferring paragraph breaks
// (double newlines) or word boundaries so sentences stay intact.
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

    // Prefer paragraph boundary (double newline) in the second half of the window
    const paraIdx = text.lastIndexOf('\n\n', end);
    if (paraIdx >= half) {
      end = paraIdx + 2; // include the double newline in this batch
    } else {
      // Fall back to word boundary (space)
      const spaceIdx = text.lastIndexOf(' ', end);
      if (spaceIdx >= half) {
        end = spaceIdx + 1;
      }
      // Last resort: hard-cut exactly at batchSize (never exceeds limit)
    }

    const chunk = text.slice(start, end);
    if (chunk.trim()) batches.push(chunk);
    start = end;
  }

  return batches;
}

// ─── Cookie management ────────────────────────────────────────────────────────
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

function startCookieMonitor() {
  const listener = (info) => {
    if (info.removed) return; // we only care about newly set/updated cookies
    if (!info.cookie.domain.includes('deepl')) return;
    const c = info.cookie;
    const scheme = c.secure ? 'https' : 'http';
    const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    chrome.cookies.remove({ url: `${scheme}://${host}${c.path}`, name: c.name });
  };
  chrome.cookies.onChanged.addListener(listener);
  return listener;
}

function stopCookieMonitor() {
  if (cookieMonitorListener) {
    chrome.cookies.onChanged.removeListener(cookieMonitorListener);
    cookieMonitorListener = null;
  }
}

// ─── PDF generation (pdf-lib) ─────────────────────────────────────────────────
async function createTranslatedPDF(originalFilename, text) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  const pdfDoc = await PDFDocument.create();
  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const W = 595, H = 842;   // A4 in points
  const mx = 50, mTop = 65, mBot = 50;
  const cW = W - 2 * mx;   // usable content width
  const sz = 11, lh = sz * 1.55;

  let page = pdfDoc.addPage([W, H]);
  let y = H - mTop;

  // Header
  const baseName = originalFilename.replace(/\.pdf$/i, '');
  page.drawText('Translation: ' + baseName, {
    x: mx, y, font: boldFont, size: 13, color: rgb(0.05, 0.27, 0.98),
  });
  y -= lh;
  page.drawText(new Date().toLocaleString(), {
    x: mx, y, font, size: 9, color: rgb(0.5, 0.5, 0.5),
  });
  y -= lh * 0.6;
  page.drawLine({
    start: { x: mx, y }, end: { x: W - mx, y },
    thickness: 0.5, color: rgb(0.8, 0.8, 0.8),
  });
  y -= lh * 1.4;

  const needsNewPage = () => y < mBot + lh;
  const newPage = () => { page = pdfDoc.addPage([W, H]); y = H - mTop; };

  function drawOneLine(str) {
    if (needsNewPage()) newPage();
    page.drawText(str, { x: mx, y, font, size: sz, color: rgb(0, 0, 0) });
    y -= lh;
  }

  function drawWrapped(str) {
    if (!str.trim()) return;
    const words = str.split(' ');
    let line = '';
    for (const word of words) {
      if (!word) continue;
      const candidate = line ? line + ' ' + word : word;
      let w;
      try { w = font.widthOfTextAtSize(candidate, sz); }
      catch { w = candidate.length * sz * 0.6; }
      if (w > cW && line) { drawOneLine(line); line = word; }
      else line = candidate;
    }
    if (line) drawOneLine(line);
  }

  for (const para of text.split('\n')) {
    const trimmed = para.trim();
    if (!trimmed) {
      y -= lh * 0.5;
      if (needsNewPage()) newPage();
    } else {
      drawWrapped(trimmed);
      y -= lh * 0.25; // paragraph spacing
    }
  }

  return await pdfDoc.save();
}

// ─── History ──────────────────────────────────────────────────────────────────
function loadPdfHistory() {
  chrome.storage.local.get({ pdfHistory: [] }, ({ pdfHistory }) => {
    const container = document.getElementById('pdfHistoryList');
    const clearBtn  = document.getElementById('clearHistoryBtn');

    if (!pdfHistory.length) {
      container.innerHTML = '<p class="text-muted small">No PDF translations yet.</p>';
      clearBtn.classList.add('d-none');
      return;
    }

    clearBtn.classList.remove('d-none');
    container.innerHTML = '';

    [...pdfHistory].reverse().forEach((entry) => {
      const card = document.createElement('div');
      card.className = 'card mb-2 shadow-sm';
      card.innerHTML = `
        <div class="card-body py-2 px-3">
          <div class="d-flex align-items-center gap-2">
            <i class="bi bi-file-pdf-fill text-danger fs-5 flex-shrink-0"></i>
            <div style="min-width:0; flex:1;">
              <div class="fw-semibold text-truncate" title="${sanitize(entry.filename)}">${sanitize(entry.filename)}</div>
              <small class="text-muted">
                ${new Date(entry.timestamp).toLocaleString()} &middot;
                ${entry.pageCount} page${entry.pageCount !== 1 ? 's' : ''} &middot;
                ${(entry.translatedLength || 0).toLocaleString()} chars
              </small>
            </div>
            <div class="d-flex gap-1 flex-shrink-0">
              <button class="btn btn-sm btn-outline-primary dl-btn" title="Download translated PDF">
                <i class="bi bi-download"></i>
              </button>
              <button class="btn btn-sm btn-outline-danger del-btn" title="Delete entry">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </div>
        </div>`;

      card.querySelector('.dl-btn').addEventListener('click', async function () {
        this.disabled = true;
        this.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
        try {
          const bytes = await createTranslatedPDF(entry.filename, entry.translatedText);
          triggerPdfDownload(bytes, entry.filename.replace(/\.pdf$/i, '') + '_translated.pdf');
        } catch (e) {
          alert('Error generating PDF: ' + e.message);
        } finally {
          this.disabled = false;
          this.innerHTML = '<i class="bi bi-download"></i>';
        }
      });

      card.querySelector('.del-btn').addEventListener('click', () => {
        if (confirm('Delete this PDF translation?')) {
          chrome.storage.local.get({ pdfHistory: [] }, ({ pdfHistory }) => {
            chrome.storage.local.set(
              { pdfHistory: pdfHistory.filter((e) => e.id !== entry.id) },
              loadPdfHistory,
            );
          });
        }
      });

      container.appendChild(card);
    });
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function triggerPdfDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

function setStep(stepId, state) {
  const el = document.getElementById('step-' + stepId);
  if (!el) return;
  const icon = el.querySelector('i');
  if (!icon) return;
  icon.className = 'bi';
  el.className = 'step-item step-' + state;
  switch (state) {
    case 'done':   icon.classList.add('bi-check-circle-fill', 'text-success'); break;
    case 'active': icon.classList.add('bi-arrow-clockwise', 'text-primary', 'spin'); break;
    case 'error':  icon.classList.add('bi-x-circle-fill', 'text-danger'); break;
    default:       icon.classList.add('bi-circle', 'text-muted');
  }
}

function resetSteps() {
  ['extract', 'translate', 'generate'].forEach((s) => setStep(s, 'idle'));
  updateProgress(0, '');
}

function updateProgress(percent, label) {
  const bar    = document.getElementById('mainProgressBar');
  const labelEl = document.getElementById('progressLabel');
  const pctEl  = document.getElementById('progressPercent');
  if (!bar) return;

  bar.style.width = percent + '%';
  bar.setAttribute('aria-valuenow', percent);

  if (percent >= 100) {
    bar.classList.remove('progress-bar-animated', 'progress-bar-striped', 'bg-primary', 'bg-danger');
    bar.classList.add('bg-success');
  } else if (percent > 0) {
    bar.classList.remove('bg-success', 'bg-danger');
    bar.classList.add('progress-bar-animated', 'progress-bar-striped', 'bg-primary');
  }

  if (labelEl) labelEl.textContent = label;
  if (pctEl)   pctEl.textContent   = percent + '%';
}

// Character counter
function showCharCounter(processed, total) {
  const row = document.getElementById('charsProgressRow');
  if (row) row.classList.remove('d-none');
  updateCharCounter(processed, total);
}

function updateCharCounter(processed, total) {
  const pEl = document.getElementById('charsProcessed');
  const tEl = document.getElementById('charsTotal');
  const pctEl = document.getElementById('charsPct');
  if (pEl) pEl.textContent = processed.toLocaleString();
  if (tEl) tEl.textContent = total.toLocaleString();
  if (pctEl) {
    const p = total > 0 ? Math.round((processed / total) * 100) : 0;
    pctEl.textContent = p + '%';
  }
}

function hideCharCounter() {
  const row = document.getElementById('charsProgressRow');
  if (row) row.classList.add('d-none');
}

// Cookie status
function showCookieStatus(msg) {
  const row = document.getElementById('cookieStatusRow');
  const txt = document.getElementById('cookieStatusText');
  if (txt) txt.textContent = msg;
  if (row) row.classList.remove('d-none');
}

function hideCookieStatus() {
  const row = document.getElementById('cookieStatusRow');
  if (row) row.classList.add('d-none');
}

function showAlert(message, type) {
  const area = document.getElementById('alertArea');
  if (!area) return;
  area.innerHTML = `
    <div class="alert alert-${type} alert-dismissible py-2 mb-0" role="alert">
      ${sanitize(message)}
      <button type="button" class="btn-close btn-sm" data-bs-dismiss="alert"></button>
    </div>`;
}

function clearAlert() {
  const area = document.getElementById('alertArea');
  if (area) area.innerHTML = '';
}

function sanitize(str) {
  const d = document.createElement('div');
  d.innerText = String(str);
  return d.innerHTML;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
