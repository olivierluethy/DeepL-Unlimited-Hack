const formatDate = (ts) => new Date(ts).toLocaleString('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
});

document.addEventListener("DOMContentLoaded", () => {
  const originalText = document.getElementById("originalText");
  const translatedText = document.getElementById("translatedText");
  const timestamp = document.getElementById("timestamp");
  const backBtn = document.getElementById("backBtn");
  const diffOutput = document.getElementById("diffOutput");
  const changeCounter = document.getElementById("changeCounter");

  // Hole die ID aus der URL
  const urlParams = new URLSearchParams(window.location.search);
  const entryId = urlParams.get("id");

  if (!entryId) {
    originalText.innerText = "No entry selected.";
    translatedText.innerText = "";
    diffOutput.innerText = "";
    return;
  }

  // Lade Verlaufsdaten aus chrome.storage.local
  chrome.storage.local.get({ verlauf: [] }, (result) => {
    const verlauf = result.verlauf;
    const entry = verlauf.find((item) => item.id === entryId);

    if (!entry) {
      originalText.innerText = "Entry not found.";
      translatedText.innerText = "";
      diffOutput.innerText = "";
      return;
    }

    // Zeige Original- und konvertierter Text
    originalText.innerHTML = sanitize(entry.original);
    translatedText.innerHTML = sanitize(entry.translated);
    timestamp.innerText = `Created: ${formatDate(entry.timestamp)}`;

    // Berechne und zeige Unterschiede mit der Diff-Bibliothek
    const diff = Diff.diffWords(entry.original, entry.translated);
    let changeCount = 0;
    const html = diff
      .map((part, index) => {
        const isAdded = part.added;
        const isRemoved = part.removed;
        if (isAdded || isRemoved) changeCount++;
        const className = isAdded
          ? "diff-added"
          : isRemoved
          ? "diff-removed"
          : "";
        return `<span class="${className}">${sanitize(part.value)}</span>`;
      })
      .join("");
    diffOutput.innerHTML = html;
    changeCounter.innerText = `Number of changes: ${changeCount}`;
  });

  // Zurück-Button
  backBtn.addEventListener("click", () => {
    window.location.href = "popup.html#history";
  });

  // Hilfsfunktion zum Entschärfen von <, > etc.
  function sanitize(text) {
    const div = document.createElement("div");
    div.innerText = text;
    return div.innerHTML;
  }
});
