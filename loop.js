let entryId = 0;
let entryCounter = 0;

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
  console.log("✅ Loop-Einträge gespeichert:", entries);
}

async function loadEntriesFromStorage() {
  const result = await chrome.storage.local.get("loopEntries");
  const entries = result.loopEntries || [];
  console.log("📦 Geladene Loop-Einträge:", entries);

  const container = document.getElementById("entriesContainer");
  container.innerHTML = "";
  entryCounter = 0;

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
      <button class="btn btn-outline-secondary btn-sm edit-entry">✏️ Bearbeiten</button>
      <button class="btn btn-outline-danger btn-sm delete-entry">🗑️ Löschen</button>
    </span>
  `;
  entryDiv.appendChild(header);

  const subContainer = document.createElement("div");
  subContainer.className = "sub-container";
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
        <span class="toggle-text">Mehr anzeigen</span>
        <span class="actions">
          <button class="btn btn-outline-secondary btn-sm edit-sub">✏️ Bearbeiten</button>
          <button class="btn btn-outline-danger btn-sm delete-sub">🗑️ Löschen</button>
        </span>
      `;
      subContainer.appendChild(subDiv);
      updateTextToggle(subDiv);
    });
  }

  const subInputGroup = document.createElement("div");
  subInputGroup.className = "input-group mb-2";
  subInputGroup.innerHTML = `
    <textarea class="form-control sub-input" placeholder="Neuer Untereintrag..." rows="2"></textarea>
    <button class="btn btn-outline-primary btn-sm addSubEntry">➕ Hinzufügen</button>
  `;
  entryDiv.appendChild(subInputGroup);

  container.prepend(entryDiv);
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
  renderEntry(newEntry, container);
  updateEntryNumbers();
  input.value = "";

  saveEntriesToStorage();
});

document.getElementById("entriesContainer").addEventListener("click", function (e) {
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
      <button class="btn btn-outline-secondary btn-sm edit-sub">✏️ Bearbeiten</button>
      <button class="btn btn-outline-danger btn-sm delete-sub">🗑️ Löschen</button>
    </span>
  `;
  subContainer.appendChild(subDiv);
  subInput.value = "";

  updateTextToggle(subDiv);
  saveEntriesToStorage();
}

// -----------------------------
// Edit / Delete / Save
// -----------------------------
function startEditText(btn, type) {
  const parent = type === "entry" ? btn.closest(".loop-entry") : btn.closest(".sub-entry");
  const textElement = parent.querySelector(".sub-entry-text");
  const currentText = textElement.textContent;

  const textarea = document.createElement("textarea");
  textarea.className = "form-control";
  textarea.value = currentText;
  if (type === "sub") textarea.rows = 2;

  textElement.replaceWith(textarea);
  textarea.focus();

  btn.textContent = "💾 Speichern";
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

  btn.textContent = "✏️ Bearbeiten";
  btn.classList.remove("save-edit");
  btn.classList.add(type === "entry" ? "edit-entry" : "edit-sub");

  saveEntriesToStorage();
}

function deleteEntry(btn, type) {
  const parent = type === "entry" ? btn.closest(".loop-entry") : btn.closest(".sub-entry");
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
      sub.querySelector(".sub-entry-number").textContent = `${number}.${subIndex + 1}`;
    });
  });
}

function updateTextToggle(subDiv) {
  const textDiv = subDiv.querySelector(".sub-entry-text");
  const toggle = subDiv.querySelector(".toggle-text");
  if (!textDiv || !toggle) return;

  if (textDiv.scrollHeight > textDiv.clientHeight) {
    toggle.style.display = "inline-block";
    toggle.textContent = "Mehr anzeigen";
  } else {
    toggle.style.display = "none";
  }
}

function toggleText(toggle) {
  const textDiv = toggle.previousElementSibling;
  if (textDiv.classList.contains("expanded")) {
    textDiv.classList.remove("expanded");
    toggle.textContent = "Mehr anzeigen";
  } else {
    textDiv.classList.add("expanded");
    toggle.textContent = "Weniger anzeigen";
  }
}

// -----------------------------
// Init beim Laden
// -----------------------------
document.addEventListener("DOMContentLoaded", loadEntriesFromStorage);