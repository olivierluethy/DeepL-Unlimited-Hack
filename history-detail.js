// ============================================
// DeepL Pro Unlimited - History Detail View
// Enhanced UI with Bootstrap styling
// ============================================

const formatDate = (ts) => new Date(ts).toLocaleString('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
});

const countWords = (text) => text.trim().split(/\s+/).filter(w => w).length;

document.addEventListener("DOMContentLoaded", () => {
  // Track how long users actually spend on the details page —
  // distinguishes "opened and closed instantly" (probably misclicked)
  // from "actually read the diff". Pair: history_details_opened on
  // mount, history_details_closed on pagehide with duration_ms.
  const detailsOpenedAt = Date.now();
  if (window.trackEvent) {
    window.trackEvent("history_details_opened", {});
  }
  window.addEventListener("pagehide", () => {
    if (window.trackEvent) {
      window.trackEvent("history_details_closed", {
        duration_ms: Date.now() - detailsOpenedAt,
      });
    }
  });

  // Elements
  const timestamp = document.getElementById("timestamp");
  const backBtn = document.getElementById("backBtn");
  const diffOutput = document.getElementById("diffOutput");
  
  // Stats elements
  const originalChars = document.getElementById("originalChars");
  const convertedChars = document.getElementById("convertedChars");
  const changeCount = document.getElementById("changeCount");
  const addedCount = document.getElementById("addedCount");
  const removedCount = document.getElementById("removedCount");
  const unchangedCount = document.getElementById("unchangedCount");
  
  // Text elements (multiple instances for different views)
  const originalText = document.getElementById("originalText");
  const translatedText = document.getElementById("translatedText");
  const originalTextFull = document.getElementById("originalTextFull");
  const translatedTextFull = document.getElementById("translatedTextFull");
  
  // Word/char counts
  const originalWordCount = document.getElementById("originalWordCount");
  const originalCharCount = document.getElementById("originalCharCount");
  const convertedWordCount = document.getElementById("convertedWordCount");
  const convertedCharCount = document.getElementById("convertedCharCount");

  // Action buttons
  const reuseOriginalBtn = document.getElementById("reuseOriginalBtn");
  const reuseConvertedBtn = document.getElementById("reuseConvertedBtn");
  const deleteBtn = document.getElementById("deleteBtn");

  // Get entry ID from URL
  const urlParams = new URLSearchParams(window.location.search);
  const entryId = urlParams.get("id");

  if (!entryId) {
    showError("No entry selected.");
    return;
  }

  // Load entry data
  chrome.storage.local.get({ verlauf: [] }, (result) => {
    const verlauf = result.verlauf;
    const entry = verlauf.find((item) => item.id === entryId);

    if (!entry) {
      showError("Entry not found.");
      return;
    }

    // Populate all text views
    const sanitizedOriginal = sanitize(entry.original);
    const sanitizedTranslated = sanitize(entry.translated);
    
    originalText.innerHTML = sanitizedOriginal;
    translatedText.innerHTML = sanitizedTranslated;
    originalTextFull.innerHTML = sanitizedOriginal;
    translatedTextFull.innerHTML = sanitizedTranslated;
    
    // Timestamp
    timestamp.innerHTML = `<i class="bi bi-clock me-1"></i> ${formatDate(entry.timestamp)}`;

    // Calculate stats
    const origChars = entry.original.length;
    const convChars = entry.translated.length;
    const origWords = countWords(entry.original);
    const convWords = countWords(entry.translated);
    
    // Update header stats
    originalChars.textContent = origChars.toLocaleString();
    convertedChars.textContent = convChars.toLocaleString();
    
    // Update side-by-side stats
    originalWordCount.textContent = origWords.toLocaleString();
    originalCharCount.textContent = origChars.toLocaleString();
    convertedWordCount.textContent = convWords.toLocaleString();
    convertedCharCount.textContent = convChars.toLocaleString();

    // Calculate and display differences
    const diff = Diff.diffWords(entry.original, entry.translated);
    
    let addCount = 0;
    let removeCount = 0;
    let unchangeCount = 0;
    
    const html = diff.map((part) => {
      const escapedValue = sanitize(part.value);
      
      if (part.added) {
        addCount++;
        return `<span class="diff-added">${escapedValue}</span>`;
      } else if (part.removed) {
        removeCount++;
        return `<span class="diff-removed">${escapedValue}</span>`;
      } else {
        unchangeCount++;
        return escapedValue;
      }
    }).join("");
    
    diffOutput.innerHTML = html;
    
    // Update change counts
    const totalChanges = addCount + removeCount;
    changeCount.textContent = totalChanges;
    addedCount.textContent = addCount;
    removedCount.textContent = removeCount;
    unchangedCount.textContent = unchangeCount;
    
    // Color code the change count based on magnitude
    if (totalChanges === 0) {
      changeCount.classList.add("text-success");
    } else if (totalChanges < 10) {
      changeCount.classList.add("text-warning");
    } else {
      changeCount.classList.add("text-danger");
    }

    // Setup reuse buttons
    reuseOriginalBtn.addEventListener("click", () => {
      reuseText(entry.original, reuseOriginalBtn);
    });

    reuseConvertedBtn.addEventListener("click", () => {
      reuseText(entry.translated, reuseConvertedBtn);
    });

    // Setup delete button
    deleteBtn.addEventListener("click", () => {
      if (confirm("Are you sure you want to delete this entry? This cannot be undone.")) {
        if (window.trackEvent) {
          window.trackEvent("history_entry_deleted", { source: "detail_page" });
        }
        chrome.storage.local.get({ verlauf: [] }, (res) => {
          const filtered = res.verlauf.filter((e) => e.id !== entryId);
          chrome.storage.local.set({ verlauf: filtered }, () => {
            // Show success message and redirect
            showToast("Entry deleted successfully", "success");
            setTimeout(() => {
              window.close();
            }, 1000);
          });
        });
      }
    });

    // Setup download buttons
    document.querySelectorAll(".dropdown-item[data-format]").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        const format = e.currentTarget.getAttribute("data-format");
        if (window.trackEvent) {
          window.trackEvent("history_single_save_clicked", {
            format: format,
            source: "detail_page",
          });
        }
        downloadEntry(entry, format);
      });
    });
  });

  // Back button
  backBtn.addEventListener("click", () => {
    window.location.href="popup.html";
  });

  // Copy buttons
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");
      const targetElement = document.getElementById(targetId);
      
      if (targetElement) {
        navigator.clipboard.writeText(targetElement.textContent).then(() => {
          // Visual feedback
          const originalHTML = btn.innerHTML;
          btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Copied!';
          btn.classList.remove("btn-outline-secondary", "btn-outline-primary");
          btn.classList.add("btn-success");
          
          setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.classList.remove("btn-success");
            if (targetId.includes("original")) {
              btn.classList.add("btn-outline-secondary");
            } else {
              btn.classList.add("btn-outline-primary");
            }
          }, 2000);
        });
      }
    });
  });

  // Helper functions
  function sanitize(text) {
    const div = document.createElement("div");
    div.innerText = text;
    return div.innerHTML;
  }

  function showError(message) {
    const container = document.querySelector(".container");
    container.innerHTML = `
      <div class="alert alert-danger d-flex align-items-center mt-4" role="alert">
        <i class="bi bi-exclamation-triangle-fill me-2 fs-4"></i>
        <div>
          <strong>Error:</strong> ${message}
          <br>
          <a href="#" onclick="window.close()" class="alert-link">Go back</a>
        </div>
      </div>
    `;
  }

  function reuseText(text, button) {
    chrome.storage.local.set({ lastInput: text }, () => {
      // Visual feedback
      const originalHTML = button.innerHTML;
      button.innerHTML = '<i class="bi bi-check-lg me-1"></i>Copied to Input!';
      button.classList.remove("btn-outline-secondary", "btn-outline-primary");
      button.classList.add("btn-success");
      
      setTimeout(() => {
        button.innerHTML = originalHTML;
        button.classList.remove("btn-success");
        if (button.id === "reuseOriginalBtn") {
          button.classList.add("btn-outline-secondary");
        } else {
          button.classList.add("btn-outline-primary");
        }
      }, 2000);
      
      showToast("Text copied to main input field", "success");
    });
  }

  function showToast(message, type = "info") {
    // Remove existing toast
    const existingToast = document.querySelector(".custom-toast");
    if (existingToast) existingToast.remove();
    
    const bgClass = type === "success" ? "bg-success" : type === "danger" ? "bg-danger" : "bg-primary";
    
    const toast = document.createElement("div");
    toast.className = `custom-toast position-fixed bottom-0 end-0 m-3 p-3 rounded shadow text-white ${bgClass}`;
    toast.style.cssText = "z-index: 9999; opacity: 0; transition: opacity 0.3s ease;";
    toast.innerHTML = `
      <i class="bi bi-${type === 'success' ? 'check-circle' : 'info-circle'} me-2"></i>
      ${message}
    `;
    
    document.body.appendChild(toast);
    
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
    });
    
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function downloadEntry(entry, format) {
    let content, filename, mimeType;
    
    switch (format) {
      case "txt":
        content = `Original:\n${entry.original}\n\n${"=".repeat(50)}\n\nConverted:\n${entry.translated}`;
        filename = `translation_${entry.id}.txt`;
        mimeType = "text/plain";
        break;
        
      case "json":
        content = JSON.stringify({
          id: entry.id,
          timestamp: entry.timestamp,
          original: entry.original,
          translated: entry.translated
        }, null, 2);
        filename = `translation_${entry.id}.json`;
        mimeType = "application/json";
        break;
        
      case "csv":
        const escapeCSV = (str) => `"${str.replace(/"/g, '""')}"`;
        content = `"Type","Content"\n${escapeCSV("Original")},${escapeCSV(entry.original)}\n${escapeCSV("Converted")},${escapeCSV(entry.translated)}`;
        filename = `translation_${entry.id}.csv`;
        mimeType = "text/csv";
        break;
        
      case "word": {
        // Build a real OOXML .docx (ZIP + XML) — compatible with Microsoft Word.
        // Only the translated text is exported (original is already stored locally).
        const blob = buildDocxBlob(entry.translated);
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url, filename: `translation_${entry.id}.docx`, saveAs: true }, () => {
          showToast("Downloaded as DOCX", "success");
        });
        return;
      }
        
      case "pdf":
        // PDF requires jsPDF library - check if available
        if (typeof jspdf !== 'undefined' && jspdf.jsPDF) {
          const { jsPDF } = jspdf;
          const doc = new jsPDF();
          
          let y = 20;
          doc.setFont("helvetica", "bold");
          doc.setFontSize(16);
          doc.text("DeepL Pro Unlimited", 20, y);
          
          doc.setFontSize(10);
          doc.setFont("helvetica", "normal");
          doc.text(formatDate(entry.timestamp), 20, y + 7);
          
          y += 20;
          doc.setFontSize(12);
          doc.setFont("helvetica", "bold");
          doc.text("ORIGINAL:", 20, y);
          
          y += 8;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(10);
          const originalLines = doc.splitTextToSize(entry.original, 170);
          doc.text(originalLines, 20, y);
          
          y += originalLines.length * 5 + 15;
          doc.setFontSize(12);
          doc.setFont("helvetica", "bold");
          doc.text("CONVERTED:", 20, y);
          
          y += 8;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(10);
          const translatedLines = doc.splitTextToSize(entry.translated, 170);
          doc.text(translatedLines, 20, y);
          
          doc.save(`translation_${entry.id}.pdf`);
          showToast("PDF downloaded", "success");
          return;
        } else {
          showToast("PDF library not available", "danger");
          return;
        }
        
      case "md":
        content = `# Translation\n\n*Created: ${formatDate(entry.timestamp)}*\n\n---\n\n## Original\n\n${entry.original}\n\n---\n\n## Converted\n\n${entry.translated}`;
        filename = `translation_${entry.id}.md`;
        mimeType = "text/markdown";
        break;
        
      default:
        showToast("Unknown format", "danger");
        return;
    }
    
    // Download file
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    
    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: true
    }, () => {
      showToast(`Downloaded as ${format.toUpperCase()}`, "success");
    });
  }
});