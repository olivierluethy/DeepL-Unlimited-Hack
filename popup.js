document.addEventListener("DOMContentLoaded", () => {
  const sendBtn = document.getElementById("sendBtn");
  const inputText = document.getElementById("inputText");
  const status = document.getElementById("status");
  const historyList = document.getElementById("historyList");
  const startLoopBtn = document.getElementById("startLoopBtn");
  const loopStatus = document.getElementById("loopStatus");
  const loopHistoryList = document.getElementById("loopHistoryList");

  // Initialisiere Bootstrap Tabs
  const tabList = document.querySelectorAll('#appTabs a[data-bs-toggle="tab"]');
  tabList.forEach((tab) => {
    tab.addEventListener("shown.bs.tab", (event) => {
      const target = event.target.getAttribute("href");
      if (target === "#history") {
        loadHistory();
      } else if (target === "#loop") {
        loadLoopHistory();
      }
    });
  });

  // Senden an Content Script
  sendBtn.addEventListener("click", async () => {
    const text = inputText.value.trim();
    if (!text) return alert("Bitte Text eingeben.");

    status.innerText = "Sende an DeepL...";

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: sendTextToContent,
      args: [text],
    });

    status.innerText = "Text wurde gesendet.";
  });

  // Start Loop-Konvertierung
  startLoopBtn.addEventListener("click", async () => {
    const loopTexts = document.getElementById("loopTexts").value.trim();
    if (!loopTexts) return alert("Bitte Texte für Loop eingeben.");

    loopStatus.innerText = "Starte Loop-Konvertierung...";
    // Hier Logik für Loop-Konvertierung hinzufügen
    loopStatus.innerText = "Loop-Konvertierung abgeschlossen.";
  });

  function sendTextToContent(text) {
    window.postMessage({ type: "DEEPL_TRANSLATE", payload: text }, "*");
  }

  function loadHistory() {
    chrome.storage.local.get({ verlauf: [] }, (result) => {
      const verlauf = result.verlauf;
      historyList.innerHTML = "";

      if (!verlauf.length) {
        historyList.innerHTML =
          "<p class='text-muted'>Noch keine Einträge vorhanden.</p>";
        return;
      }

      verlauf
        .slice()
        .reverse()
        .forEach((entry) => {
          const item = document.createElement("div");
          item.className = "history-entry";

          item.innerHTML = `
            <small class="text-muted">${new Date(
              entry.timestamp
            ).toLocaleString()}</small>
            <div class="mt-2">
              <strong>Original:</strong>
              <pre>${sanitize(entry.original)}</pre>
            </div>
            <div>
              <strong>Übersetzt:</strong>
              <pre>${sanitize(entry.translated)}</pre>
            </div>
          `;

          historyList.appendChild(item);
        });
    });
  }

  function loadLoopHistory() {
    // Beispiel für Loop-Verlauf, anpassen nach Bedarf
    chrome.storage.local.get({ loopVerlauf: [] }, (result) => {
      const loopVerlauf = result.loopVerlauf;
      loopHistoryList.innerHTML = "";

      if (!loopVerlauf.length) {
        loopHistoryList.innerHTML =
          "<p class='text-muted'>Noch keine Loop-Einträge vorhanden.</p>";
        return;
      }

      loopVerlauf
        .slice()
        .reverse()
        .forEach((entry) => {
          const item = document.createElement("div");
          item.className = "loop-entry";

          item.innerHTML = `
            <small class="text-muted">${new Date(
              entry.timestamp
            ).toLocaleString()}</small>
            <div class="mt-2">
              <strong>Original:</strong>
              <pre>${sanitize(entry.original)}</pre>
            </div>
            <div>
              <strong>Übersetzt:</strong>
              <pre>${sanitize(entry.translated)}</pre>
            </div>
          `;

          loopHistoryList.appendChild(item);
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
