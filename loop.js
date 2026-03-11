// ============================================
// DeepL Pro Unlimited - Loop/Batch Management
// Features: Drag-Drop, Progress Bar, Multi-Paste,
// Smart Enter, Auto-Focus, Bootstrap Animations
// ============================================

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

// -----------------------------
// Progress Bar Management
// -----------------------------
function createProgressBar(entryDiv) {
  // Remove existing progress bar if any
  const existing = entryDiv.querySelector(".progress-wrapper");
  if (existing) existing.remove();

  const progressWrapper = document.createElement("div");
  progressWrapper.className = "progress-wrapper mt-2 mb-2";
  progressWrapper.innerHTML = `
    <div class="d-flex justify-content-between align-items-center mb-1">
      <small class="text-muted progress-label">Processing...</small>
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
  `;
  
  const header = entryDiv.querySelector(".entry-header");
  header.after(progressWrapper);
  
  return progressWrapper;
}

function updateProgressBar(entryDiv, current, total) {
  const progressWrapper = entryDiv.querySelector(".progress-wrapper");
  if (!progressWrapper) return;

  const percent = Math.round((current / total) * 100);
  const progressBar = progressWrapper.querySelector(".progress-bar");
  const progressPercent = progressWrapper.querySelector(".progress-percent");
  const progressLabel = progressWrapper.querySelector(".progress-label");

  progressBar.style.width = `${percent}%`;
  progressBar.setAttribute("aria-valuenow", percent);
  progressPercent.textContent = `${percent}%`;
  progressLabel.textContent = `Processing ${current}/${total}...`;

  // Change color based on progress
  if (percent === 100) {
    progressBar.classList.remove("bg-primary");
    progressBar.classList.add("bg-success");
    progressBar.classList.remove("progress-bar-animated");
    progressLabel.textContent = "Complete!";
  }
}

function removeProgressBar(entryDiv, delay = 2000) {
  setTimeout(() => {
    const progressWrapper = entryDiv.querySelector(".progress-wrapper");
    if (progressWrapper) {
      progressWrapper.classList.add("fade");
      setTimeout(() => progressWrapper.remove(), 150);
    }
  }, delay);
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
    startBtn.classList.remove("d-none");
    stopBtn.classList.add("d-none");
    return;
  }

  entryDiv.dataset.used = "true";
  await saveEntriesToStorage();

  // Create and show progress bar
  createProgressBar(entryDiv);

  for (let i = 0; i < subEntries.length; i++) {
    if (stopTranslation) {
      console.log("⏹ Translation stopped");
      break;
    }

    const text = subEntries[i].textContent.trim();
    if (!text) {
      updateProgressBar(entryDiv, i + 1, subEntries.length);
      continue;
    }

    console.log(`🌍 Translating entry ${i + 1}/${subEntries.length}`);

    // Update progress bar
    updateProgressBar(entryDiv, i + 1, subEntries.length);

    // Send text and wait for DeepL UI
    await sendWithRetry(text);
    await wait(1500);
  }

  console.log("✅ Group translation finished");
  
  // Final progress update
  if (!stopTranslation) {
    updateProgressBar(entryDiv, subEntries.length, subEntries.length);
  }
  
  removeProgressBar(entryDiv);
  
  startBtn.classList.remove("d-none");
  stopBtn.classList.add("d-none");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let entryId = 0;
let entryCounter = 0;
let stopTranslation = false;

// Sortable instances storage
let entriesSortable = null;
let subEntrySortables = new Map();

// -----------------------------
// Sortable.js Initialization
// -----------------------------
function initEntriesSortable() {
  const container = document.getElementById("entriesContainer");
  if (!container) return;

  // Destroy existing instance if any
  if (entriesSortable) {
    entriesSortable.destroy();
  }

  entriesSortable = new Sortable(container, {
    animation: 150,
    easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    handle: ".entry-header",
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    filter: ".sub-container, .btn, input, textarea",
    preventOnFilter: false,
    onEnd: function (evt) {
      updateEntryNumbers();
      saveEntriesToStorage();
      console.log("📦 Entries reordered");
    },
  });
}

function initSubEntrySortable(entryDiv) {
  const subContainer = entryDiv.querySelector(".sub-container");
  if (!subContainer) return;

  const entryId = entryDiv.id;

  // Destroy existing instance if any
  if (subEntrySortables.has(entryId)) {
    subEntrySortables.get(entryId).destroy();
  }

  const sortable = new Sortable(subContainer, {
    animation: 150,
    easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    handle: ".sub-entry",
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    filter: ".sub-input-wrapper, .toggle-sub-input, .btn, input, textarea",
    preventOnFilter: false,
    draggable: ".sub-entry",
    onEnd: function (evt) {
      updateSubEntryNumbers(entryDiv);
      saveEntriesToStorage();
      console.log("📦 Sub-entries reordered");
    },
  });

  subEntrySortables.set(entryId, sortable);
}

function updateSubEntryNumbers(entryDiv) {
  const entryNumber = entryDiv.dataset.entryNumber;
  const subEntries = entryDiv.querySelectorAll(".sub-entry");
  subEntries.forEach((sub, index) => {
    const numberSpan = sub.querySelector(".sub-entry-number");
    if (numberSpan) {
      numberSpan.textContent = `${entryNumber}.${index + 1}`;
    }
  });
}

// -----------------------------
// Storage Helpers
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
  
  // Initialize sortable after loading
  initEntriesSortable();
}

// -----------------------------
// Render Function
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
  header.style.cursor = "grab";
  header.innerHTML = `
    <span>
      <span class="entry-number fw-bold">${entryCounter}.</span>
      <div class="sub-entry-text">${entryData.name}</div>
    </span>
    <span class="actions">
      <button class="btn btn-outline-primary btn-sm details-entry">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-info-circle me-1" viewBox="0 0 16 16">
          <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
          <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>
        </svg>
        Details
      </button>
      <button class="btn btn-outline-secondary btn-sm edit-entry">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-pencil-square me-1" viewBox="0 0 16 16">
          <path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/>
          <path fill-rule="evenodd" d="M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5z"/>
        </svg>
        Edit
      </button>
      <button class="btn btn-outline-danger btn-sm delete-entry">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-trash3 me-1" viewBox="0 0 16 16">
          <path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5M11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1zm1.958 1-.846 10.58a1 1 0 0 1-1.002.92H4.885a1 1 0 0 1-1.002-.92L3.042 3.5zm-7.487 1a.5.5 0 0 1 .528.47l.5 8.5a.5.5 0 0 1-.998.06L5 5.03a.5.5 0 0 1 .47-.53Zm5.058 0a.5.5 0 0 1 .47.53l-.5 8.5a.5.5 0 1 1-.998-.06l.5-8.5a.5.5 0 0 1 .528-.47M8 4.5a.5.5 0 0 1 .5.5v8.5a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5"/>
        </svg>
        Delete
      </button>
      <button class="btn btn-success btn-sm start-group">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-play-fill me-1" viewBox="0 0 16 16">
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

  // Add toggle button and input wrapper first
  const addSubToggle = document.createElement("button");
  addSubToggle.className = "btn btn-outline-primary btn-sm mb-2 toggle-sub-input";
  addSubToggle.innerHTML = `➕ Add Subentry`;

  const subInputGroup = document.createElement("div");
  subInputGroup.className = "sub-input-wrapper mb-3 d-none";
  subInputGroup.innerHTML = `
    <div class="d-flex gap-2 mb-2">
      <textarea 
        class="form-control sub-input flex-grow-1" 
        placeholder="New subentry... (Paste multiple lines to create multiple entries)"
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

  subContainer.appendChild(addSubToggle);
  subContainer.appendChild(subInputGroup);

  // Render existing sub-entries
  if (entryData.subEntries) {
    entryData.subEntries.forEach((sub, i) => {
      const subDiv = createSubEntryElement(entryCounter, i + 1, sub.text, sub.date);
      subContainer.appendChild(subDiv);
      updateTextToggle(subDiv);
    });
  }

  // Toggle button event
  addSubToggle.addEventListener("click", () => {
    const isHidden = subInputGroup.classList.contains("d-none");
    if (isHidden) {
      subInputGroup.classList.remove("d-none");
      subInputGroup.classList.add("show");
      addSubToggle.innerHTML = "❌ Close";
      // Auto-focus the textarea
      const textarea = subInputGroup.querySelector(".sub-input");
      setTimeout(() => textarea.focus(), 100);
    } else {
      subInputGroup.classList.add("d-none");
      subInputGroup.classList.remove("show");
      addSubToggle.innerHTML = "➕ Add Subentry";
    }
  });

  // Setup input group events
  const textarea = subInputGroup.querySelector(".sub-input");

  // Smart Enter Behavior
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const addBtn = subInputGroup.querySelector(".addSubEntry");
      addBtn.click();
    }
    // Shift+Enter allows normal line break (default behavior)
  });

  // Multi-Paste Detection
  textarea.addEventListener("paste", (e) => {
    // Let the paste happen first
    setTimeout(() => {
      handleMultiPaste(entryDiv, textarea);
    }, 0);
  });

  // Add Button
  subInputGroup.querySelector(".addSubEntry").addEventListener("click", () => {
    addSubEntryFromInput(entryDiv, textarea);
  });

  // Copy Button
  subInputGroup.querySelector(".copySubEntry").addEventListener("click", () => {
    navigator.clipboard.writeText(textarea.value);
    showToast("Copied to clipboard!");
  });

  // Paste Button
  subInputGroup.querySelector(".pasteSubEntry").addEventListener("click", async () => {
    const clipText = await navigator.clipboard.readText();
    textarea.value = clipText;
    textarea.focus();
    // Check for multi-line paste
    handleMultiPaste(entryDiv, textarea);
  });

  // Clear Button
  subInputGroup.querySelector(".clearSubEntry").addEventListener("click", () => {
    textarea.value = "";
    textarea.focus();
  });

  container.prepend(entryDiv);

  // Initialize Bootstrap collapse
  const collapse = new bootstrap.Collapse(subContainer, {
    toggle: false,
  });

  // Details button event
  header.querySelector(".details-entry").addEventListener("click", (e) => {
    const isExpanded = subContainer.classList.contains("show");
    collapse.toggle();

    const btn = e.currentTarget;

    if (isExpanded) {
      btn.classList.replace("btn-outline-danger", "btn-outline-primary");
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-info-circle me-1" viewBox="0 0 16 16">
          <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
          <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>
        </svg> Details`;
    } else {
      btn.classList.replace("btn-outline-primary", "btn-outline-danger");
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-x-circle me-1" viewBox="0 0 16 16">
          <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
          <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"/>
        </svg> Close`;
      
      // Auto-focus when opening
      setTimeout(() => {
        const input = subInputGroup.querySelector(".sub-input");
        if (!subInputGroup.classList.contains("d-none")) {
          input.focus();
        }
      }, 350);
    }
  });

  // Initialize sortable for sub-entries
  initSubEntrySortable(entryDiv);
}

// -----------------------------
// Sub-Entry Element Creator
// -----------------------------
function createSubEntryElement(entryNumber, subNumber, text, date) {
  const subDiv = document.createElement("div");
  subDiv.className = "sub-entry";
  subDiv.dataset.date = date || new Date().toISOString();
  subDiv.style.cursor = "grab";
  subDiv.innerHTML = `
    <span class="sub-entry-number fw-bold">${entryNumber}.${subNumber}</span>
    <div class="sub-entry-text">${text}</div>
    <span class="toggle-text">Show more</span>
    <span class="actions">
      <button class="btn btn-outline-secondary btn-sm edit-sub">✏️ Edit</button>
      <button class="btn btn-outline-danger btn-sm delete-sub">🗑️ Delete</button>
    </span>
  `;
  return subDiv;
}

// -----------------------------
// Multi-Paste Handler
// -----------------------------
function handleMultiPaste(entryDiv, textarea) {
  const text = textarea.value.trim();
  if (!text) return;

  const lines = text.split(/\r?\n/).filter(line => line.trim());
  
  // Only trigger multi-paste if there are multiple non-empty lines
  if (lines.length > 1) {
    // Show confirmation for multi-paste
    const confirmMulti = confirm(
      `Detected ${lines.length} lines. Create ${lines.length} separate subentries?\n\nClick "OK" to create multiple entries, or "Cancel" to keep as single entry.`
    );

    if (confirmMulti) {
      const subContainer = entryDiv.querySelector(".sub-container");
      const entryNumber = entryDiv.dataset.entryNumber;
      let subEntryCounter = parseInt(subContainer.dataset.subEntryCounter) || 0;

      lines.forEach((line, index) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        subEntryCounter++;
        const subDiv = createSubEntryElement(entryNumber, subEntryCounter, trimmedLine, new Date().toISOString());
        
        // Add animation classes using Bootstrap
        subDiv.style.opacity = "0";
        subDiv.style.transform = "translateY(-10px)";
        subDiv.style.transition = "opacity 0.3s ease, transform 0.3s ease";
        
        subContainer.appendChild(subDiv);
        updateTextToggle(subDiv);

        // Trigger animation with staggered delay
        setTimeout(() => {
          subDiv.style.opacity = "1";
          subDiv.style.transform = "translateY(0)";
        }, index * 50);
      });

      subContainer.dataset.subEntryCounter = subEntryCounter;
      textarea.value = "";
      
      // Re-initialize sortable
      initSubEntrySortable(entryDiv);
      saveEntriesToStorage();
      
      showToast(`Created ${lines.length} subentries!`);
    }
  }
}

// -----------------------------
// Add Sub-Entry from Input
// -----------------------------
function addSubEntryFromInput(entryDiv, textarea) {
  const text = textarea.value.trim();
  if (!text) return;

  // Check for multi-line content
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  
  if (lines.length > 1) {
    handleMultiPaste(entryDiv, textarea);
    return;
  }

  const subContainer = entryDiv.querySelector(".sub-container");
  const entryNumber = entryDiv.dataset.entryNumber;
  let subEntryCounter = parseInt(subContainer.dataset.subEntryCounter) + 1;
  subContainer.dataset.subEntryCounter = subEntryCounter;

  const subDiv = createSubEntryElement(entryNumber, subEntryCounter, text, new Date().toISOString());
  
  // Bootstrap-based animation
  subDiv.style.opacity = "0";
  subDiv.style.transform = "translateY(-10px)";
  subDiv.style.transition = "opacity 0.3s ease, transform 0.3s ease";
  
  subContainer.appendChild(subDiv);
  textarea.value = "";

  // Trigger animation
  requestAnimationFrame(() => {
    subDiv.style.opacity = "1";
    subDiv.style.transform = "translateY(0)";
  });

  updateTextToggle(subDiv);
  
  // Re-initialize sortable
  initSubEntrySortable(entryDiv);
  saveEntriesToStorage();

  // Keep input visible and focused for quick entry
  textarea.focus();

  // Ensure sub-container is visible
  const collapse = new bootstrap.Collapse(subContainer, { toggle: false });
  if (!subContainer.classList.contains("show")) {
    collapse.show();
    const detailsBtn = entryDiv.querySelector(".details-entry");
    detailsBtn.classList.replace("btn-outline-primary", "btn-outline-danger");
    detailsBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-x-circle me-1" viewBox="0 0 16 16">
        <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
        <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708"/>
      </svg> Close`;
  }
}

// -----------------------------
// Toast Notification
// -----------------------------
function showToast(message) {
  // Remove existing toast
  const existingToast = document.querySelector(".custom-toast");
  if (existingToast) existingToast.remove();

  const toast = document.createElement("div");
  toast.className = "custom-toast alert alert-success position-fixed";
  toast.style.cssText = `
    bottom: 20px;
    right: 20px;
    z-index: 9999;
    opacity: 0;
    transition: opacity 0.3s ease;
    max-width: 300px;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = "1";
  });

  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 2000);
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

  // Remove empty state alert
  const alert = container.querySelector(".alert");
  if (alert) alert.remove();

  renderEntry(newEntry, container);
  updateEntryNumbers();
  input.value = "";

  // Re-initialize main sortable
  initEntriesSortable();
  saveEntriesToStorage();

  // Auto-expand and focus the new entry
  const newEntryDiv = container.querySelector(".loop-entry");
  if (newEntryDiv) {
    const detailsBtn = newEntryDiv.querySelector(".details-entry");
    setTimeout(() => {
      detailsBtn.click();
      // Open the subentry input
      setTimeout(() => {
        const toggleBtn = newEntryDiv.querySelector(".toggle-sub-input");
        if (toggleBtn) toggleBtn.click();
      }, 350);
    }, 100);
  }
});

// Enter key creates new entry
document.getElementById("mainEntryInput").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("addLoop").click();
  }
});

// Auto-focus main input when switching to Loop tab
document.getElementById("loop-tab").addEventListener("shown.bs.tab", function () {
  document.getElementById("mainEntryInput").focus();
});

// Delegated event handling
document.getElementById("entriesContainer").addEventListener("click", function (e) {
  const target = e.target;
  
  if (target.classList.contains("toggle-text")) {
    toggleText(target);
  } else if (target.classList.contains("edit-entry") || target.closest(".edit-entry")) {
    startEditText(target.closest(".edit-entry") || target, "entry");
  } else if (target.classList.contains("delete-entry") || target.closest(".delete-entry")) {
    deleteEntry(target.closest(".delete-entry") || target, "entry");
  } else if (target.classList.contains("edit-sub")) {
    startEditText(target, "sub");
  } else if (target.classList.contains("delete-sub")) {
    deleteEntry(target, "sub");
  } else if (target.classList.contains("save-edit")) {
    saveEditText(target);
  } else if (target.classList.contains("start-group") || target.closest(".start-group")) {
    const entryDiv = (target.closest(".start-group") || target).closest(".loop-entry");
    startGroupTranslation(entryDiv);
  } else if (target.classList.contains("stop-group") || target.closest(".stop-group")) {
    stopTranslation = true;
  }
});

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
  textarea.select();

  // Smart enter for edit mode
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const saveBtn = parent.querySelector(".save-edit");
      if (saveBtn) saveBtn.click();
    }
    if (e.key === "Escape") {
      // Cancel edit
      const textDiv = document.createElement("div");
      textDiv.className = "sub-entry-text";
      textDiv.textContent = currentText;
      textarea.replaceWith(textDiv);
      btn.textContent = "✏️ Edit";
      btn.classList.remove("save-edit");
      btn.classList.add(type === "entry" ? "edit-entry" : "edit-sub");
    }
  });

  btn.textContent = "💾 Save";
  btn.classList.remove("edit-entry", "edit-sub");
  btn.classList.add("save-edit");
}

function saveEditText(btn) {
  const parent = btn.closest(".loop-entry") || btn.closest(".sub-entry");
  const textarea = parent.querySelector("textarea");
  const type = btn.closest(".entry-header") ? "entry" : "sub";
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
  const parent = type === "entry" ? btn.closest(".loop-entry") : btn.closest(".sub-entry");
  
  // Animate removal
  parent.style.transition = "opacity 0.3s ease, transform 0.3s ease";
  parent.style.opacity = "0";
  parent.style.transform = "translateX(20px)";
  
  setTimeout(() => {
    parent.remove();
    if (type === "entry") {
      updateEntryNumbers();
      // Clean up sortable instance
      const entryId = parent.id;
      if (subEntrySortables.has(entryId)) {
        subEntrySortables.get(entryId).destroy();
        subEntrySortables.delete(entryId);
      }
    }
    saveEntriesToStorage();
  }, 300);
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
    updateSubEntryNumbers(entry);
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
// Initialize on Load
// -----------------------------
document.addEventListener("DOMContentLoaded", () => {
  loadEntriesFromStorage();
  
  // Add custom styles for sortable
  const style = document.createElement("style");
  style.textContent = `
    .sortable-ghost {
      opacity: 0.4;
      background-color: #e3f2fd !important;
    }
    .sortable-chosen {
      background-color: #bbdefb !important;
    }
    .sortable-drag {
      background-color: #fff !important;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    .entry-header:active {
      cursor: grabbing;
    }
    .sub-entry:active {
      cursor: grabbing;
    }
    .progress-wrapper {
      transition: opacity 0.3s ease;
    }
    .progress-wrapper.fade {
      opacity: 0;
    }
  `;
  document.head.appendChild(style);
});