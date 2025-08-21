window.addEventListener("message", async (event) => {
  if (
    event.source !== window ||
    !event.data ||
    event.data.type !== "DEEPL_TRANSLATE"
  )
    return;

  const fullText = event.data.payload;

  const maxCounter = document.querySelector(
    "[data-testid='write-character-counter']"
  );
  const maxLength = parseInt(maxCounter?.children[2]?.innerHTML || "2000");

  const chunks = splitText(fullText, maxLength);
  const results = [];

  for (let i = 0; i < chunks.length; i++) {
    await insertAndTranslate(chunks[i]);
    const translated = await getTranslatedText();
    results.push(translated);
  }

  const finalText = results.join("\n\n");

  const id = crypto.randomUUID(); // erzeugt eine eindeutige ID
  const timestamp = new Date().toISOString(); // aktuelles Datum/Zeit im ISO-Format

  const eintrag = {
    id,
    timestamp,
    original: fullText,
    translated: finalText,
  };

  chrome.storage.local.get({ verlauf: [] }, (result) => {
    const verlauf = result.verlauf;
    verlauf.push(eintrag);

    chrome.storage.local.set({ verlauf }, () => {
      console.log("Verlaufseintrag gespeichert:", eintrag);
    });
  });
});

function splitText(text, maxLength) {
  const parts = [];
  let current = "";

  for (let word of text.split(" ")) {
    if ((current + " " + word).length > maxLength) {
      parts.push(current);
      current = word;
    } else {
      current += (current ? " " : "") + word;
    }
  }

  if (current) parts.push(current);
  return parts;
}

async function insertAndTranslate(text) {
  const sourceInput = document.querySelector(
    "[data-testid='translator-source-input'] [role='textbox']"
  );
  sourceInput.innerText = "";

  const event = new InputEvent("input", { bubbles: true });
  sourceInput.textContent = text;
  sourceInput.dispatchEvent(event);

  await new Promise((r) => setTimeout(r, 2500));
}

async function getTranslatedText() {
  const targetInput = document.querySelector(
    "[data-testid='translator-target-input'] [role='textbox']"
  );
  return targetInput?.textContent || "";
}

function downloadResult(content) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  // TXT
  const txtBlob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const txtUrl = URL.createObjectURL(txtBlob);
  const txtLink = document.createElement("a");
  txtLink.href = txtUrl;
  txtLink.download = `DeepL_Übersetzung_${timestamp}.txt`;
  txtLink.click();

  // PDF oder Word (optional, mit jsPDF oder docx)
}
