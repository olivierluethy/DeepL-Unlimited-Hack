// ============================================
// options.js — settings page (analytics consent toggle)
// ============================================

document.addEventListener("DOMContentLoaded", async () => {
  // TODO: replace before publishing — keep in sync with consent.js.
  const PRIVACY_POLICY_URL =
    "https://github.com/BaskLash/LongDL/blob/main/privacy-policy";

  const privacyLink = document.getElementById("privacyLink");
  if (privacyLink) privacyLink.href = PRIVACY_POLICY_URL;

  const toggle = document.getElementById("analyticsToggle");
  const label = document.getElementById("analyticsToggleLabel");
  const status = document.getElementById("status");

  function render(consent) {
    const granted = consent === "granted";
    toggle.checked = granted;
    label.textContent = granted
      ? "On — sharing anonymous usage data"
      : "Off — no usage data leaves this device";
  }

  const current = await window.getConsent();
  render(current);

  toggle.addEventListener("change", async () => {
    const next = toggle.checked ? "granted" : "denied";
    await window.setConsent(next);
    render(next);
    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 1500);
  });
});
