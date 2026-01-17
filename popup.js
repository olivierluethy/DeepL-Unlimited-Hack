document.addEventListener("DOMContentLoaded", () => {
  const sendBtn = document.getElementById("sendBtn");
  const inputText = document.getElementById("inputText");
  const status = document.getElementById("status");
  const historyList = document.getElementById("historyList");

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

  // Senden an Content Script
  sendBtn.addEventListener("click", async () => {
    const text = inputText.value.trim();
    if (!text) return alert("Please enter text.");

    status.innerText = "Send to DeepL...";

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: sendTextToContent,
      args: [text],
    });

    status.innerText = "Text has been sent.";
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
          "<p class='text-muted'>No entries available yet.</p>";
        return;
      }

      verlauf
        .slice()
        .reverse()
        .forEach((entry) => {
          const item = document.createElement("div");
          item.className = "history-entry";

          item.innerHTML = `
  <small class="text-muted">${new Date(entry.timestamp).toLocaleString('en-US', {
    month: 'short',   // "Jan" statt "January"
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true      // Behält AM/PM bei, entfernt aber die Sekunden
  })}</small>
  <div class="mt-2">
    <strong>Original:</strong>
    <pre>${sanitize(entry.original)}</pre>
  </div>
  <div>
    <strong>Converted:</strong>
    <pre>${sanitize(entry.translated)}</pre>
  </div>
  <button class="btn btn-outline-primary btn-sm mt-2" data-id="${
    entry.id
  }">Details</button>
  <div class="dropdown mt-2">
    <button class="btn btn-outline-primary btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
      Download
    </button>
    <ul class="dropdown-menu">
      <li><a class="dropdown-item" href="#" data-id="${
        entry.id
      }" data-format="txt">Als TXT</a></li>
      <li><a class="dropdown-item" href="#" data-id="${
        entry.id
      }" data-format="json">Als JSON</a></li>
      <li><a class="dropdown-item" href="#" data-id="${
        entry.id
      }" data-format="csv">Als CSV</a></li>
    </ul>
  </div>
`;

          // Event Listener für Details-Button
          item
            .querySelector("button[data-id]")
            .addEventListener("click", (e) => {
              const entryId = e.target.getAttribute("data-id");
              const url =
                chrome.runtime.getURL("history-detail.html") + `?id=${entryId}`;
              chrome.tabs.create({ url });
            });

          // Event Listener für Dropdown-Items
          item.querySelectorAll(".dropdown-item").forEach((dropdownItem) => {
            dropdownItem.addEventListener("click", (e) => {
              e.preventDefault();
              const entryId = e.target.getAttribute("data-id");
              const format = e.target.getAttribute("data-format");
              downloadEntry(entryId, format);
            });
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
          '""'
        )}","${entry.translated.replace(/"/g, '""')}"`;
        filename = `translation_${entryId}.csv`;
        mimeType = "text/csv";
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
