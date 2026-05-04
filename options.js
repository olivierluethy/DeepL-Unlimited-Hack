// ============================================
// options.js — settings page (disclosure + distinct ID)
// ============================================

document.addEventListener("DOMContentLoaded", async () => {
  // TODO: replace before publishing.
  const PRIVACY_POLICY_URL =
    "https://github.com/BaskLash/LongDL/blob/main/privacy-policy";

  const privacyLink = document.getElementById("privacyLink");
  if (privacyLink) privacyLink.href = PRIVACY_POLICY_URL;

  const idEl = document.getElementById("distinctId");
  const copyBtn = document.getElementById("copyIdBtn");
  const status = document.getElementById("status");

  const id = await window.getDistinctId();
  idEl.textContent = id || "(not yet generated)";

  copyBtn.addEventListener("click", async () => {
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
      copyBtn.classList.replace("btn-outline-secondary", "btn-success");
      status.textContent = "Anonymous ID copied to clipboard.";
      setTimeout(() => {
        copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
        copyBtn.classList.replace("btn-success", "btn-outline-secondary");
        status.textContent = "";
      }, 1500);
    } catch (_err) {
      status.textContent = "Couldn't copy automatically — select the ID manually.";
    }
  });
});
