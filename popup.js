document.addEventListener("DOMContentLoaded", () => {
  const sendBtn = document.getElementById("sendBtn");
  const inputText = document.getElementById("inputText");
  const status = document.getElementById("status");
  const historyList = document.getElementById("historyList");
  const pasteBtn = document.getElementById("pasteBtn");
  const clearBtn = document.getElementById("clearBtn");
  const copyInputBtn = document.getElementById("copyInputBtn");
  const magicFixBtn = document.getElementById("magicFixBtn");
  const swapBtn = document.getElementById("swapBtn");

  // ✅ Track pending translations for completion signals
  const pendingTranslations = new Map();

  // Multi-selection state for history
  let selectedIds = new Set();
  let currentVerlauf = [];

  // ─── Documents tab: pending uploads (driven by background.js) ──────────────
  // The popup is transient — translation lives in the service worker. This
  // block just renders the list and ships START_DOC / STOP_DOC / DELETE_DOC
  // intents over chrome.runtime.sendMessage.
  initPendingDocsList();

  // ✅ Listen for completion messages from content script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "DEEPL_TRANSLATION_COMPLETE") {
      console.log("📨 Received completion signal:", message.requestId);

      const resolver = pendingTranslations.get(message.requestId);
      if (resolver) {
        resolver(message);
        pendingTranslations.delete(message.requestId);
      }
    }
  });

  const tooltipTriggerList = document.querySelectorAll(
    '[data-bs-toggle="tooltip"]',
  );
  tooltipTriggerList.forEach((el) => new bootstrap.Tooltip(el));

  // Initialisiere Bootstrap Tabs
  const tabList = document.querySelectorAll('#appTabs a[data-bs-toggle="tab"]');
  tabList.forEach((tab) => {
    tab.addEventListener("shown.bs.tab", (event) => {
      const target = event.target.getAttribute("href");
      if (target === "#history") {
        loadHistory();
      }
    });
  });

  // --- History multi-selection helpers ---

  function updateBulkBar() {
    const bar = document.getElementById("historyBulkBar");
    const countEl = document.getElementById("selectedCount");
    const selectAllBtn = document.getElementById("selectAllHistoryBtn");
    const count = selectedIds.size;
    const total = currentVerlauf.length;

    countEl.textContent = count === 1 ? "1 selected" : `${count} selected`;

    if (count === 0) {
      bar.classList.add("d-none");
    } else {
      bar.classList.remove("d-none");
    }

    if (total > 0) {
      selectAllBtn.classList.remove("d-none");
      selectAllBtn.textContent =
        count === total ? "Deselect all" : "Select all";
    } else {
      selectAllBtn.classList.add("d-none");
    }
  }

  document
    .getElementById("selectAllHistoryBtn")
    .addEventListener("click", () => {
      if (selectedIds.size === currentVerlauf.length) {
        selectedIds.clear();
        document.querySelectorAll(".history-select-cb").forEach((cb) => {
          cb.checked = false;
        });
        document
          .querySelectorAll(".history-entry")
          .forEach((e) => e.classList.remove("selected"));
      } else {
        currentVerlauf.forEach((e) => selectedIds.add(e.id));
        document.querySelectorAll(".history-select-cb").forEach((cb) => {
          cb.checked = true;
        });
        document
          .querySelectorAll(".history-entry")
          .forEach((e) => e.classList.add("selected"));
      }
      updateBulkBar();
    });

  document.getElementById("bulkCopyBtn").addEventListener("click", () => {
    const selected = currentVerlauf.filter((e) => selectedIds.has(e.id));
    const text = selected.map((e) => e.translated).join("\n\n---\n\n");
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById("bulkCopyBtn");
      const oldHTML = btn.innerHTML;
      btn.innerHTML = "✅ Copied";
      btn.classList.replace("btn-outline-success", "btn-success");
      setTimeout(() => {
        btn.innerHTML = oldHTML;
        btn.classList.replace("btn-success", "btn-outline-success");
      }, 2000);
    });
  });

  document.getElementById("bulkExportTxt").addEventListener("click", (e) => {
    e.preventDefault();
    const selected = currentVerlauf.filter((e) => selectedIds.has(e.id));
    if (!selected.length) return;
    const content = selected
      .map(
        (e, i) =>
          `[${i + 1}] ${new Date(e.timestamp).toLocaleString()}\n\nOriginal:\n${e.original}\n\nConverted:\n${e.translated}`,
      )
      .join("\n\n" + "=".repeat(40) + "\n\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: `translations_${Date.now()}.txt`,
      saveAs: true,
    });
  });

  document.getElementById("bulkExportWord").addEventListener("click", (e) => {
    e.preventDefault();
    const selected = currentVerlauf.filter((e) => selectedIds.has(e.id));
    if (!selected.length) return;
    // Build a real OOXML .docx with one numbered heading per entry.
    // Only translated text is exported (original is already stored locally).
    const blob = buildMultiDocxBlob(selected);
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: `translations_${Date.now()}.docx`,
      saveAs: true,
    });
  });

  document.getElementById("bulkDeleteBtn").addEventListener("click", () => {
    const count = selectedIds.size;
    if (!count) return;
    if (
      confirm(`Delete ${count} selected ${count === 1 ? "entry" : "entries"}?`)
    ) {
      chrome.storage.local.get({ verlauf: [] }, (result) => {
        const filtered = result.verlauf.filter((e) => !selectedIds.has(e.id));
        chrome.storage.local.set({ verlauf: filtered }, () => loadHistory());
      });
    }
  });

  // --- Lade gespeicherten Input beim Start ---
  chrome.storage.local.get({ lastInput: "" }, (result) => {
    inputText.value = result.lastInput;
  });

  // --- Speichere Input bei jeder Änderung ---
  inputText.addEventListener("input", () => {
    chrome.storage.local.set({ lastInput: inputText.value });
  });

  // -----------------------------
  // Progress Bar for Main Tab
  // -----------------------------
  function createMainProgressBar() {
    // Remove existing progress bar if any
    const existing = document.getElementById("mainProgressWrapper");
    if (existing) existing.remove();

    const progressWrapper = document.createElement("div");
    progressWrapper.id = "mainProgressWrapper";
    progressWrapper.className = "mt-3 mb-2";
    progressWrapper.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-1">
        <small class="text-muted progress-label">
          <span class="spinner-border spinner-border-sm me-2" role="status"></span>
          Processing...
        </small>
        <small class="text-muted progress-percent">0%</small>
      </div>
      <div class="progress" style="height: 8px;">
        <div class="progress-bar progress-bar-striped progress-bar-animated bg-primary" 
             role="progressbar" 
             style="width: 0%;" 
             aria-valuenow="0" 
             aria-valuemin="0" 
             aria-valuemax="100">
        </div>
      </div>
      <small class="text-muted d-block mt-1 progress-details"></small>
    `;

    // Insert after the status element
    status.after(progressWrapper);

    return progressWrapper;
  }

  function updateMainProgressBar(percent, label, details = "") {
    const progressWrapper = document.getElementById("mainProgressWrapper");
    if (!progressWrapper) return;

    const progressBar = progressWrapper.querySelector(".progress-bar");
    const progressPercent = progressWrapper.querySelector(".progress-percent");
    const progressLabel = progressWrapper.querySelector(".progress-label");
    const progressDetails = progressWrapper.querySelector(".progress-details");

    progressBar.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", percent);
    progressPercent.textContent = `${percent}%`;

    if (percent === 100) {
      progressBar.classList.remove("bg-primary", "progress-bar-animated");
      progressBar.classList.add("bg-success");
      progressLabel.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="bi bi-check-circle-fill me-1 text-success" viewBox="0 0 16 16">
          <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0m-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/>
        </svg>
        ${label}
      `;
    } else {
      progressLabel.innerHTML = `
        <span class="spinner-border spinner-border-sm me-2" role="status"></span>
        ${label}
      `;
    }

    progressDetails.textContent = details;
  }

  function removeMainProgressBar(delay = 3000) {
    setTimeout(() => {
      const progressWrapper = document.getElementById("mainProgressWrapper");
      if (progressWrapper) {
        progressWrapper.style.transition = "opacity 0.3s ease";
        progressWrapper.style.opacity = "0";
        setTimeout(() => progressWrapper.remove(), 300);
      }
    }, delay);
  }

  // ✅ Send text and wait for completion signal
  async function sendTextToDeepLAndWait(text, timeoutMs = 120000) {
    if (!text.trim()) return { success: true };

    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    // Create a promise that will be resolved when we get the completion signal
    const completionPromise = new Promise((resolve, reject) => {
      pendingTranslations.set(requestId, resolve);

      // Timeout fallback
      setTimeout(() => {
        if (pendingTranslations.has(requestId)) {
          pendingTranslations.delete(requestId);
          reject(new Error(`Translation timeout for request ${requestId}`));
        }
      }, timeoutMs);
    });

    // Send the translation request with the unique ID
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: (payload, reqId) => {
        window.postMessage(
          {
            type: "DEEPL_TRANSLATE",
            payload: payload,
            requestId: reqId,
          },
          "*",
        );
      },
      args: [text, requestId],
    });

    console.log(
      `📤 Sent translation request: ${requestId} (${text.length} chars)`,
    );

    // Wait for the completion signal
    return await completionPromise;
  }

  // --- Send to DeepL Button (UPDATED with Progress Bar) ---
  sendBtn.addEventListener("click", async () => {
    const text = inputText.value.trim();
    if (!text) return alert("Please enter text.");

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    const deeplRegex =
      /^https:\/\/www\.deepl\.com\/[^\/]+\/(translate|write|translator)/;

    if (!tab.url || !deeplRegex.test(tab.url)) {
      return alert(
        "You are not in DeepL. Please switch to DeepL for the extension to work.",
      );
    }

    // Disable button during processing
    sendBtn.disabled = true;
    sendBtn.innerHTML = `
      <span class="spinner-border spinner-border-sm me-1" role="status"></span>
      Processing...
    `;

    // Create progress bar
    createMainProgressBar();

    // Calculate text stats for display
    const charCount = text.length;
    const wordCount = text.split(/\s+/).filter((w) => w).length;

    // Estimate processing time based on text length
    const estimatedSeconds = Math.max(5, Math.ceil(charCount / 200));

    updateMainProgressBar(
      10,
      "Sending to DeepL...",
      `${charCount.toLocaleString()} characters, ~${wordCount.toLocaleString()} words`,
    );

    // Simulate progress while waiting
    let currentProgress = 10;
    const progressInterval = setInterval(() => {
      if (currentProgress < 85) {
        // Slow down as we get closer to completion
        const increment = Math.max(1, Math.floor((85 - currentProgress) / 10));
        currentProgress += increment;
        updateMainProgressBar(
          currentProgress,
          "Translating...",
          `Estimated ~${Math.max(1, estimatedSeconds - Math.floor(currentProgress / 10))}s remaining`,
        );
      }
    }, 1000);

    try {
      // Wait for actual completion signal
      const result = await sendTextToDeepLAndWait(text, 120000);

      clearInterval(progressInterval);

      if (result.success) {
        updateMainProgressBar(
          100,
          "Translation complete!",
          `Original: ${result.originalLength?.toLocaleString() || charCount.toLocaleString()} chars → Translated: ${result.translatedLength?.toLocaleString() || "?"} chars`,
        );

        status.innerHTML = `
          <span class="text-success">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="bi bi-check-circle-fill me-1" viewBox="0 0 16 16">
              <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0m-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/>
            </svg>
            Translation saved to history!
          </span>
        `;

        // Clear input after successful translation
        inputText.value = "";
        chrome.storage.local.set({ lastInput: "" });

        removeMainProgressBar(3000);
      } else {
        throw new Error(result.error || "Translation failed");
      }
    } catch (error) {
      clearInterval(progressInterval);
      console.error("Translation error:", error);

      // Update progress bar to show error
      const progressWrapper = document.getElementById("mainProgressWrapper");
      if (progressWrapper) {
        const progressBar = progressWrapper.querySelector(".progress-bar");
        const progressLabel = progressWrapper.querySelector(".progress-label");

        progressBar.classList.remove("bg-primary", "progress-bar-animated");
        progressBar.classList.add("bg-danger");
        progressLabel.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="bi bi-exclamation-triangle-fill me-1 text-danger" viewBox="0 0 16 16">
            <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2"/>
          </svg>
          Error or timeout
        `;
      }

      status.innerHTML = `
        <span class="text-warning">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="bi bi-exclamation-triangle me-1" viewBox="0 0 16 16">
            <path d="M7.938 2.016A.13.13 0 0 1 8.002 2a.13.13 0 0 1 .063.016.15.15 0 0 1 .054.057l6.857 11.667c.036.06.035.124.002.183a.2.2 0 0 1-.054.06.1.1 0 0 1-.066.017H1.146a.1.1 0 0 1-.066-.017.2.2 0 0 1-.054-.06.18.18 0 0 1 .002-.183L7.884 2.073a.15.15 0 0 1 .054-.057m1.044-.45a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767z"/>
            <path d="M7.002 12a1 1 0 1 1 2 0 1 1 0 0 1-2 0M7.1 5.995a.905.905 0 1 1 1.8 0l-.35 3.507a.552.552 0 0 1-1.1 0z"/>
          </svg>
          Text sent. Check DeepL for results (timeout waiting for confirmation).
        </span>
      `;

      removeMainProgressBar(5000);
    }

    // Re-enable button
    sendBtn.disabled = false;
    sendBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-send-fill me-1" viewBox="0 0 16 16">
        <path d="M15.964.686a.5.5 0 0 0-.65-.65L.767 5.855H.766l-.452.18a.5.5 0 0 0-.082.887l.41.26.001.002 4.995 3.178 3.178 4.995.002.001.26.41a.5.5 0 0 0 .886-.083zm-1.833 1.89L6.637 10.07l-.215-.338a.5.5 0 0 0-.154-.154l-.338-.215 7.494-7.494 1.178-.471z"/>
      </svg>
      Send to DeepL
    `;

    // Clear status after delay
    setTimeout(() => {
      if (!document.getElementById("mainProgressWrapper")) {
        status.innerText = "";
      }
    }, 5000);
  });

  // Swap Button
  swapBtn.addEventListener("click", () => {
    swapBtn.style.transform = "rotate(180deg)";
    swapBtn.style.transition = "transform 0.3s ease";

    setTimeout(() => {
      swapBtn.style.transform = "rotate(0deg)";
    }, 300);

    chrome.storage.local.get({ verlauf: [] }, (result) => {
      const verlauf = result.verlauf;

      if (verlauf.length > 0) {
        const lastEntry = verlauf[verlauf.length - 1];
        const textToRestore = lastEntry.translated;

        // Wert ins Feld schreiben
        inputText.value = textToRestore;
        inputText.focus();

        // JETZT AUCH SPEICHERN (wie beim Paste Button)
        chrome.storage.local.set({ lastInput: textToRestore });

        status.innerText = "Last result restored for re-editing.";
        setTimeout(() => {
          status.innerText = "";
        }, 2000);
      } else {
        alert("No history available to swap back.");
      }
    });
  });

  // Magic Fix: Repariert PDF-Zeilenumbrüche und doppelte Leerzeichen
  magicFixBtn.addEventListener("click", () => {
    let text = inputText.value;
    if (!text) return;

    const fixedText = text
      .replace(/([^.\n])\n([^.\n])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim();

    // Wert im UI setzen
    inputText.value = fixedText;

    // JETZT AUCH SPEICHERN (wie beim Paste & Swap Button)
    chrome.storage.local.set({ lastInput: fixedText });

    const btn = document.getElementById("magicFixBtn");
    btn.classList.replace("btn-outline-info", "btn-info");
    setTimeout(
      () => btn.classList.replace("btn-info", "btn-outline-info"),
      500,
    );
  });

  copyInputBtn.addEventListener("click", () => {
    const text = inputText.value;
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        const originalHTML = copyInputBtn.innerHTML;
        copyInputBtn.innerHTML =
          '<svg xmlns="http://www.w3.org" width="14" height="14" fill="currentColor" class="bi bi-check-lg" viewBox="0 0 16 16"><path d="M12.736 3.97a.733.733 0 0 1 1.047 0c.286.289.29.756.01 1.05L7.88 12.01a.733.733 0 0 1-1.065.02L3.217 8.384a.757.757 0 0 1 0-1.06.733.733 0 0 1 1.047 0l3.052 3.093 5.4-6.425a.247.247 0 0 1 .02-.022Z"/></svg>';
        copyInputBtn.classList.replace("btn-outline-secondary", "btn-success");

        setTimeout(() => {
          copyInputBtn.innerHTML = originalHTML;
          copyInputBtn.classList.replace(
            "btn-success",
            "btn-outline-secondary",
          );
        }, 1500);
      });
    }
  });

  // --- Paste Button ---
  pasteBtn.addEventListener("click", () => {
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          inputText.value = text;
          inputText.focus();
          chrome.storage.local.set({ lastInput: text });
        }
      })
      .catch(() => {
        const tempTextArea = document.createElement("textarea");
        document.body.appendChild(tempTextArea);
        tempTextArea.focus();
        document.execCommand("paste");
        const text = tempTextArea.value;
        if (text) {
          inputText.value = text;
          inputText.focus();
          chrome.storage.local.set({ lastInput: text });
        }
        document.body.removeChild(tempTextArea);
      });
  });

  // --- Clear Button ---
  clearBtn.addEventListener("click", () => {
    inputText.value = "";
    inputText.focus();
    chrome.storage.local.set({ lastInput: "" });
  });

  function sendTextToContent(text) {
    window.postMessage({ type: "DEEPL_TRANSLATE", payload: text }, "*");
  }

  function loadHistory() {
    // Reset selection state on each load
    selectedIds = new Set();
    currentVerlauf = [];

    chrome.storage.local.get({ verlauf: [] }, (result) => {
      const verlauf = result.verlauf;
      currentVerlauf = verlauf;

      historyList.style.maxHeight = "500px";
      historyList.style.overflowY = "auto";
      historyList.style.overflowX = "hidden";
      historyList.className = "custom-scrollbar";

      historyList.innerHTML = "";
      updateBulkBar();

      if (!verlauf.length) {
        historyList.innerHTML =
          "<p class='text-muted p-3'>No entries available yet.</p>";
        return;
      }

      verlauf
        .slice()
        .reverse()
        .forEach((entry) => {
          const item = document.createElement("div");
          item.className = "history-entry border-bottom pb-3 mb-3 p-2";

          item.innerHTML = `
    <div class="d-flex align-items-start gap-2">
    <input type="checkbox" class="history-select-cb form-check-input" style="width:1.1em;height:1.1em;cursor:pointer;flex-shrink:0;margin-top:5px;" aria-label="Select entry">
    <div style="flex:1;min-width:0;">
    <small class="text-muted d-block mb-2">
      <svg xmlns="http://www.w3.org" width="12" height="12" fill="currentColor" class="bi bi-clock me-1" viewBox="0 0 16 16">
        <path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71z"/>
        <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16m7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0"/>
      </svg>
      ${new Date(entry.timestamp).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
    </small>

    <div class="d-flex gap-3 mb-1 w-100" style="align-items: flex-start;">
      <!-- Linke Spalte: Original -->
      <div style="flex: 1; min-width: 0;">
        <strong class="d-block small text-secondary mb-1">Original:</strong>
        <pre class="mb-0 text-wrap custom-scrollbar" style="white-space: pre-wrap; background: #f8f9fa; padding: 8px; border-radius: 6px; font-size: 0.8rem; max-height: 120px; overflow-y: auto; border: 1px solid #eee;">${sanitize(entry.original)}</pre>
        <button class="btn btn-sm btn-link text-decoration-none p-0 mt-1 reuse-original d-flex align-items-center text-secondary" style="font-size: 0.7rem; opacity: 0.8;">
          <svg xmlns="http://www.w3.org" width="11" height="11" fill="currentColor" class="bi bi-arrow-counterclockwise me-1" viewBox="0 0 16 16">
            <path fill-rule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2z"/><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966a.25.25 0 0 0 .41-.192z"/>
          </svg> Reuse Original
        </button>

        <div class="d-flex flex-nowrap gap-1 mt-2"> 
          <button class="btn btn-outline-success btn-sm flex-fill d-flex align-items-center justify-content-center copy-btn-original" style="font-size: 0.7rem; padding: 4px 2px;">
            <svg xmlns="http://www.w3.org" width="12" height="12" fill="currentColor" class="bi bi-clipboard me-1" viewBox="0 0 16 16"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0z"/></svg>
            <span>Copy</span>
          </button>
        </div>
      </div>
      
      <!-- Rechte Spalte: Converted -->
      <div style="flex: 1; min-width: 0; display: flex; flex-direction: column;">
        <strong class="d-block small text-primary mb-1">Converted:</strong>
        <pre class="mb-0 text-wrap custom-scrollbar" style="white-space: pre-wrap; background: #f8f9fa; padding: 8px; border-radius: 6px; font-size: 0.8rem; max-height: 120px; overflow-y: auto; border: 1px solid #e7f1ff;">${sanitize(entry.translated)}</pre>
        <button class="btn btn-sm btn-link text-decoration-none p-0 mt-1 reuse-converted d-flex align-items-center text-primary" style="font-size: 0.7rem; opacity: 0.8;">
          <svg xmlns="http://www.w3.org" width="11" height="11" fill="currentColor" class="bi bi-arrow-counterclockwise me-1" viewBox="0 0 16 16">
             <path fill-rule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2z"/><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966a.25.25 0 0 0 .41-.192z"/>
          </svg> Reuse Converted
        </button>

        <div class="d-flex flex-nowrap gap-1 mt-2">
          <button class="btn btn-outline-primary btn-sm flex-fill d-flex align-items-center justify-content-center details-entry" style="font-size: 0.7rem; padding: 4px 2px;">
            <svg xmlns="http://www.w3.org" width="12" height="12" fill="currentColor" class="bi bi-info-circle me-1" viewBox="0 0 16 16"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/><path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/></svg>
            <span>Details</span>
          </button>
          
          <button class="btn btn-outline-success btn-sm flex-fill d-flex align-items-center justify-content-center copy-btn-converted" style="font-size: 0.7rem; padding: 4px 2px;">
            <svg xmlns="http://www.w3.org" width="12" height="12" fill="currentColor" class="bi bi-clipboard me-1" viewBox="0 0 16 16"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0z"/></svg>
            <span>Copy</span>
          </button>

          <div class="dropdown flex-fill d-flex">
            <button class="btn btn-outline-secondary btn-sm flex-fill d-flex align-items-center justify-content-center dropdown-toggle" type="button" data-bs-toggle="dropdown" style="font-size: 0.7rem; padding: 4px 2px;">
              <svg xmlns="http://www.w3.org" width="12" height="12" fill="currentColor" class="bi bi-download me-1" viewBox="0 0 16 16"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708z"/></svg>
              <span>Save</span>
            </button>
            <ul class="dropdown-menu shadow-sm" style="font-size: 0.75rem;">
              <li><a class="dropdown-item" href="#" data-id="${entry.id}" data-format="txt">TXT</a></li>
  <li><a class="dropdown-item" href="#" data-id="${entry.id}" data-format="word">Word (.docx)</a></li>
  <li><a class="dropdown-item" href="#" data-id="${entry.id}" data-format="pdf">PDF</a></li>
  <li><a class="dropdown-item" href="#" data-id="${entry.id}" data-format="md">Markdown (.md)</a></li>
  <li><hr class="dropdown-divider"></li>
  <li><a class="dropdown-item" href="#" data-id="${entry.id}" data-format="json">JSON</a></li>
  <li><a class="dropdown-item" href="#" data-id="${entry.id}" data-format="csv">CSV</a></li>
            </ul>
          </div>

          <button class="btn btn-outline-danger btn-sm flex-fill d-flex align-items-center justify-content-center delete-btn" style="font-size: 0.7rem; padding: 4px 2px;">
            <svg xmlns="http://www.w3.org" width="12" height="12" fill="currentColor" class="bi bi-trash me-1" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/></svg>
            <span>Del</span>
          </button>
        </div>
      </div>
    </div>
    </div>
    </div>
`;

          // Reuse-Logik mit Animation
          const handleReuse = (btn, text) => {
            const icon = btn.querySelector("svg");
            if (icon) {
              icon.style.transition = "transform 0.4s ease";
              icon.style.transform = "rotate(-360deg)";

              setTimeout(() => {
                icon.style.transition = "none";
                icon.style.transform = "rotate(0deg)";
              }, 400);
            }

            if (typeof inputText !== "undefined") {
              inputText.value = text;
              chrome.storage.local.set({ lastInput: inputText.value });

              if (typeof status !== "undefined") {
                status.innerText = "Text restored to input field.";
                setTimeout(() => {
                  status.innerText = "";
                }, 2000);
              }
            }
          };

          item
            .querySelector(".reuse-original")
            .addEventListener("click", function () {
              handleReuse(this, entry.original);
            });

          item
            .querySelector(".reuse-converted")
            .addEventListener("click", function () {
              handleReuse(this, entry.translated);
            });

          item.querySelector(".details-entry").addEventListener("click", () => {
            const url =
              chrome.runtime.getURL("history-detail.html") + `?id=${entry.id}`;
            chrome.tabs.create({ url });
          });

          item
            .querySelector(".copy-btn-original")
            .addEventListener("click", function () {
              navigator.clipboard.writeText(entry.original).then(() => {
                const oldHTML = this.innerHTML;
                this.innerHTML = "✅ Copied";
                setTimeout(() => {
                  this.innerHTML = oldHTML;
                }, 2000);
              });
            });

          item
            .querySelector(".copy-btn-converted")
            .addEventListener("click", function () {
              navigator.clipboard.writeText(entry.translated).then(() => {
                const oldHTML = this.innerHTML;
                this.innerHTML = "✅ Copied";
                setTimeout(() => {
                  this.innerHTML = oldHTML;
                }, 2000);
              });
            });

          item.querySelectorAll(".dropdown-item").forEach((dropdownItem) => {
            dropdownItem.addEventListener("click", (e) => {
              e.preventDefault();
              downloadEntry(entry.id, e.target.getAttribute("data-format"));
            });
          });

          item.querySelector(".delete-btn").addEventListener("click", () => {
            if (confirm("Delete this entry?")) {
              chrome.storage.local.get({ verlauf: [] }, (res) => {
                const filtered = res.verlauf.filter((e) => e.id !== entry.id);
                chrome.storage.local.set({ verlauf: filtered }, () =>
                  loadHistory(),
                );
              });
            }
          });

          // Checkbox selection handler
          item
            .querySelector(".history-select-cb")
            .addEventListener("change", function () {
              if (this.checked) {
                selectedIds.add(entry.id);
                item.classList.add("selected");
              } else {
                selectedIds.delete(entry.id);
                item.classList.remove("selected");
              }
              updateBulkBar();
            });

          historyList.appendChild(item);
        });
    });
  }

  function downloadEntry(entryId, format) {
    chrome.storage.local.get({ verlauf: [] }, (result) => {
      const entry = result.verlauf.find((e) => e.id === entryId);
      if (!entry) return alert("Entry not found.");

      let content, filename, mimeType;
      if (format === "txt") {
        content = `Original: ${entry.original}\n\nConverted: ${entry.translated}`;
        filename = `translation_${entryId}.txt`;
        mimeType = "text/plain";
      } else if (format === "json") {
        content = JSON.stringify(entry, null, 2);
        filename = `translation_${entryId}.json`;
        mimeType = "application/json";
      } else if (format === "csv") {
        content = `"Original","Converted"\n"${entry.original.replace(
          /"/g,
          '""',
        )}","${entry.translated.replace(/"/g, '""')}"`;
        filename = `translation_${entryId}.csv`;
        mimeType = "text/csv";
      } else if (format === "word") {
        // Build a real OOXML .docx (ZIP + XML) — compatible with Microsoft Word.
        // Only the translated text is exported (original is already stored locally).
        const blob = buildDocxBlob(entry.translated);
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({
          url,
          filename: `translation_${entryId}.docx`,
          saveAs: true,
        });
        return;
      } else if (format === "pdf") {
        const { jsPDF } = window.jspdf;

        const datum = new Date(entry.timestamp).toLocaleString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        const doc = new jsPDF();

        let y = 20;

        doc.setFont("helvetica", "bold");
        doc.setFontSize(16);
        doc.text("AI TRANSLATOR PRO", 20, y);

        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(`ID: #${entry.id}`, 150, y);
        doc.text(datum, 150, y + 5);

        y += 15;

        doc.setFontSize(12);
        doc.setFont("helvetica", "bold");
        doc.text("ORIGINAL:", 20, y);

        y += 8;
        doc.setFont("helvetica", "normal");
        const originalLines = doc.splitTextToSize(entry.original, 170);
        doc.text(originalLines, 20, y);

        y += originalLines.length * 7 + 10;

        doc.setFont("helvetica", "bold");
        doc.text("CONVERTED:", 20, y);

        y += 8;
        doc.setFont("helvetica", "normal");
        const translatedLines = doc.splitTextToSize(entry.translated, 170);
        doc.text(translatedLines, 20, y);

        doc.save(`translation_${entry.id}.pdf`);

        return;
      } else if (format === "md") {
        content = `### Original\n\n${entry.original}\n\n---\n\n### Converted\n\n${entry.translated}`;
        filename = `translation_${entryId}.md`;
        mimeType = "text/markdown";
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: true,
      });
    });
  }

  function sanitize(text) {
    const div = document.createElement("div");
    div.innerText = text;
    return div.innerHTML;
  }
});

document.getElementById("openFullPageBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("fullpage.html") });
});

// ─── Documents tab: pending-uploads list ─────────────────────────────────────
// Renders chrome.storage.local.pendingDocuments inside #pendingDocsList. The
// service worker (background.js) owns the actual translation loop and writes
// progress back to storage; we re-render only the rows that change.

function initPendingDocsList() {
  renderPendingDocsList();

  // Storage is the source of truth — re-render only when pendingDocuments
  // actually moves, so unrelated storage writes don't re-render the list.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.pendingDocuments) return;
    const next = changes.pendingDocuments.newValue || [];
    const prev = changes.pendingDocuments.oldValue || [];
    if (pendingDocsListChanged(prev, next)) {
      renderPendingDocsList(next);
    } else {
      // Same set of docs, just per-doc field changes (progress / status):
      // patch the existing rows in place rather than rebuilding the list.
      next.forEach(updatePendingDocRow);
    }
  });

  // Delegated click handler — survives row re-renders.
  const list = document.getElementById("pendingDocsList");
  if (!list) return;
  list.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-doc-action]");
    if (!btn) return;
    const id = btn.dataset.docId;
    const action = btn.dataset.docAction;
    if (action === "start") {
      chrome.runtime.sendMessage({ type: "START_DOC", id });
    } else if (action === "stop") {
      chrome.runtime.sendMessage({ type: "STOP_DOC", id });
    } else if (action === "delete") {
      deletePendingDoc(id);
    }
  });
}

// Compare two pendingDocuments arrays by id-set only, so per-row progress
// updates don't trigger a full re-render.
function pendingDocsListChanged(prev, next) {
  if (prev.length !== next.length) return true;
  const prevIds = prev.map((d) => d.id).sort().join("|");
  const nextIds = next.map((d) => d.id).sort().join("|");
  return prevIds !== nextIds;
}

function renderPendingDocsList(docsArg) {
  const list = document.getElementById("pendingDocsList");
  const empty = document.getElementById("pendingDocsEmpty");
  if (!list) return;

  const apply = (docs) => {
    if (!docs.length) {
      list.innerHTML = "";
      if (empty) empty.classList.remove("d-none");
      return;
    }
    if (empty) empty.classList.add("d-none");

    // Sort newest-first so freshly uploaded files surface at the top.
    const sorted = [...docs].sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    );
    list.innerHTML = sorted.map(pendingDocRowHtml).join("");
  };

  if (docsArg) return apply(docsArg);
  chrome.storage.local.get({ pendingDocuments: [] }, ({ pendingDocuments }) => {
    apply(pendingDocuments);
  });
}

function pendingDocRowHtml(doc) {
  const meta = popupDocMeta(doc.fileType);
  const total = (doc.originalText || "").length;
  const charsTranslated = doc.charsTranslated || 0;
  const progress = clampPct(doc.progress);
  const isProcessing = doc.status === "processing";
  const isError = doc.status === "error";
  const safeName = sanitizePopupText(doc.filename || "(untitled)");
  const safeError = sanitizePopupText(doc.errorMessage || "");

  const actionsHtml = isProcessing
    ? `<button class="btn btn-sm btn-outline-danger" data-doc-action="stop" data-doc-id="${doc.id}" title="Stop">
         <i class="bi bi-stop-fill"></i>
       </button>`
    : `<button class="btn btn-sm btn-success" data-doc-action="start" data-doc-id="${doc.id}" title="Start translation">
         <i class="bi bi-play-fill"></i>
       </button>
       <button class="btn btn-sm btn-outline-secondary" data-doc-action="delete" data-doc-id="${doc.id}" title="Delete">
         <i class="bi bi-trash"></i>
       </button>`;

  const statusLabel = isProcessing
    ? "Translating…"
    : isError
    ? "Error"
    : "Ready";

  return `
    <div class="card mb-2 shadow-sm pending-doc-row" data-doc-id="${doc.id}">
      <div class="card-body py-2 px-3">
        <div class="d-flex align-items-center gap-2">
          <i class="bi ${meta.iconClass} fs-5 flex-shrink-0"></i>
          <div style="min-width:0; flex:1;">
            <div class="fw-semibold text-truncate" title="${safeName}">${safeName}</div>
            <div class="d-flex align-items-center gap-1 flex-wrap">
              <span class="badge ${meta.badgeClass}">${meta.badgeText}</span>
              <small class="text-muted pending-doc-status">${statusLabel}</small>
            </div>
          </div>
          <div class="d-flex gap-1 flex-shrink-0 pending-doc-actions">
            ${actionsHtml}
          </div>
        </div>
        <div class="progress mt-2" style="height:4px;">
          <div class="progress-bar ${isError ? "bg-danger" : "bg-primary"} pending-doc-bar"
               role="progressbar" style="width:${progress}%"></div>
        </div>
        <div class="d-flex justify-content-between mt-1">
          <small class="text-muted pending-doc-chars">
            ${charsTranslated.toLocaleString()} / ${total.toLocaleString()} characters
          </small>
          <small class="text-muted pending-doc-pct">${progress}%</small>
        </div>
        ${
          isError && safeError
            ? `<small class="text-danger d-block mt-1 pending-doc-error">${safeError}</small>`
            : `<small class="text-danger d-block mt-1 pending-doc-error d-none"></small>`
        }
      </div>
    </div>`;
}

// In-place update for a single row — avoids a full list re-render on every
// progress tick from the service worker.
function updatePendingDocRow(doc) {
  const row = document.querySelector(`.pending-doc-row[data-doc-id="${doc.id}"]`);
  if (!row) {
    renderPendingDocsList();
    return;
  }

  const total = (doc.originalText || "").length;
  const charsTranslated = doc.charsTranslated || 0;
  const progress = clampPct(doc.progress);
  const isProcessing = doc.status === "processing";
  const isError = doc.status === "error";

  const bar = row.querySelector(".pending-doc-bar");
  if (bar) {
    bar.style.width = progress + "%";
    bar.classList.toggle("bg-danger", isError);
    bar.classList.toggle("bg-primary", !isError);
  }

  const charsEl = row.querySelector(".pending-doc-chars");
  if (charsEl) {
    charsEl.textContent = `${charsTranslated.toLocaleString()} / ${total.toLocaleString()} characters`;
  }
  const pctEl = row.querySelector(".pending-doc-pct");
  if (pctEl) pctEl.textContent = progress + "%";

  const statusEl = row.querySelector(".pending-doc-status");
  if (statusEl) {
    statusEl.textContent = isProcessing ? "Translating…" : isError ? "Error" : "Ready";
  }

  const errEl = row.querySelector(".pending-doc-error");
  if (errEl) {
    if (isError && doc.errorMessage) {
      errEl.textContent = doc.errorMessage;
      errEl.classList.remove("d-none");
    } else {
      errEl.classList.add("d-none");
      errEl.textContent = "";
    }
  }

  // Swap the action buttons when the running state changes.
  const actions = row.querySelector(".pending-doc-actions");
  if (actions) {
    const showingStop = !!actions.querySelector('[data-doc-action="stop"]');
    if (showingStop !== isProcessing) {
      actions.innerHTML = isProcessing
        ? `<button class="btn btn-sm btn-outline-danger" data-doc-action="stop" data-doc-id="${doc.id}" title="Stop">
             <i class="bi bi-stop-fill"></i>
           </button>`
        : `<button class="btn btn-sm btn-success" data-doc-action="start" data-doc-id="${doc.id}" title="Start translation">
             <i class="bi bi-play-fill"></i>
           </button>
           <button class="btn btn-sm btn-outline-secondary" data-doc-action="delete" data-doc-id="${doc.id}" title="Delete">
             <i class="bi bi-trash"></i>
           </button>`;
    }
  }
}

function popupDocMeta(fileType) {
  if (fileType === "excel") {
    return {
      iconClass: "bi-file-earmark-spreadsheet-fill text-success",
      badgeClass: "bg-success",
      badgeText: "EXCEL",
    };
  }
  if (fileType === "pptx") {
    return {
      iconClass: "bi-file-earmark-slides-fill text-warning",
      badgeClass: "bg-warning text-dark",
      badgeText: "PPTX",
    };
  }
  return {
    iconClass: "bi-file-pdf-fill text-danger",
    badgeClass: "bg-danger",
    badgeText: "PDF",
  };
}

function clampPct(n) {
  const v = Number(n) || 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return Math.round(v);
}

function sanitizePopupText(s) {
  const d = document.createElement("div");
  d.innerText = String(s || "");
  return d.innerHTML;
}

function deletePendingDoc(id) {
  chrome.storage.local.get({ pendingDocuments: [] }, ({ pendingDocuments }) => {
    chrome.storage.local.set({
      pendingDocuments: pendingDocuments.filter((d) => d.id !== id),
    });
  });
}

document.getElementById("bugBtn").addEventListener("click", () => {
  window.open("https://forms.gle/7LNwEpVCbXwunT6s8");
});
document.getElementById("featureBtn").addEventListener("click", () => {
  window.open("https://forms.gle/rFiHJZesQkrP6RiGA", "_blank");
});
