window.addEventListener("message", async (event) => {
  if (
    event.source !== window ||
    !event.data ||
    event.data.type !== "DEEPL_TRANSLATE"
  )
    return;

  const fullText = event.data.payload;

  const path = window.location.pathname;

  let maxLength = "";

  const writeRegex = /^\/[^\/]+\/write/;
  const translateRegex = /^\/[^\/]+\/(translate|translator)/;

  if (writeRegex.test(path)) {
    maxLength = 2000;
  }

  if (translateRegex.test(path)) {
    maxLength = 1500;
  }

  const chunks = splitText(fullText, maxLength);
  const results = [];

    for (let i = 0; i < chunks.length; i++) {
    await insertAndTranslate(chunks[i]); // Wartet intern bereits, bis Text da ist
    const translated = getTranslatedText(); // Liest den Text einfach nur aus
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
      console.log("History entry saved:", eintrag);
      showMessagePopup("✅ Done! Entry saved. Viewable in history.");
    });
  });
  // kleine Popup-Funktion
  function showMessagePopup(message) {
    const popup = document.createElement("div");
    popup.innerText = message;
    Object.assign(popup.style, {
      position: "fixed",
      top: "-100px", // Startposition über dem Bildschirm
      left: "50%",
      transform: "translateX(-50%)",
      background: "#28a745",
      color: "white",
      padding: "20px 30px",
      borderRadius: "10px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      zIndex: 9999,
      fontSize: "18px",
      fontWeight: "bold",
      fontFamily: "sans-serif",
      opacity: "0",
      transition: "all 0.6s ease", // smoothes Reinfahren
    });

    document.body.appendChild(popup);

    // kurz warten, dann animiert reinschieben
    requestAnimationFrame(() => {
      popup.style.top = "40px"; // Zielposition
      popup.style.opacity = "1";
    });

    // nach 3 Sekunden wieder rausfahren
    setTimeout(() => {
      popup.style.top = "-100px"; // wieder hochfahren
      popup.style.opacity = "0";
      setTimeout(() => popup.remove(), 600); // warten bis Transition fertig
    }, 3000);
  }
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
  const sourceInput = document.querySelector("[data-testid='translator-source-input'] [role='textbox']");
  const targetInput = document.querySelector("[data-testid='translator-target-input'] [role='textbox']");
  
  if (targetInput) targetInput.textContent = ""; 
  
  if (sourceInput) {
    sourceInput.focus(); // Fokus setzen verbessert die Erkennung
    sourceInput.textContent = "";
    sourceInput.textContent = text;
    sourceInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }

  await waitForTranslation();
}

function waitForTranslation() {
  return new Promise((resolve) => {
    const targetInput = document.querySelector("[data-testid='translator-target-input'] [role='textbox']");
    
    if (!targetInput) {
      // Falls das Element noch nicht da ist, kurz warten und erneut versuchen
      setTimeout(() => resolve(waitForTranslation()), 500);
      return;
    }

    const observer = new MutationObserver(() => {
      const currentText = targetInput.textContent.trim();
      if (currentText.length > 0) {
        setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 1000); // 1 Sekunde Puffer für "Text-Streaming"
      }
    });

    observer.observe(targetInput, {
      childList: true,
      characterData: true,
      subtree: true
    });

    setTimeout(() => {
      observer.disconnect();
      resolve();
    }, 30000);
  });
}

function getTranslatedText() {
  const targetInput = document.querySelector("[data-testid='translator-target-input'] [role='textbox']");
  return targetInput ? targetInput.textContent.trim() : "";
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
