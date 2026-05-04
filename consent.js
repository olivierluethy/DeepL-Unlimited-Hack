// ============================================
// consent.js — first-run opt-in handler for consent.html
// ============================================

document.addEventListener("DOMContentLoaded", () => {
  // TODO: replace before publishing — this is the privacy policy URL
  // shown on the consent page and the options page. If left as a
  // placeholder the link still renders, just nowhere useful.
  const PRIVACY_POLICY_URL =
    "https://github.com/BaskLash/LongDL/blob/main/privacy-policy";

  const privacyLink = document.getElementById("privacyLink");
  if (privacyLink) privacyLink.href = PRIVACY_POLICY_URL;

  const acceptBtn = document.getElementById("acceptBtn");
  const declineBtn = document.getElementById("declineBtn");
  const confirm = document.getElementById("confirm");

  function finish(messageHtml) {
    acceptBtn.disabled = true;
    declineBtn.disabled = true;
    confirm.innerHTML = messageHtml;
    confirm.classList.remove("d-none");
    setTimeout(() => window.close(), 2500);
  }

  acceptBtn.addEventListener("click", async () => {
    await window.setConsent("granted");
    finish(
      '<i class="bi bi-check-circle-fill me-1"></i>Thanks! Anonymous usage data sharing is on. You can switch it off anytime from Settings.',
    );
  });

  declineBtn.addEventListener("click", async () => {
    await window.setConsent("denied");
    finish(
      '<i class="bi bi-info-circle-fill me-1"></i>Got it — no usage data will leave your device.',
    );
  });
});
