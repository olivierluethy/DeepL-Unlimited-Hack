// ============================================
// fullpage.js — PDF Upload & Translation Pipeline
// ============================================

// Configure PDF.js worker (must run before any getDocument calls)
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('js/pdf.worker.min.js');
}

// Module-level state
let currentFile = null;
let extractedText = '';
let extractedPageCount = 0;
let lastTranslatedPdfBytes = null;
let stopRequested = false;
const pendingTranslations = new Map();

// Receive completion signals from content.js (runs in DeepL tab)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DEEPL_TRANSLATION_COMPLETE') {
    const resolver = pendingTranslations.get(message.requestId);
    if (resolver) {
      resolver(message);
      pendingTranslations.delete(message.requestId);
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initUploadUI();
  loadPdfHistory();
});

// ─── Upload UI ───────────────────────────────────────────────────────────────

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
    for (const [key, resolver] of pendingTranslations.entries()) {
      resolver({ success: false, cancelled: true });
      pendingTranslations.delete(key);
    }
    document.getElementById('stopBtn').classList.add('d-none');
    document.getElementById('translateBtn').disabled = false;
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

// ─── File selection & extraction ─────────────────────────────────────────────

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

  document.getElementById('progressSection').classList.remove('d-none');
  setStep('extract', 'active');
  updateProgress(10, 'Reading PDF…');

  try {
    const result = await extractTextFromPDF(file);
    extractedText = result.text;
    extractedPageCount = result.pageCount;

    document.getElementById('pageCount').textContent = result.pageCount;
    document.getElementById('charCount').textContent = result.text.length.toLocaleString();
    document.getElementById('pageCountInfo').classList.remove('d-none');
    document.getElementById('charCountInfo').classList.remove('d-none');

    setStep('extract', 'done');
    updateProgress(25, `Ready — ${result.pageCount} pages, ${result.text.length.toLocaleString()} characters`);
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
    const pageText = content.items.map((item) => item.str).join(' ').trim();
    if (pageText) pageTexts.push(pageText);
  }

  return { text: pageTexts.join('\n\n'), pageCount: pdf.numPages };
}

// ─── Translation pipeline ─────────────────────────────────────────────────────

async function startPipeline() {
  if (!currentFile || !extractedText) return;

  stopRequested = false;
  lastTranslatedPdfBytes = null;

  document.getElementById('translateBtn').disabled = true;
  document.getElementById('stopBtn').classList.remove('d-none');
  document.getElementById('downloadBtn').classList.add('d-none');
  clearAlert();

  try {
    // Locate the DeepL translator tab
    const allTabs = await chrome.tabs.query({ url: '*://www.deepl.com/*' });
    const deeplRegex = /^https:\/\/www\.deepl\.com\/[^/]+\/(translate|write|translator)/;
    const deeplTab = allTabs.find((t) => deeplRegex.test(t.url));

    if (!deeplTab) {
      throw new Error(
        'No DeepL translator tab found. Open www.deepl.com/translator and try again.'
      );
    }

    // Step: Translate via DeepL
    setStep('translate', 'active');
    updateProgress(35, 'Sending to DeepL…');

    const translatedText = await translateViaDeepL(extractedText, deeplTab.id);

    if (stopRequested) return;

    setStep('translate', 'done');
    updateProgress(70, 'Generating PDF…');

    // Step: Generate translated PDF
    setStep('generate', 'active');
    const pdfBytes = await createTranslatedPDF(currentFile.name, translatedText);
    setStep('generate', 'done');

    updateProgress(100, 'Done!');
    lastTranslatedPdfBytes = pdfBytes;

    // Persist to PDF history
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
    document.getElementById('stopBtn').classList.add('d-none');
    document.getElementById('translateBtn').disabled = false;
  }
}

async function translateViaDeepL(text, tabId) {
  const requestId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const beforeTime = new Date().toISOString();

  const completionPromise = new Promise((resolve, reject) => {
    pendingTranslations.set(requestId, resolve);
    // 5-minute hard timeout
    setTimeout(() => {
      if (pendingTranslations.has(requestId)) {
        pendingTranslations.delete(requestId);
        reject(new Error('Translation timed out after 5 minutes. The PDF may be too long.'));
      }
    }, 300_000);
  });

  // Inject the postMessage call into the DeepL tab
  await chrome.scripting.executeScript({
    target: { tabId },
    function: (payload, reqId) => {
      window.postMessage({ type: 'DEEPL_TRANSLATE', payload, requestId: reqId }, '*');
    },
    args: [text, requestId],
  });

  const result = await completionPromise;
  if (!result.success) throw new Error('Translation was cancelled.');

  // content.js already saved to verlauf before sending the completion signal.
  // Find the most recent entry added after we sent the request.
  return new Promise((resolve, reject) => {
    chrome.storage.local.get({ verlauf: [] }, ({ verlauf }) => {
      // Walk newest-first to find the entry created after our request
      for (let i = verlauf.length - 1; i >= 0; i--) {
        if (verlauf[i].timestamp >= beforeTime) {
          return resolve(verlauf[i].translated);
        }
      }
      // Fallback: use the last entry
      if (verlauf.length > 0) {
        resolve(verlauf[verlauf.length - 1].translated);
      } else {
        reject(new Error('No translation result found in history.'));
      }
    });
  });
}

// ─── PDF generation (pdf-lib) ─────────────────────────────────────────────────

async function createTranslatedPDF(originalFilename, text) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const W = 595;  // A4 width  (points)
  const H = 842;  // A4 height (points)
  const mx = 50;  // horizontal margin
  const mTop = 65;
  const mBot = 50;
  const cW = W - 2 * mx;  // usable content width
  const sz = 11;
  const lh = sz * 1.55;

  let page = pdfDoc.addPage([W, H]);
  let y = H - mTop;

  // ── Header ──
  const baseName = originalFilename.replace(/\.pdf$/i, '');
  page.drawText('Translation: ' + baseName, {
    x: mx, y, font: boldFont, size: 13,
    color: rgb(0.05, 0.27, 0.98),
  });
  y -= lh;

  page.drawText(new Date().toLocaleString(), {
    x: mx, y, font, size: 9,
    color: rgb(0.5, 0.5, 0.5),
  });
  y -= lh * 0.6;

  page.drawLine({
    start: { x: mx, y },
    end: { x: W - mx, y },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= lh * 1.4;

  // ── Text rendering helpers ──
  function needsNewPage() { return y < mBot + lh; }
  function newPage() {
    page = pdfDoc.addPage([W, H]);
    y = H - mTop;
  }

  function drawLine(str, f, size, color) {
    if (needsNewPage()) newPage();
    page.drawText(str, { x: mx, y, font: f, size, color });
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

      if (w > cW && line) {
        drawLine(line, font, sz, rgb(0, 0, 0));
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) drawLine(line, font, sz, rgb(0, 0, 0));
  }

  // ── Render paragraphs ──
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
    const clearBtn = document.getElementById('clearHistoryBtn');

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
                ${(entry.translatedLength || 0).toLocaleString()} chars translated
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
              loadPdfHistory
            );
          });
        }
      });

      container.appendChild(card);
    });
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function triggerPdfDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function setStep(stepId, state) {
  const el = document.getElementById('step-' + stepId);
  if (!el) return;

  const icon = el.querySelector('i');
  if (!icon) return;

  icon.className = 'bi';
  el.className = 'step-item step-' + state;

  switch (state) {
    case 'done':
      icon.classList.add('bi-check-circle-fill', 'text-success');
      break;
    case 'active':
      icon.classList.add('bi-arrow-clockwise', 'text-primary', 'spin');
      break;
    case 'error':
      icon.classList.add('bi-x-circle-fill', 'text-danger');
      break;
    default:
      icon.classList.add('bi-circle', 'text-muted');
  }
}

function resetSteps() {
  ['extract', 'translate', 'generate'].forEach((s) => setStep(s, 'idle'));
  updateProgress(0, '');
}

function updateProgress(percent, label) {
  const bar = document.getElementById('mainProgressBar');
  const labelEl = document.getElementById('progressLabel');
  const pctEl = document.getElementById('progressPercent');

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
  if (pctEl) pctEl.textContent = percent + '%';
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
