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

  // --- Lade gespeicherten Input beim Start ---
  chrome.storage.local.get({ lastInput: "" }, (result) => {
    inputText.value = result.lastInput;
  });

  // --- Speichere Input bei jeder Änderung ---
  inputText.addEventListener("input", () => {
    chrome.storage.local.set({ lastInput: inputText.value });
  });

  // --- Send to DeepL Button ---
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

    status.innerText = "Send to DeepL...";

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: sendTextToContent,
      args: [text],
    });

    status.innerText = "Text has been sent.";

    // --- Input nach Senden löschen ---
    inputText.value = "";
    chrome.storage.local.set({ lastInput: "" });
  });

  /*
    Damit der Swap-Button einen echten Mehrwert bietet, sollte er den Textinhalt logisch umkehren. Da DeepL oft dazu genutzt wird, einen Text zu verbessern oder zu übersetzen, ist die nützlichste Funktion für diesen Button: Den konvertierten Text aus der Historie zurück in das Eingabefeld zu holen.
Hier ist die vollständige Überarbeitung. Der Button nimmt nun den letzten konvertierten Text und setzt ihn oben ins Feld ein, damit du ihn sofort weiterbearbeiten oder erneut senden kannst.
    */
  // Swap Button: Aktuell nur eine visuelle Umkehrung (da Sprachlogik noch fehlt)
  swapBtn.addEventListener("click", () => {
    // 1. Visuelle Animation (Rotation)
    swapBtn.style.transform = "rotate(180deg)";
    swapBtn.style.transition = "transform 0.3s ease";

    // Zurücksetzen der Rotation nach der Animation
    setTimeout(() => {
      swapBtn.style.transform = "rotate(0deg)";
    }, 300);

    // 2. Logik: Letzten Eintrag aus dem Speicher holen
    chrome.storage.local.get({ verlauf: [] }, (result) => {
      const verlauf = result.verlauf;

      if (verlauf.length > 0) {
        // Hol den aktuellsten Eintrag (das letzte Element im Array)
        const lastEntry = verlauf[verlauf.length - 1];

        // Den konvertierten Text in das Eingabefeld kopieren
        inputText.value = lastEntry.translated;

        // Fokus auf das Feld setzen für bessere UX
        inputText.focus();

        // Optional: Kleines visuelles Feedback in der Statuszeile
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

    // 1. Zeilenumbrüche innerhalb von Sätzen entfernen (nur einzelne Umbrüche durch Leerzeichen ersetzen)
    // 2. Mehrfache Leerzeichen auf eines reduzieren
    // 3. Vorne und hinten trimmen
    const fixedText = text
      .replace(/([^.\n])\n([^.\n])/g, "$1 $2") // Ersetzt Zeilenumbrüche, die nicht nach einem Punkt kommen
      .replace(/\s+/g, " ") // Reduziert alle Whitespaces (Tabs, Mehrfache Leerzeichen) auf 1 Leerzeichen
      .trim();

    inputText.value = fixedText;

    // Optisches Feedback
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
        // Kurzes Feedback (Icon-Wechsel)
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
          // Nach Paste Input speichern
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
    chrome.storage.local.get({ verlauf: [] }, (result) => {
      const verlauf = result.verlauf;

      // Den Container stylen, falls noch nicht im CSS geschehen
      historyList.style.maxHeight = "500px";
      historyList.style.overflowY = "auto";
      historyList.style.overflowX = "hidden";
      historyList.className = "custom-scrollbar"; // Optional für schickeres Design

      historyList.innerHTML = "";

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

        <!-- Button-Reihe: Jetzt mit flex-fill für gleichmässige Breite -->
        <div class="d-flex flex-nowrap gap-1 mt-2">
          <button class="btn btn-outline-primary btn-sm flex-fill d-flex align-items-center justify-content-center details-entry" style="font-size: 0.7rem; padding: 4px 2px;">
            <svg xmlns="http://www.w3.org" width="12" height="12" fill="currentColor" class="bi bi-info-circle me-1" viewBox="0 0 16 16"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/><path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/></svg>
            <span>Details</span>
          </button>
          
          <button class="btn btn-outline-success btn-sm flex-fill d-flex align-items-center justify-content-center copy-btn" style="font-size: 0.7rem; padding: 4px 2px;">
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
`;

          // Reuse-Logik mit Animation
          const setupReuse = (btnSelector, text) => {
            const btn = item.querySelector(btnSelector);
            btn.addEventListener("click", () => {
              const icon = btn.querySelector("svg");
              icon.style.transition = "transform 0.4s ease";
              icon.style.transform = "rotate(-360deg)";

              inputText.value = text;
              chrome.storage.local.set({ lastInput: text });
              inputText.focus();

              setTimeout(() => {
                icon.style.transition = "none";
                icon.style.transform = "rotate(0deg)";
              }, 400);
            });
          };

          // Hilfsfunktion für die Animation und Logik
          const handleReuse = (btn, text) => {
            // 1. Animation: Das SVG-Icon im Button finden und drehen
            const icon = btn.querySelector("svg");
            if (icon) {
              icon.style.transition = "transform 0.4s ease";
              icon.style.transform = "rotate(-360deg)";

              // Nach der Animation zurücksetzen (ohne dass man es sieht)
              setTimeout(() => {
                icon.style.transition = "none";
                icon.style.transform = "rotate(0deg)";
              }, 400);
            }

            // 2. Logik: Text in das Eingabefeld (inputText) einfügen
            if (typeof inputText !== "undefined") {
              inputText.value = text;
              chrome.storage.local.set({ lastInput: inputText.value });

              // Optionales Feedback (falls dein Status-Element existiert)
              if (typeof status !== "undefined") {
                status.innerText = "Text restored to input field.";
                setTimeout(() => {
                  status.innerText = "";
                }, 2000);
              }
            }
          };

          // Die Event-Listener in deinem Loop:
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

          // Bestehende Event-Listener (Details, Copy, Delete...)
          item.querySelector(".details-entry").addEventListener("click", () => {
            const url =
              chrome.runtime.getURL("history-detail.html") + `?id=${entry.id}`;
            chrome.tabs.create({ url });
          });

          item
            .querySelector(".copy-btn")
            .addEventListener("click", function () {
              navigator.clipboard.writeText(entry.translated).then(() => {
                const oldHTML = this.innerHTML;
                this.innerHTML = "✅ Copied";
                setTimeout(() => {
                  this.innerHTML = oldHTML;
                }, 2000);
              });
            });

          // Event: Dropdown-Items
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
        // Wir nutzen HTML-Content, deklarieren ihn aber explizit für Word
        const header =
          "<html xmlns:o='urn:schemas-microsoft-com:office:office' " +
          "xmlns:w='urn:schemas-microsoft-com:office:word' " +
          "xmlns='http://www.w3.org'>" +
          "<head><meta charset='utf-8'></head><body>";
        const footer = "</body></html>";

        const body = `
          <h3 style="color: #6c757d; font-family: sans-serif;">Original:</h3>
          <p style="font-family: Arial; white-space: pre-wrap;">${entry.original.replace(/\n/g, "<br>")}</p>
          <hr>
          <h3 style="color: #0d6efd; font-family: sans-serif;">Converted:</h3>
          <p style="font-family: Arial; white-space: pre-wrap;">${entry.translated.replace(/\n/g, "<br>")}</p>
        `;

        content = header + body + footer;
        filename = `translation_${entryId}.docx`;
        // Wichtig: Office-spezifischer MIME-Type für Word-Dokumente
        mimeType =
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
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

        return; // ⭐ WICHTIG
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

  // Hilfsfunktion zum Entschärfen von <, > etc.
  function sanitize(text) {
    const div = document.createElement("div");
    div.innerText = text;
    return div.innerHTML;
  }
});
document.getElementById("bugBtn").addEventListener("click", () => {
  window.open("https://forms.gle/7LNwEpVCbXwunT6s8");
});
document.getElementById("featureBtn").addEventListener("click", () => {
  window.open("https://forms.gle/rFiHJZesQkrP6RiGA", "_blank");
});
