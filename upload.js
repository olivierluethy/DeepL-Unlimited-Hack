// ============================================
// DeepL Pro Unlimited - Upload Handler
// Supports: .docx (mammoth.js) + .pdf (pdf.js)
// ============================================

// ─── Constants ────────────────────────────────────────────────────────────────

// Keep chunks well under DeepL's 1500-char limit so content.js never needs
// to split them further — giving us exact 1-chunk-per-request progress.
const UPLOAD_CHUNK_MAX_CHARS = 1400;

// ─── Session state ────────────────────────────────────────────────────────────

// In-memory File object store.  Lost when the popup/page is closed —
// that is why stored (old) entries need a Re-select button.
const uploadedFiles = new Map(); // docId  →  File

// One entry per in-flight chunk translation; mirrors loop.js pendingTranslations
const pendingUploadTranslations = new Map(); // requestId  →  { resolve, reject }

// ─── Completion signal listener ───────────────────────────────────────────────
// content.js broadcasts DEEPL_TRANSLATION_COMPLETE for every requestId it finishes.
// Both popup.js and this file register independent listeners; each only handles
// requestIds it owns, so there is no conflict.

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "DEEPL_TRANSLATION_COMPLETE") {
    const pending = pendingUploadTranslations.get(message.requestId);
    if (pending) {
      pending.resolve(message);
      pendingUploadTranslations.delete(message.requestId);
    }
  }
});

// ─── File input change handler ────────────────────────────────────────────────

document.getElementById("fileUpload").addEventListener("change", function (event) {
  const file = event.target.files[0];
  if (!file) return;

  const ext = file.name.split(".").pop().toLowerCase();
  if (ext !== "docx" && ext !== "pdf") {
    alert("Unsupported file type. Please select a .docx or .pdf file.");
    this.value = "";
    return;
  }

  const id = "doc_" + Date.now();
  uploadedFiles.set(id, file);

  const fileEntry = {
    id,
    name: file.name,
    size: file.size,
    type: ext,          // "docx" | "pdf"
    status: "uploaded",
    created: Date.now(),
  };

  chrome.storage.local.get({ documents: [] }, function (data) {
    const docs = data.documents;
    docs.push(fileEntry);
    chrome.storage.local.set({ documents: docs });
    renderUploadEntry(fileEntry);
  });
});

// ─── Render a document entry ──────────────────────────────────────────────────
// Called both for freshly-selected files (file is in uploadedFiles) and for
// entries loaded from chrome.storage on popup open (file is NOT in uploadedFiles).
// The two cases need different action UIs.

function renderUploadEntry(doc) {
  const list = document.getElementById("uploadList");
  if (!list) return;

  const isPDF    = doc.type === "pdf";
  const iconClass  = isPDF ? "bi-file-earmark-pdf text-danger" : "bi-file-earmark-word text-primary";
  const badgeClass = isPDF ? "bg-danger" : "bg-primary";
  const badgeText  = isPDF ? "PDF" : "DOCX";
  const sizeKb     = doc.size ? Math.round(doc.size / 1024) + " KB" : "";

  // Does this session already hold a reference to the file?
  const fileAvailable = uploadedFiles.has(doc.id);

  const item = document.createElement("div");
  item.className = "list-group-item py-2 px-3";
  item.dataset.docId = doc.id;

  // Action area differs depending on whether the File object is available
  const actionsHTML = fileAvailable
    ? `<button class="btn btn-sm btn-success startConvert" data-id="${doc.id}">
         <i class="bi bi-play-fill"></i> Start
       </button>`
    : `<label class="btn btn-sm btn-outline-secondary mb-0"
              title="File not in this session – click to re-select"
              style="cursor:pointer;">
         <i class="bi bi-folder2-open me-1"></i>Re-select
         <input type="file" accept=".docx,.pdf"
                class="d-none reselect-input"
                data-doc-id="${doc.id}">
       </label>`;

  item.innerHTML = `
    <div class="d-flex justify-content-between align-items-start gap-2">
      <div class="d-flex align-items-center gap-2 flex-grow-1 min-w-0">
        <i class="bi ${iconClass} fs-3 flex-shrink-0"></i>
        <div class="min-w-0">
          <div class="fw-semibold text-truncate" title="${doc.name}">${doc.name}</div>
          <div class="d-flex gap-1 align-items-center flex-wrap">
            <span class="badge ${badgeClass}">${badgeText}</span>
            ${sizeKb ? `<small class="text-muted">${sizeKb}</small>` : ""}
          </div>
        </div>
      </div>
      <div class="d-flex gap-2 align-items-center flex-shrink-0 upload-actions"
           data-doc-id="${doc.id}">
        ${actionsHTML}
      </div>
    </div>
    <div class="upload-progress mt-2 d-none" data-doc-id="${doc.id}"></div>
  `;

  // Wire up the re-select input if present
  const reselectInput = item.querySelector(".reselect-input");
  if (reselectInput) {
    reselectInput.addEventListener("change", function (e) {
      const newFile = e.target.files[0];
      if (!newFile) return;

      // Store under the ORIGINAL docId so startConversion finds it
      uploadedFiles.set(doc.id, newFile);

      // Swap the label for a proper Start button
      const actionsDiv = item.querySelector(".upload-actions");
      actionsDiv.innerHTML = `
        <button class="btn btn-sm btn-success startConvert" data-id="${doc.id}">
          <i class="bi bi-play-fill"></i> Start
        </button>`;
    });
  }

  list.prepend(item);
}

// ─── Delegated click handler for Start / Re-run ───────────────────────────────

document.getElementById("uploadList").addEventListener("click", function (e) {
  const btn = e.target.closest(".startConvert");
  if (!btn) return;
  startConversion(btn.dataset.id);
});

// ─── Open Upload in a full-page tab ──────────────────────────────────────────

document.getElementById("openUploadPageBtn")?.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("upload-page.html") });
});

// ─── Core conversion function ─────────────────────────────────────────────────

async function startConversion(docId) {
  const file = uploadedFiles.get(docId);
  if (!file) {
    // Should not happen because renderUploadEntry guards against it,
    // but handle it gracefully instead of alerting.
    const actionsDiv = document.querySelector(`.upload-actions[data-doc-id="${docId}"]`);
    if (actionsDiv) {
      actionsDiv.innerHTML = `
        <label class="btn btn-sm btn-outline-warning mb-0" style="cursor:pointer;"
               title="Session expired – re-select the file">
          <i class="bi bi-folder2-open me-1"></i>Re-select
          <input type="file" accept=".docx,.pdf" class="d-none reselect-input"
                 data-doc-id="${docId}">
        </label>`;
      actionsDiv.querySelector(".reselect-input").addEventListener("change", (e) => {
        if (e.target.files[0]) {
          uploadedFiles.set(docId, e.target.files[0]);
          actionsDiv.innerHTML = `
            <button class="btn btn-sm btn-success startConvert" data-id="${docId}">
              <i class="bi bi-play-fill"></i> Start
            </button>`;
        }
      });
    }
    return;
  }

  // Verify a DeepL tab is open (works from both popup and full-page contexts)
  const deeplTab = await findDeepLTab();
  if (!deeplTab) {
    alert("No DeepL tab found.\n\nPlease open https://www.deepl.com/translator in another tab and try again.");
    return;
  }

  const actionsDiv  = document.querySelector(`.upload-actions[data-doc-id="${docId}"]`);
  const progressDiv = document.querySelector(`.upload-progress[data-doc-id="${docId}"]`);
  const startBtn    = actionsDiv?.querySelector(".startConvert");

  if (startBtn) {
    startBtn.disabled = true;
    startBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Extracting…`;
  }
  renderProgressBar(progressDiv, 0, 1, "Extracting text from file…");

  try {
    // ── Step 1: Extract text ────────────────────────────────────────────────
    const isPDF = file.name.toLowerCase().endsWith(".pdf");
    const text  = isPDF ? await extractPDFText(file) : await extractDocxText(file);

    if (!text || !text.trim()) throw new Error("No readable text found in the file.");

    saveExtractedText(docId, text);

    // ── Step 2: Split into chunks (same algorithm as content.js splitText) ──
    const chunks = splitTextForUpload(text);

    if (startBtn) {
      startBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Translating…`;
    }

    // ── Step 3: Translate chunk-by-chunk (mirrors loop.js startGroupTranslation)
    const translatedChunks = [];
    let failCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      renderProgressBar(
        progressDiv,
        i,
        chunks.length,
        `Translating chunk ${i + 1} of ${chunks.length}…`
      );

      const chunkStartTime = Date.now();

      try {
        const result = await sendChunkAndWait(chunks[i], deeplTab.id, 90_000);

        if (result.success) {
          const translated = await getLatestTranslation(chunkStartTime);
          translatedChunks.push(translated || "");
        } else {
          failCount++;
          translatedChunks.push("");
          console.warn(`Chunk ${i + 1} reported failure:`, result.error);
        }
      } catch (chunkErr) {
        failCount++;
        translatedChunks.push("");
        console.error(`Chunk ${i + 1} error:`, chunkErr);
      }

      // 1 s gap between chunks — identical to loop.js
      if (i < chunks.length - 1) await wait(1000);
    }

    // ── Step 4: Assemble final text and update UI ───────────────────────────
    const finalText = translatedChunks.filter(Boolean).join("\n\n");
    const baseName  = file.name.replace(/\.(docx|pdf)$/i, "");

    if (failCount > 0) {
      renderProgressBar(
        progressDiv,
        chunks.length,
        chunks.length,
        `Done with ${failCount} chunk(s) failed — partial result available.`,
        "warning"
      );
    } else {
      renderProgressBar(
        progressDiv,
        chunks.length,
        chunks.length,
        `Translation complete! ${finalText.length.toLocaleString()} characters.`,
        "success"
      );
    }

    if (actionsDiv) {
      actionsDiv.innerHTML = `
        <button class="btn btn-sm btn-primary download-result">
          <i class="bi bi-download me-1"></i> Download DOCX
        </button>
        <button class="btn btn-sm btn-outline-secondary startConvert" data-id="${docId}"
                title="Translate again">
          <i class="bi bi-arrow-clockwise"></i>
        </button>`;

      actionsDiv.querySelector(".download-result").addEventListener("click", () => {
        downloadTranslatedDocx(finalText, baseName);
      });
    }

  } catch (err) {
    console.error("Upload conversion error:", err);
    renderProgressBar(progressDiv, 0, 1, err.message, "danger");

    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = `<i class="bi bi-play-fill"></i> Retry`;
    }
  }
}

// ─── Text splitter ────────────────────────────────────────────────────────────
// Mirrors splitText() in content.js.  Running it here (instead of letting
// content.js split) gives us the exact chunk count for the progress bar.

function splitTextForUpload(text, maxChars = UPLOAD_CHUNK_MAX_CHARS) {
  const parts = [];
  let current = "";

  for (const word of text.split(" ")) {
    if ((current + " " + word).length > maxChars) {
      if (current) parts.push(current.trim());
      current = word;
    } else {
      current += (current ? " " : "") + word;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

// ─── Single-chunk send + wait (mirrors loop.js sendWithRetryAndWait) ─────────

async function sendChunkAndWait(chunkText, deeplTabId, timeoutMs) {
  const requestId = crypto.randomUUID();

  const completionPromise = new Promise((resolve, reject) => {
    pendingUploadTranslations.set(requestId, { resolve, reject });

    setTimeout(() => {
      if (pendingUploadTranslations.has(requestId)) {
        pendingUploadTranslations.delete(requestId);
        reject(new Error(`Chunk timed out after ${timeoutMs / 1000}s`));
      }
    }, timeoutMs);
  });

  await chrome.scripting.executeScript({
    target: { tabId: deeplTabId },
    function: (payload, reqId) => {
      window.postMessage({ type: "DEEPL_TRANSLATE", payload, requestId: reqId }, "*");
    },
    args: [chunkText, requestId],
  });

  return completionPromise;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Text extraction: DOCX via mammoth.js ─────────────────────────────────────

function extractDocxText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const result = await mammoth.extractRawText({ arrayBuffer: e.target.result });
        resolve(result.value);
      } catch (err) {
        reject(new Error("Failed to parse Word document: " + err.message));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsArrayBuffer(file);
  });
}

// ─── Text extraction: PDF via pdf.js ─────────────────────────────────────────

async function extractPDFText(file) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) throw new Error("PDF library not loaded. Please reload the extension.");

  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("js/pdf.worker.min.js");

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageParts = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page    = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Preserve paragraph breaks by detecting vertical gaps between text items
    let pageText = "";
    let lastY    = null;
    for (const item of content.items) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
        pageText += "\n";
      }
      pageText += item.str;
      lastY = item.transform[5];
    }
    pageParts.push(pageText.trim());
  }

  return pageParts.filter(Boolean).join("\n\n");
}

// ─── Find an open DeepL tab ───────────────────────────────────────────────────
// Searches ALL tabs — works from the popup AND from the full-page upload view.

async function findDeepLTab() {
  const deeplRegex = /^https:\/\/www\.deepl\.com\/[^/]+\/(translate|translator|write)/;
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.url && deeplRegex.test(t.url)) ?? null;
}

// ─── Retrieve the translated text for a just-completed chunk ─────────────────
// content.js saves each translation to verlauf BEFORE sending the completion
// signal, so by the time this runs the entry is guaranteed to be there.

function getLatestTranslation(afterTimestamp) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ verlauf: [] }, (result) => {
      const entry = result.verlauf
        .filter((e) => new Date(e.timestamp).getTime() >= afterTimestamp)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
      resolve(entry ? entry.translated : null);
    });
  });
}

// ─── Persist extracted text ───────────────────────────────────────────────────

function saveExtractedText(docId, text) {
  chrome.storage.local.get({ documents: [] }, (data) => {
    const docs = data.documents;
    const doc  = docs.find((d) => d.id === docId);
    if (doc) { doc.text = text; doc.status = "parsed"; }
    chrome.storage.local.set({ documents: docs });
  });
}

// ─── Download result as Word document ────────────────────────────────────────

function downloadTranslatedDocx(translatedText, baseName) {
  const header =
    "<html xmlns:o='urn:schemas-microsoft-com:office:office' " +
    "xmlns:w='urn:schemas-microsoft-com:office:word' " +
    "xmlns='http://www.w3.org'><head><meta charset='utf-8'></head><body>";
  const footer = "</body></html>";

  const safe = translatedText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  const body = `
    <h2 style="font-family:Arial,sans-serif;color:#0d6efd;">Translated Document</h2>
    <p style="color:#6c757d;font-family:Arial;font-size:11px;margin-top:0;">
      Source: ${baseName} &nbsp;|&nbsp; ${new Date().toLocaleString()}
    </p>
    <hr>
    <div style="font-family:Arial;font-size:13px;line-height:1.7;">${safe}</div>`;

  const blob = new Blob([header + body + footer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  chrome.downloads.download({
    url: URL.createObjectURL(blob),
    filename: `${baseName}_translated.docx`,
    saveAs: true,
  });
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
// type: "active" (default, striped+animated) | "success" | "warning" | "danger"

function renderProgressBar(container, current, total, label, type = "active") {
  if (!container) return;
  container.classList.remove("d-none");

  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  const cfg = {
    active:  { bar: "bg-primary progress-bar-striped progress-bar-animated", icon: "bi-hourglass-split text-info",    text: "text-muted"    },
    success: { bar: "bg-success",                                             icon: "bi-check-circle-fill text-success", text: "text-success"  },
    warning: { bar: "bg-warning",                                             icon: "bi-exclamation-circle text-warning",text: "text-warning"  },
    danger:  { bar: "bg-danger",                                              icon: "bi-x-circle-fill text-danger",      text: "text-danger"   },
  }[type] ?? cfg.active;

  container.innerHTML = `
    <div class="d-flex justify-content-between align-items-center mb-1">
      <small class="${cfg.text}">
        <i class="bi ${cfg.icon} me-1"></i>${label}
      </small>
      <small class="text-muted">${percent}%</small>
    </div>
    <div class="progress" style="height:5px;">
      <div class="progress-bar ${cfg.bar}"
           role="progressbar"
           style="width:${percent}%"
           aria-valuenow="${percent}"
           aria-valuemin="0"
           aria-valuemax="100">
      </div>
    </div>`;
}
