document.getElementById("sendBtn").addEventListener("click", async () => {
  const inputText = document.getElementById("inputText").value;
  if (!inputText.trim()) return alert("Bitte Text eingeben.");

  document.getElementById("status").innerText = "Sende an DeepL...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    function: sendTextToContent,
    args: [inputText]
  });
});

function sendTextToContent(text) {
  window.postMessage({ type: "DEEPL_TRANSLATE", payload: text }, "*");
}
