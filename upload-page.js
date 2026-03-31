// ============================================
// upload-page.js  –  Drop-zone interactivity
// Extracted from inline script to satisfy MV3
// Content Security Policy (script-src 'self').
// ============================================

document.addEventListener("DOMContentLoaded", () => {
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileUpload");

  if (!dropZone || !fileInput) return;

  // Clicking anywhere on the drop-zone opens the OS file picker
  dropZone.addEventListener("click", (e) => {
    // Avoid double-triggering if the click landed on the input itself
    if (e.target !== fileInput) fileInput.click();
  });

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");

    if (e.dataTransfer.files.length) {
      // Assign the dropped file to the input so upload.js's change handler fires
      const dt = new DataTransfer();
      dt.items.add(e.dataTransfer.files[0]);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
});
