async function sendTextToDeepL(text) {
  if (!text.trim()) return;

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    function: (payload) => {
      window.postMessage({ type: "DEEPL_TRANSLATE", payload }, "*");
    },
    args: [text],
  });
}

async function sendWithRetry(text, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await sendTextToDeepL(text);

      return true;
    } catch (err) {
      console.warn("Retry attempt", i + 1);

      await wait(1000);
    }
  }

  console.error("Translation failed");

  return false;
}

async function startGroupTranslation(entryDiv) {
  stopTranslation = false;

  const startBtn = entryDiv.querySelector(".start-group");
  const stopBtn = entryDiv.querySelector(".stop-group");

  startBtn.classList.add("d-none");
  stopBtn.classList.remove("d-none");

  const subEntries = entryDiv.querySelectorAll(".sub-entry .sub-entry-text");

  if (!subEntries.length) {
    alert("This group has no entries to translate.");
    return;
  }

  entryDiv.dataset.used = "true";
  await saveEntriesToStorage();

  for (let i = 0; i < subEntries.length; i++) {
    if (stopTranslation) {
        console.log("⏹ Translation stopped");
        break;
    }

    const text = subEntries[i].textContent.trim();
    if (!text) continue;

    console.log(`🌍 Translating entry ${i + 1}/${subEntries.length}`);

    // ✅ Sende Text und warte 1,5 Sekunden für DeepL-UI
    await sendWithRetry(text);
    await wait(1500); // unveränderlich, nicht dynamisch verkleinern
}

  console.log("✅ Group translation finished");
  startBtn.classList.remove("d-none");
  stopBtn.classList.add("d-none");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let entryId = 0;
let entryCounter = 0;
let stopTranslation = false;

// -----------------------------
// Speicher-Helper
// -----------------------------
async function saveEntriesToStorage() {
  const entries = [];
  document.querySelectorAll(".loop-entry").forEach((entry) => {
    const entryObj = {
      id: entry.id,
      name: entry.querySelector(".entry-header .sub-entry-text").textContent,
      date: entry.dataset.date || new Date().toISOString(),
      used: entry.dataset.used === "true",
      subEntries: [],
    };

    entry.querySelectorAll(".sub-entry").forEach((sub) => {
      entryObj.subEntries.push({
        text: sub.querySelector(".sub-entry-text").textContent,
        date: sub.dataset.date || new Date().toISOString(),
      });
    });

    entries.push(entryObj);
  });

  await chrome.storage.local.set({ loopEntries: entries });
  console.log("✅ Loop entries saved:", entries);
}

async function loadEntriesFromStorage() {
  const result = await chrome.storage.local.get("loopEntries");
  const entries = result.loopEntries || [];
  console.log("📦 Loaded loop entries:", entries);

  const container = document.getElementById("entriesContainer");
  container.innerHTML = "";
  entryCounter = 0;

  // 🔹 NEU: Meldung anzeigen wenn keine Einträge existieren
  if (entries.length === 0) {
    container.innerHTML = `
    <div class="alert alert-info text-center d-flex align-items-center justify-content-center gap-2 fade show" role="alert" style="animation: fadeIn 0.4s ease;">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" class="bi bi-info-circle" viewBox="0 0 16 16">
            <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
            <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>
        </svg>
        <span>No batch translations have been added yet.</span>
    </div>
`;
    return;
  }

  entries.forEach((entry) => {
    renderEntry(entry, container);
  });

  updateEntryNumbers();
}

// -----------------------------
// Render-Funktion für gespeicherte Daten
// -----------------------------
function renderEntry(entryData, container) {
  entryId++;
  entryCounter++;

  const entryDiv = document.createElement("div");
  entryDiv.className = "loop-entry";
  entryDiv.id = entryData.id || `entry-${entryId}`;
  entryDiv.dataset.entryNumber = entryCounter;
  entryDiv.dataset.date = entryData.date || new Date().toISOString();
  entryDiv.dataset.used = entryData.used || false;

  const header = document.createElement("div");
  header.className = "entry-header";
  header.innerHTML = `
    <span>
      <span class="entry-number fw-bold">${entryCounter}.</span>
      <div class="sub-entry-text">${entryData.name}</div>
    </span>
    <span class="actions">
      <!-- Details Button mit Info-Icon -->
<button class="btn btn-outline-primary btn-sm details-entry">
  <svg xmlns="http://www.w3.org" width="16" height="16" fill="currentColor" class="bi bi-info-circle me-1" viewBox="0 0 16 16">
    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
    <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>
  </svg>
  Details
</button>
      <!-- Edit Button mit Pencil-Icon -->
<button class="btn btn-outline-secondary btn-sm edit-entry">
  <svg xmlns="http://www.w3.org" width="16" height="16" fill="currentColor" class="bi bi-pencil-square me-1" viewBox="0 0 16 16">
    <path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/>
    <path fill-rule="evenodd" d="M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5z"/>
  </svg>
  Edit
</button>
      <!-- Delete Button (Mülltonne) -->
<button class="btn btn-outline-danger btn-sm delete-entry">
  <svg xmlns="http://www.w3.org" width="16" height="16" fill="currentColor" class="bi bi-trash3 me-1" viewBox="0 0 16 16">
    <path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5M11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1zm1.958 1-.846 10.58a1 1 0 0 1-1.002.92H4.885a1 1 0 0 1-1.002-.92L3.042 3.5zm-7.487 1a.5.5 0 0 1 .528.47l.5 8.5a.5.5 0 0 1-.998.06L5 5.03a.5.5 0 0 1 .47-.53Zm5.058 0a.5.5 0 0 1 .47.53l-.5 8.5a.5.5 0 1 1-.998-.06l.5-8.5a.5.5 0 0 1 .528-.47M8 4.5a.5.5 0 0 1 .5.5v8.5a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5"/>
  </svg>
  Delete
</button>
      <!-- Start Button (Play-Symbol) -->
<button class="btn btn-success btn-sm start-group">
  <svg xmlns="http://www.w3.org" width="16" height="16" fill="currentColor" class="bi bi-play-fill me-1" viewBox="0 0 16 16">
    <path d="m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393"/>
  </svg>
  Start
</button>
<button class="btn btn-warning btn-sm stop-group d-none">
⏹ Stop
</button>
    </span>
  `;
  entryDiv.appendChild(header);

  const subContainer = document.createElement("div");
  subContainer.className = "sub-container collapse";
  subContainer.dataset.subEntryCounter = entryData.subEntries?.length || 0;
  entryDiv.appendChild(subContainer);

  if (entryData.subEntries) {
    entryData.subEntries.forEach((sub, i) => {
      const subDiv = document.createElement("div");
      subDiv.className = "sub-entry";
      subDiv.dataset.date = sub.date || new Date().toISOString();
      subDiv.innerHTML = `
        <span class="sub-entry-number fw-bold">${entryCounter}.${i + 1}</span>
        <div class="sub-entry-text">${sub.text}</div>
        <span class="toggle-text">Show more</span>
        <span class="actions">
          <button class="btn btn-outline-secondary btn-sm edit-sub">✏️ Edit</button>
          <button class="btn btn-outline-danger btn-sm delete-sub">🗑️ Delete</button>
        </span>
      `;
      subContainer.appendChild(subDiv);
      updateTextToggle(subDiv);
    });
  }

  const subInputGroup = document.createElement("div");
subInputGroup.className = "sub-input-wrapper mb-3 d-none";

subInputGroup.innerHTML = `

<div class="d-flex gap-2 mb-2">

<textarea 
class="form-control sub-input flex-grow-1" 
placeholder="New subentry..." 
rows="2">
</textarea>

<button class="btn btn-primary addSubEntry">
➕ Add
</button>

</div>

<div class="d-flex gap-2">

<button class="btn btn-outline-secondary btn-sm copySubEntry">
📋 Copy
</button>

<button class="btn btn-outline-secondary btn-sm pasteSubEntry">
📥 Paste
</button>

<button class="btn btn-outline-danger btn-sm clearSubEntry">
🗑️ Clear
</button>

</div>
`;
 const addSubToggle = document.createElement("button");

addSubToggle.className = "btn btn-outline-primary btn-sm mb-2 toggle-sub-input";
addSubToggle.innerHTML = `➕ Add Subentry`;

subContainer.prepend(subInputGroup);
subContainer.prepend(addSubToggle);

addSubToggle.addEventListener("click", () => {

const isHidden = subInputGroup.classList.contains("d-none");

if (isHidden) {

subInputGroup.classList.remove("d-none");
addSubToggle.innerHTML = "❌ Close";

const textarea = subInputGroup.querySelector(".sub-input");
textarea.focus();

} else {

subInputGroup.classList.add("d-none");
addSubToggle.innerHTML = "➕ Add Subentry";

}

});

 

addSubToggle.className = "btn btn-outline-primary btn-sm mb-2 toggle-sub-input";

addSubToggle.innerHTML = `
➕ Add Subentry
`;

  // Optional: Event Listener Beispiel
  const textarea = subInputGroup.querySelector(".sub-input");

  // Add Button
  subInputGroup.querySelector(".addSubEntry").addEventListener("click", () => {
    console.log("Add subentry:", textarea.value);
  });

  // Copy Button
  subInputGroup.querySelector(".copySubEntry").addEventListener("click", () => {
    navigator.clipboard.writeText(textarea.value);
    console.log("Copied:", textarea.value);
  });

  // Paste Button
  subInputGroup
    .querySelector(".pasteSubEntry")
    .addEventListener("click", async () => {
      const clipText = await navigator.clipboard.readText();
      textarea.value = clipText;
      console.log("Pasted:", clipText);
    });

  // Clear Button
  subInputGroup
    .querySelector(".clearSubEntry")
    .addEventListener("click", () => {
      textarea.value = "";
      console.log("Cleared");
    });

  container.prepend(entryDiv);

  // Initialize Bootstrap collapse
  const collapse = new bootstrap.Collapse(subContainer, {
    toggle: false,
  });

  // Add click event for details button
  header.querySelector(".details-entry").addEventListener("click", (e) => {
    const isExpanded = subContainer.classList.contains("show");
    collapse.toggle();

    const btn = e.currentTarget;

    if (isExpanded) {
      // Zurück zu "Details" (Blau)
      btn.classList.replace("btn-outline-danger", "btn-outline-primary");
      btn.innerHTML = `
      <svg xmlns="http://www.w3.org" width="16" height="16" fill="currentColor" class="bi bi-info-circle me-1" viewBox="0 0 16 16">
        <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
        <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>
      </svg> Details`;
    } else {
      // Wechsel zu "Close" (Rot)
      btn.classList.replace("btn-outline-primary", "btn-outline-danger");
      btn.innerHTML = `
      <svg xmlns="http://www.w3.org" width="16" height="16" fill="currentColor" class="bi bi-x-circle me-1" viewBox="0 0 16 16">
        <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
        <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"/>
      </svg> Close`;
    }
  });
}

// -----------------------------
// Events
// -----------------------------
document.getElementById("addLoop").addEventListener("click", function () {
  const input = document.getElementById("mainEntryInput");
  const value = input.value.trim();
  if (!value) return;

  const newEntry = {
    id: `entry-${Date.now()}`,
    name: value,
    date: new Date().toISOString(),
    used: false,
    subEntries: [],
  };

  const container = document.getElementById("entriesContainer");

  // 🔹 NEU: Entfernt die "keine Einträge" Meldung
  const alert = container.querySelector(".alert");
  if (alert) alert.remove();

  renderEntry(newEntry, container);
  updateEntryNumbers();
  input.value = "";

  saveEntriesToStorage();
});

// 🔹 NEU: Enter-Taste erstellt neuen Eintrag
document
  .getElementById("mainEntryInput")
  .addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("addLoop").click();
    }
  });

document
  .getElementById("entriesContainer")
  .addEventListener("click", function (e) {
    if (e.target.classList.contains("addSubEntry")) {
      addSubEntry(e.target);
    } else if (e.target.classList.contains("toggle-text")) {
      toggleText(e.target);
    } else if (e.target.classList.contains("edit-entry")) {
      startEditText(e.target, "entry");
    } else if (e.target.classList.contains("delete-entry")) {
      deleteEntry(e.target, "entry");
    } else if (e.target.classList.contains("edit-sub")) {
      startEditText(e.target, "sub");
    } else if (e.target.classList.contains("delete-sub")) {
      deleteEntry(e.target, "sub");
    } else if (e.target.classList.contains("save-edit")) {
      saveEditText(e.target);
    } else if (e.target.classList.contains("start-group")) {
      const entryDiv = e.target.closest(".loop-entry");
      startGroupTranslation(entryDiv);
    } else if (e.target.classList.contains("stop-group")) {
      stopTranslation = true;
    }
  });

// 🔹 NEU: Enter erstellt Subentry
document
  .getElementById("entriesContainer")
  .addEventListener("keydown", function (e) {
    if (
      e.target.classList.contains("sub-input") &&
      e.key === "Enter" &&
      !e.shiftKey
    ) {
      e.preventDefault();

      const entryDiv = e.target.closest(".loop-entry");
      const addBtn = entryDiv.querySelector(".addSubEntry");

      if (addBtn) addBtn.click();
    }
  });

function addSubEntry(btn) {
  const entryDiv = btn.closest(".loop-entry");
  const subContainer = entryDiv.querySelector(".sub-container");
  const subInput = entryDiv.querySelector(".sub-input");
  const text = subInput.value.trim();
  if (!text) return;

  const subEntryCounter = parseInt(subContainer.dataset.subEntryCounter) + 1;
  subContainer.dataset.subEntryCounter = subEntryCounter;

  const subDiv = document.createElement("div");
  subDiv.className = "sub-entry";
  subDiv.dataset.date = new Date().toISOString();
  subDiv.innerHTML = `
    <span class="sub-entry-number fw-bold">${entryDiv.dataset.entryNumber}.${subEntryCounter}</span>
    <div class="sub-entry-text">${text}</div>
    <span class="toggle-text">Mehr anzeigen</span>
    <span class="actions">
      <button class="btn btn-outline-secondary btn-sm edit-sub">✏️ Edit</button>
      <button class="btn btn-outline-danger btn-sm delete-sub">🗑️ Delete</button>
    </span>
  `;
  subContainer.appendChild(subDiv);
  subInput.value = "";

const inputWrapper = entryDiv.querySelector(".sub-input-wrapper");
const toggleBtn = entryDiv.querySelector(".toggle-sub-input");

inputWrapper.classList.add("d-none");
toggleBtn.innerHTML = "➕ Add Subentry";

  updateTextToggle(subDiv);
  saveEntriesToStorage();

  // Ensure sub-container is visible when adding a new sub-entry
  const collapse = new bootstrap.Collapse(subContainer, { toggle: false });
  if (!subContainer.classList.contains("show")) {
    collapse.show();
    entryDiv.querySelector(".details-entry").textContent = "Close";
  }
}

// -----------------------------
// Edit / Delete / Save
// -----------------------------
function startEditText(btn, type) {
  const parent =
    type === "entry" ? btn.closest(".loop-entry") : btn.closest(".sub-entry");
  const textElement = parent.querySelector(".sub-entry-text");
  const currentText = textElement.textContent;

  const textarea = document.createElement("textarea");
  textarea.className = "form-control";
  textarea.value = currentText;
  if (type === "sub") textarea.rows = 2;

  textElement.replaceWith(textarea);
  textarea.focus();

  btn.textContent = "💾 Save";
  btn.classList.remove("edit-entry", "edit-sub");
  btn.classList.add("save-edit");
}

function saveEditText(btn) {
  const parent = btn.closest(".loop-entry") || btn.closest(".sub-entry");
  const textarea = parent.querySelector("textarea");
  const type = btn.closest(".loop-entry") ? "entry" : "sub";
  const textElement = document.createElement("div");
  textElement.className = "sub-entry-text";
  const newText = textarea.value.trim();

  if (newText) {
    textElement.textContent = newText;
    textarea.replaceWith(textElement);
    if (type === "sub") updateTextToggle(parent);
  } else {
    textarea.replaceWith(textElement);
  }

  btn.textContent = "✏️ Edit";
  btn.classList.remove("save-edit");
  btn.classList.add(type === "entry" ? "edit-entry" : "edit-sub");

  saveEntriesToStorage();
}

function deleteEntry(btn, type) {
  const parent =
    type === "entry" ? btn.closest(".loop-entry") : btn.closest(".sub-entry");
  parent.remove();
  if (type === "entry") updateEntryNumbers();
  saveEntriesToStorage();
}

// -----------------------------
// Helpers
// -----------------------------
function updateEntryNumbers() {
  const entries = document.querySelectorAll(".loop-entry");
  entryCounter = entries.length;
  entries.forEach((entry, index) => {
    const number = entryCounter - index;
    entry.dataset.entryNumber = number;
    entry.querySelector(".entry-number").textContent = `${number}.`;
    const subEntries = entry.querySelectorAll(".sub-entry");
    subEntries.forEach((sub, subIndex) => {
      sub.querySelector(".sub-entry-number").textContent =
        `${number}.${subIndex + 1}`;
    });
  });
}

function updateTextToggle(subDiv) {
  const textDiv = subDiv.querySelector(".sub-entry-text");
  const toggle = subDiv.querySelector(".toggle-text");
  if (!textDiv || !toggle) return;

  if (textDiv.scrollHeight > textDiv.clientHeight) {
    toggle.style.display = "inline-block";
    toggle.textContent = "Show more";
  } else {
    toggle.style.display = "none";
  }
}

function toggleText(toggle) {
  const textDiv = toggle.previousElementSibling;
  if (textDiv.classList.contains("expanded")) {
    textDiv.classList.remove("expanded");
    toggle.textContent = "Show more";
  } else {
    textDiv.classList.add("expanded");
    toggle.textContent = "Show less";
  }
}

// -----------------------------
// Init beim Laden
// -----------------------------
document.addEventListener("DOMContentLoaded", loadEntriesFromStorage);
