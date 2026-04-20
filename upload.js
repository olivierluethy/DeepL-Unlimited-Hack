// ============================================
// DeepL Pro Unlimited - Upload Handler
// Supports: .docx (mammoth.js) + .pdf (pdf.js)
// ============================================

// Session-local store of File objects (not persisted across popup reopens)
const uploadedFiles = new Map();

// Pending upload translations: requestId -> { resolve, reject }
const pendingUploadTranslations = new Map();

// Listen for DEEPL_TRANSLATION_COMPLETE from content.js for upload-originated requests
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
    type: ext, // "docx" | "pdf"
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

// ─── Render a document entry in the list ─────────────────────────────────────

function renderUploadEntry(doc) {
  const list = document.getElementById("uploadList");
  if (!list) return;

  // Determine file type (default to docx for legacy entries without type)
  const isPDF = doc.type === "pdf";
  const iconClass = isPDF
    ? "bi-file-earmark-pdf text-danger"
    : "bi-file-earmark-word text-primary";
  const badgeClass = isPDF ? "bg-danger" : "bg-primary";
  const badgeText = isPDF ? "PDF" : "DOCX";
  const sizeKb = doc.size ? Math.round(doc.size / 1024) + " KB" : "";

  const item = document.createElement("div");
  item.className = "list-group-item py-2 px-3";
  item.dataset.docId = doc.id;

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
      <div class="d-flex gap-2 align-items-center flex-shrink-0 upload-actions" data-doc-id="${doc.id}">
        <button class="btn btn-sm btn-success startConvert" data-id="${doc.id}">
          <i class="bi bi-play-fill"></i> Start
        </button>
      </div>
    </div>
    <div class="upload-progress mt-2 d-none" data-doc-id="${doc.id}"></div>
  `;

  list.prepend(item);
}

// ─── Delegated click handler for Start / Re-run buttons ──────────────────────

document.getElementById("uploadList").addEventListener("click", function (e) {
  const btn = e.target.closest(".startConvert");
  if (!btn) return;
  startConversion(btn.dataset.id);
});

// ─── Open Upload in a dedicated full-page tab ─────────────────────────────────

document.getElementById("openUploadPageBtn")?.addEventListener("click", function () {
  chrome.tabs.create({ url: chrome.runtime.getURL("upload-page.html") });
});

// ─── Core conversion function ─────────────────────────────────────────────────

async function startConversion(docId) {
  const file = uploadedFiles.get(docId);
  if (!file) {
    alert(
      "The file is no longer available in this session.\n\nPlease select it again using the file picker."
    );
    return;
  }

  // Look for an active DeepL tab (works from both popup and full-page contexts)
  const deeplTab = await findDeepLTab();
  if (!deeplTab) {
    alert(
      "No DeepL tab found.\n\nPlease open https://www.deepl.com/translator in a tab and try again."
    );
    return;
  }

  const actionsDiv = document.querySelector(`.upload-actions[data-doc-id="${docId}"]`);
  const progressDiv = document.querySelector(`.upload-progress[data-doc-id="${docId}"]`);
  const startBtn = actionsDiv?.querySelector(".startConvert");

  // ── UI: show "Extracting…" state
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span> Extracting…`;
  }
  showProgress(progressDiv, "info", "Extracting text from file…");

  try {
    // Step 1: Extract text
    const isPDF = file.name.toLowerCase().endsWith(".pdf");
    let text;
    if (isPDF) {
      text = await extractPDFText(file);
    } else {
      text = await extractDocxText(file);
    }

    if (!text || !text.trim()) {
      throw new Error("No readable text found in the file.");
    }

    // Save extracted text to storage
    saveExtractedText(docId, text);

    // ── UI: show "Translating…" state
    if (startBtn) {
      startBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span> Translating…`;
    }
    showProgress(
      progressDiv,
      "info",
      `Translating ${text.length.toLocaleString()} characters… (this may take a while)`
    );

    // Step 2: Send to DeepL via the existing batch messaging system
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    // Register this request so our onMessage listener can resolve it
    const completionPromise = new Promise((resolve, reject) => {
      pendingUploadTranslations.set(requestId, { resolve, reject });
      // 3-minute timeout for large documents
      setTimeout(() => {
        if (pendingUploadTranslations.has(requestId)) {
          pendingUploadTranslations.delete(requestId);
          reject(new Error("Translation timed out (3 min). Try splitting the document into smaller parts."));
        }
      }, 180_000);
    });

    await chrome.scripting.executeScript({
      target: { tabId: deeplTab.id },
      function: (payload, reqId) => {
        window.postMessage({ type: "DEEPL_TRANSLATE", payload, requestId: reqId }, "*");
      },
      args: [text, requestId],
    });

    // Step 3: Wait for translation completion signal from content.js
    const result = await completionPromise;

    if (!result.success) {
      throw new Error(result.error || "Translation failed.");
    }

    // Step 4: Retrieve the translated text from the history entry just saved
    const translatedText = await getLatestTranslation(startTime);
    if (!translatedText) {
      throw new Error("Translation completed but the result could not be retrieved from history.");
    }

    // Step 5: Store result on the DOM node for download and update UI
    const baseName = file.name.replace(/\.(docx|pdf)$/i, "");

    showProgress(progressDiv, "success", `Translation complete! ${result.translatedLength?.toLocaleString() ?? "?"} characters.`);

    if (actionsDiv) {
      actionsDiv.innerHTML = `
        <button class="btn btn-sm btn-primary download-result">
          <i class="bi bi-download me-1"></i> Download DOCX
        </button>
        <button class="btn btn-sm btn-outline-secondary startConvert" data-id="${docId}">
          <i class="bi bi-arrow-clockwise"></i>
        </button>
      `;
      // Re-register file reference so Re-run button works
      // (file is still in uploadedFiles Map)

      actionsDiv.querySelector(".download-result").addEventListener("click", () => {
        downloadTranslatedDocx(translatedText, baseName);
      });
    }
  } catch (err) {
    console.error("Upload conversion error:", err);
    showProgress(progressDiv, "danger", err.message);

    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = `<i class="bi bi-play-fill"></i> Retry`;
    }
  }
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
  if (!pdfjsLib) {
    throw new Error("PDF library not loaded. Please reload the extension.");
  }

  // Point to the local worker file inside the extension
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("js/pdf.worker.min.js");

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageParts = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    // Join items; insert newline when a significant vertical gap is detected
    let pageText = "";
    let lastY = null;
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

// ─── Find an open DeepL translator tab ───────────────────────────────────────

async function findDeepLTab() {
  const deeplRegex = /^https:\/\/www\.deepl\.com\/[^/]+\/(translate|translator|write)/;
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.url && deeplRegex.test(t.url)) ?? null;
}

// ─── Retrieve the most-recently saved history entry after a given timestamp ──

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

// ─── Persist extracted text to the documents store ───────────────────────────

function saveExtractedText(docId, text) {
  chrome.storage.local.get({ documents: [] }, function (data) {
    const docs = data.documents;
    const doc = docs.find((d) => d.id === docId);
    if (doc) {
      doc.text = text;
      doc.status = "parsed";
    }
    chrome.storage.local.set({ documents: docs });
  });
}

// ─── Generate and trigger download of a Word (.docx) file ────────────────────

function downloadTranslatedDocx(translatedText, baseName) {
  const header =
    "<html xmlns:o='urn:schemas-microsoft-com:office:office' " +
    "xmlns:w='urn:schemas-microsoft-com:office:word' " +
    "xmlns='http://www.w3.org'><head><meta charset='utf-8'></head><body>";
  const footer = "</body></html>";

  const escapedText = translatedText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  const body = `
    <h2 style="font-family: Arial, sans-serif; color: #0d6efd;">Translated Document</h2>
    <p style="color: #6c757d; font-family: Arial; font-size: 11px; margin-top: 0;">
      Source: ${baseName} &nbsp;|&nbsp; ${new Date().toLocaleString()}
    </p>
    <hr>
    <div style="font-family: Arial; font-size: 13px; line-height: 1.7;">${escapedText}</div>
  `;

  const blob = new Blob([header + body + footer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({
    url,
    filename: `${baseName}_translated.docx`,
    saveAs: true,
  });
}

// ─── Progress bar helper ──────────────────────────────────────────────────────

function showProgress(container, type, message) {
  if (!container) return;
  container.classList.remove("d-none");

  const colorMap = {
    info: { bar: "bg-info", icon: "bi-hourglass-split text-info", text: "text-muted" },
    success: { bar: "bg-success", icon: "bi-check-circle-fill text-success", text: "text-success" },
    danger: { bar: "bg-danger", icon: "bi-exclamation-triangle-fill text-danger", text: "text-danger" },
  };
  const c = colorMap[type] || colorMap.info;
  const animated = type === "info" ? "progress-bar-striped progress-bar-animated" : "";

  container.innerHTML = `
    <div class="progress mb-1" style="height: 4px;">
      <div class="progress-bar ${c.bar} ${animated}" style="width: 100%"></div>
    </div>
    <small class="${c.text}">
      <i class="bi ${c.icon} me-1"></i>${message}
    </small>
  `;
}