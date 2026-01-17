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
      historyList.innerHTML = "<p class='text-muted'>No entries available yet.</p>";
      return;
    }

    verlauf.slice().reverse().forEach((entry) => {
      const item = document.createElement("div");
      item.className = "history-entry border-bottom pb-3 mb-3"; // Trennlinie für bessere Übersicht

      item.innerHTML = `
        <small class="text-muted d-block mb-1">
          <svg xmlns="http://www.w3.org" width="12" height="12" fill="currentColor" class="bi bi-clock me-1" viewBox="0 0 16 16">
            <path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71z"/>
            <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16m7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0"/>
          </svg>
          ${new Date(entry.timestamp).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
          })}
        </small>
        
        <div class="mb-2">
          <strong class="d-block small text-secondary">Original:</strong>
          <pre>${sanitize(entry.original)}</pre>
        </div>
        <div class="mb-2">
          <strong class="d-block small text-primary">Converted:</strong>
          <pre>${sanitize(entry.translated)}</pre>
        </div>
        
        <div class="d-flex gap-2 align-items-center">
          <!-- Details Button -->
          <button class="btn btn-outline-primary btn-sm details-entry" data-id="${entry.id}">
            <svg xmlns="http://www.w3.org" width="16" height="16" fill="currentColor" class="bi bi-info-circle me-1" viewBox="0 0 16 16">
    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
    <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>
  </svg>
            Details
          </button>
          
          <!-- Copy Button -->
          <button class="btn btn-outline-success btn-sm copy-btn" data-text="${sanitize(entry.translated)}">
            <svg xmlns="http://www.w3.org" width="16" height="16" fill="currentColor" class="bi bi-clipboard me-1" viewBox="0 0 16 16">
              <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1z"/>
              <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0z"/>
            </svg>
            Copy
          </button>

          <!-- Download Dropdown -->
          <div class="dropdown">
            <button class="btn btn-outline-secondary btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown">
              <svg xmlns="http://www.w3.org" width="16" height="16" fill="currentColor" class="bi bi-download me-1" viewBox="0 0 16 16">
                <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5"/>
                <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708z"/>
              </svg>
              Download
            </button>
            <ul class="dropdown-menu">
              <li><a class="dropdown-item" href="#" data-id="${entry.id}" data-format="txt">TXT</a></li>
              <li><a class="dropdown-item" href="#" data-id="${entry.id}" data-format="json">JSON</a></li>
              <li><a class="dropdown-item" href="#" data-id="${entry.id}" data-format="csv">CSV</a></li>
            </ul>
          </div>
        </div>
      `;


      // Event: Details Button
      item.querySelector(".details-entry").addEventListener("click", () => {
        const url = chrome.runtime.getURL("history-detail.html") + `?id=${entry.id}`;
        chrome.tabs.create({ url });
      });

      // Event: Copy Button funktionsfähig machen
      item.querySelector(".copy-btn").addEventListener("click", function() {
        const textToCopy = entry.translated;
        navigator.clipboard.writeText(textToCopy).then(() => {
          const originalHTML = this.innerHTML;
          this.innerHTML = '<i class="bi bi-check-lg"></i> Copied!';
          this.classList.replace('btn-outline-success', 'btn-success');
          
          setTimeout(() => {
            this.innerHTML = originalHTML;
            this.classList.replace('btn-success', 'btn-outline-success');
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
document.getElementById("bugBtn").addEventListener("click", ()=>{
  window.open("https://forms.gle/7LNwEpVCbXwunT6s8");
})
document.getElementById("featureBtn").addEventListener("click", ()=>{
  window.open("https://forms.gle/rFiHJZesQkrP6RiGA", "_blank");
})