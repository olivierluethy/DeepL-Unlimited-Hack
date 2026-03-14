// ============================================
// DeepL Pro Unlimited - Content Script (FIXED)
// Two-way communication with completion signals
// ============================================

window.addEventListener("message", async (event) => {
  if (
    event.source !== window ||
    !event.data ||
    event.data.type !== "DEEPL_TRANSLATE"
  )
    return;

  const fullText = event.data.payload;
  const requestId = event.data.requestId; // Unique ID for this request
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
    // Clear the input field completely before starting new translation
    await clearInputField();
    
    // Small delay to ensure DeepL resets its state
    await delay(300);
    
    // Insert text and wait for the COMPLETE translation
    const translated = await insertAndTranslateWithVerification(chunks[i], i);
    results.push(translated);
    
    // Additional delay between chunks to prevent overlap
    if (i < chunks.length - 1) {
      await delay(500);
    }
  }

  const finalText = results.join("\n\n");

  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const eintrag = {
    id,
    timestamp,
    original: fullText,
    translated: finalText,
  };

  // Save to history
  chrome.storage.local.get({ verlauf: [] }, (result) => {
    const verlauf = result.verlauf;
    verlauf.push(eintrag);

    chrome.storage.local.set({ verlauf }, () => {
      console.log("History entry saved:", eintrag);
      
      // ✅ CRITICAL: Signal completion back to the popup/loop.js
      chrome.runtime.sendMessage({
        type: "DEEPL_TRANSLATION_COMPLETE",
        requestId: requestId,
        success: true,
        originalLength: fullText.length,
        translatedLength: finalText.length
      });
      
      showMessagePopup("✅ Done! Entry saved. Viewable in history.");
    });
  });

  function showMessagePopup(message) {
    const popup = document.createElement("div");
    popup.innerText = message;
    Object.assign(popup.style, {
      position: "fixed",
      top: "-100px",
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
      transition: "all 0.6s ease",
    });

    document.body.appendChild(popup);

    requestAnimationFrame(() => {
      popup.style.top = "40px";
      popup.style.opacity = "1";
    });

    setTimeout(() => {
      popup.style.top = "-100px";
      popup.style.opacity = "0";
      setTimeout(() => popup.remove(), 600);
    }, 3000);
  }
});

// Helper function for delays
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// New function to completely clear the input field
async function clearInputField() {
  const sourceInput = document.querySelector(
    "[data-testid='translator-source-input'] [role='textbox']"
  );
  
  if (sourceInput) {
    sourceInput.focus();
    // Select all and delete
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    sourceInput.dispatchEvent(new Event("input", { bubbles: true }));
    
    // Wait for the target field to clear as well
    await waitForTargetToClear();
  }
}

// Wait until the target output field is empty
function waitForTargetToClear() {
  return new Promise((resolve) => {
    const targetInput = document.querySelector(
      "[data-testid='translator-target-input'] [role='textbox']"
    );
    
    let attempts = 0;
    const maxAttempts = 20; // 10 seconds max
    
    const checkInterval = setInterval(() => {
      const currentText = targetInput ? targetInput.innerText.trim() : "";
      attempts++;
      
      if (currentText === "" || attempts >= maxAttempts) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 500);
  });
}

// Main translation function with verification
async function insertAndTranslateWithVerification(text, chunkIndex) {
  const sourceInput = document.querySelector(
    "[data-testid='translator-source-input'] [role='textbox']"
  );
  const targetInput = document.querySelector(
    "[data-testid='translator-target-input'] [role='textbox']"
  );

  if (!sourceInput || !targetInput) {
    console.error("Could not find DeepL input/output fields");
    return "";
  }

  // Store the input text length for validation
  const inputLength = text.length;
  const inputWordCount = text.split(/\s+/).length;
  
  // Insert the text
  sourceInput.focus();
  sourceInput.innerText = "";
  document.execCommand('insertText', false, text);
  sourceInput.dispatchEvent(new Event("input", { bubbles: true }));

  console.log(`[Chunk ${chunkIndex}] Inserted text (${inputLength} chars, ${inputWordCount} words)`);

  // Wait for translation with stability check
  const result = await waitForStableTranslation(inputLength, inputWordCount, chunkIndex);
  
  console.log(`[Chunk ${chunkIndex}] Got translation (${result.length} chars)`);
  
  return result;
}

// Wait for translation to be complete AND stable (not changing anymore)
function waitForStableTranslation(inputLength, inputWordCount, chunkIndex) {
  return new Promise((resolve) => {
    const targetInput = document.querySelector(
      "[data-testid='translator-target-input'] [role='textbox']"
    );
    
    let lastText = "";
    let stableCount = 0;
    let attempts = 0;
    const maxAttempts = 60; // 30 seconds max (60 * 500ms)
    const requiredStableChecks = 3; // Text must be unchanged for 3 consecutive checks
    
    const checkInterval = setInterval(() => {
      const currentText = targetInput ? targetInput.innerText.trim() : "";
      attempts++;
      
      // Check if text has stabilized (same as last check)
      if (currentText === lastText && currentText.length > 0) {
        stableCount++;
      } else {
        stableCount = 0; // Reset if text changed
      }
      
      lastText = currentText;
      
      // Log progress for debugging
      if (attempts % 4 === 0) {
        console.log(`[Chunk ${chunkIndex}] Waiting... (${currentText.length} chars, stable: ${stableCount}/${requiredStableChecks})`);
      }
      
      // Success conditions:
      // 1. Text is not empty
      // 2. Text has been stable for required number of checks
      // 3. Text length is reasonable compared to input (basic sanity check)
      const isStable = stableCount >= requiredStableChecks;
      const isNotEmpty = currentText.length > 0;
      const isReasonableLength = currentText.length >= Math.min(inputLength * 0.3, 10);
      
      if (isNotEmpty && isStable && isReasonableLength) {
        clearInterval(checkInterval);
        // Additional small buffer to ensure DeepL is fully done
        setTimeout(() => {
          // Read the text ONE MORE TIME to get the absolute final version
          const finalText = targetInput ? targetInput.innerText.trim() : "";
          resolve(finalText);
        }, 500);
        return;
      }
      
      // Timeout fallback
      if (attempts >= maxAttempts) {
        clearInterval(checkInterval);
        console.warn(`[Chunk ${chunkIndex}] Timeout reached, using current text`);
        resolve(currentText);
      }
    }, 500);
  });
}

function downloadResult(content) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  const txtBlob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const txtUrl = URL.createObjectURL(txtBlob);
  const txtLink = document.createElement("a");
  txtLink.href = txtUrl;
  txtLink.download = `DeepL_Übersetzung_${timestamp}.txt`;
  txtLink.click();
}