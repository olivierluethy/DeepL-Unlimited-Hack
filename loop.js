let entryId = 0;
let entryCounter = 0;

document.getElementById("addLoop").addEventListener("click", function () {
  addMainEntry();
});

function addMainEntry() {
  const input = document.getElementById("mainEntryInput");
  const value = input.value.trim();
  if (!value) return;

  entryId++;
  entryCounter++;
  const container = document.getElementById("entriesContainer");

  const entryDiv = document.createElement("div");
  entryDiv.className = "entry";
  entryDiv.id = `entry-${entryId}`;
  entryDiv.dataset.entryNumber = entryCounter;

  // Header mit Nummer und Titel
  const header = document.createElement("div");
  header.className = "entry-header";
  header.innerHTML = `
    <span>
      <span class="entry-number">${entryCounter}.</span>
      <h3>${value}</h3>
    </span>
    <span class="actions">
      <button class="btn-secondary btn-small" onclick="editText(this, 'entry')">✏️ Bearbeiten</button>
      <button class="btn-danger btn-small" onclick="deleteEntry(this, 'entry')">🗑️ Löschen</button>
    </span>
  `;
  entryDiv.appendChild(header);

  // Container für Untereinträge
  const subContainer = document.createElement("div");
  subContainer.className = "sub-container";
  subContainer.dataset.subEntryCounter = 0;
  entryDiv.appendChild(subContainer);

  // Eingabe für Untereintrag
  const subInputGroup = document.createElement("div");
  subInputGroup.className = "input-group";
  subInputGroup.innerHTML = `
    <textarea class="sub-input" placeholder="Neuer Untereintrag..."></textarea>
    <button class="btn-primary btn-small addSubEntry">➕ Hinzufügen</button>
  `;
  entryDiv.appendChild(subInputGroup);

  container.appendChild(entryDiv);
  input.value = "";
  updateEntryNumbers();
}

// ✅ Event delegation: listen on container instead of each button
document.getElementById("entriesContainer").addEventListener("click", function (e) {
  if (e.target.classList.contains("addSubEntry")) {
    addSubEntry(e.target);
  }
});

function addSubEntry(btn) {
  const entryDiv = btn.closest(".entry");
  const subContainer = entryDiv.querySelector(".sub-container");
  const subInput = entryDiv.querySelector(".sub-input");
  const text = subInput.value.trim();
  if (!text) return;

  const subEntryCounter = parseInt(subContainer.dataset.subEntryCounter) + 1;
  subContainer.dataset.subEntryCounter = subEntryCounter;

  const subDiv = document.createElement("div");
  subDiv.className = "sub-entry";
  subDiv.innerHTML = `
    <span class="sub-entry-number">${entryDiv.dataset.entryNumber}.${subEntryCounter}</span>
    <span>${text}</span>
    <span class="actions">
      <button class="btn-secondary btn-small" onclick="editText(this, 'sub')">✏️ Bearbeiten</button>
      <button class="btn-danger btn-small" onclick="deleteEntry(this, 'sub')">🗑️ Löschen</button>
    </span>
  `;
  subContainer.appendChild(subDiv);
  subInput.value = "";
}
