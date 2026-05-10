// ============================================
// DeepL Pro Unlimited - Content Script (FIXED)
// Two-way communication with completion signals
// ============================================

// Module-scope toast helper. Used by the DEEPL_TRANSLATE handler when a
// translation is NOT silent, and by DEEPL_DOC_TOAST for the single
// end-of-document notification fired by background.js.
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

// One-shot toast trigger used by background.js to emit a single
// "Done entry saved..." popup at the very end of a Documents-tab
// translation, after all internal batches have completed.
window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    !event.data ||
    event.data.type !== "DEEPL_DOC_TOAST"
  )
    return;
  const message = event.data.message || "✅ Done! Entry saved. Viewable in history.";
  showMessagePopup(message);
});

window.addEventListener("message", async (event) => {
  if (
    event.source !== window ||
    !event.data ||
    event.data.type !== "DEEPL_TRANSLATE"
  )
    return;

  const fullText = event.data.payload;
  const requestId = event.data.requestId; // Unique ID for this request
  // background.js sets this on every Documents-tab batch so per-batch
  // verlauf entries / toasts are suppressed — those are aggregated into a
  // single entry + single toast at end-of-document. Main and Batch tabs
  // do not pass this flag, so their behavior is unchanged.
  const silent = event.data.silent === true;
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
  let cumulativeChars = 0;
  let failure = null; // { errorType, error } when a chunk aborts the batch

  for (let i = 0; i < chunks.length; i++) {
    // Bail before each chunk if DeepL is showing the paywall — saves us
    // 30s of waiting on a doomed translation.
    if (detectDeepLLimit()) {
      failure = { errorType: "char_limit", error: "DeepL character limit reached." };
      break;
    }

    // Clear the input field completely before starting new translation
    await clearInputField();

    // Small delay to ensure DeepL resets its state
    await delay(300);

    // Insert text and wait for the COMPLETE translation
    const r = await insertAndTranslateWithVerification(chunks[i], i);
    if (!r.ok) {
      failure = {
        errorType: r.errorType || "unknown",
        error:
          r.errorType === "char_limit"
            ? "DeepL character limit reached."
            : r.errorType === "dom"
              ? "DeepL UI elements not found."
              : "Translation timed out.",
      };
      break;
    }
    results.push(r.text);
    cumulativeChars += chunks[i].length;

    // Report per-chunk progress so fullpage.js can drive an accurate char counter
    chrome.runtime.sendMessage({
      type: "DEEPL_CHUNK_PROGRESS",
      requestId,
      charsTranslatedInBatch: cumulativeChars,
      chunkIndex: i,
      totalChunks: chunks.length,
    }).catch(() => {}); // suppress "no receiver" error when no extension page is open

    // Additional delay between chunks to prevent overlap
    if (i < chunks.length - 1) {
      await delay(500);
    }
  }

  // Abort path — the batch is unrecoverable from inside the page. Hand the
  // failure to background.js / popup so it can pause the document with a
  // checkpointed lastProcessedIndex and surface a Resume button.
  if (failure) {
    chrome.runtime.sendMessage({
      type: "DEEPL_TRANSLATION_COMPLETE",
      requestId,
      success: false,
      errorType: failure.errorType,
      error: failure.error,
      originalLength: fullText.length,
      // Tracking metadata — `i` is the index of the chunk that broke;
      // chunks completed before it = `i`. batchCount = total planned.
      batchCount: chunks.length,
      batchesCompleted: i,
    }).catch(() => {});
    return;
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

  // ✅ Always signal completion back to the caller (popup / loop / background)
  // — even in silent mode the orchestrator needs to know the batch is done.
  const sendCompletion = () => {
    chrome.runtime.sendMessage({
      type: "DEEPL_TRANSLATION_COMPLETE",
      requestId: requestId,
      success: true,
      originalLength: fullText.length,
      translatedLength: finalText.length,
      translatedText: finalText, // lets the orchestrator skip the verlauf lookup
      // Tracking metadata — total chunk count for this run.
      // On the success path batchesCompleted === batchCount by definition.
      batchCount: chunks.length,
      batchesCompleted: chunks.length,
    }).catch(() => {});
  };

  if (silent) {
    // Documents-tab batch: skip the per-batch verlauf write and toast.
    // background.js writes ONE verlauf entry and fires ONE toast for the
    // entire document via DEEPL_DOC_TOAST after all batches succeed.
    sendCompletion();
  } else {
    // Main/Batch path: original behavior — save to verlauf and toast.
    chrome.storage.local.get({ verlauf: [] }, (result) => {
      const verlauf = result.verlauf;
      verlauf.push(eintrag);

      chrome.storage.local.set({ verlauf }, () => {
        console.log("History entry saved:", eintrag);
        sendCompletion();
        showMessagePopup("✅ Done! Entry saved. Viewable in history.");
      });
    });
  }
});

// Helper function for delays
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Splits text into translation-ready chunks that respect sentence boundaries.
 *
 * Priority order for split points:
 *   1. End of complete sentences (., !, ?)
 *   2. Clause boundaries (; ,) — only when a single sentence exceeds maxLength
 *   3. Word boundaries — last resort only
 *
 * @param {string} text      Full input text
 * @param {number} maxLength Maximum characters per chunk
 * @returns {string[]}       Non-empty chunks, each within maxLength
 */
function splitText(text, maxLength) {
  if (!text || !text.trim()) return [];
  if (text.length <= maxLength) return [text];

  const sentences = splitIntoSentences(text);
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if (!sentence) continue;

    if (sentence.length > maxLength) {
      // This single sentence is longer than the limit — must split it
      if (current) { chunks.push(current); current = ""; }
      const parts = splitLongSentence(sentence, maxLength);
      for (let k = 0; k < parts.length - 1; k++) chunks.push(parts[k]);
      current = parts[parts.length - 1] ?? "";
      continue;
    }

    const withNext = current ? current + " " + sentence : sentence;
    if (withNext.length > maxLength) {
      // Adding this sentence would exceed the limit — flush and start fresh
      chunks.push(current);
      current = sentence;
    } else {
      current = withNext;
    }
  }

  if (current.trim()) chunks.push(current);
  return chunks;
}

/**
 * Heuristically splits text into individual sentences.
 *
 * Rules for detecting a sentence boundary at a punctuation character (.!?):
 *   - The punctuation must be followed by whitespace or end of string.
 *   - For a lone "." only: skip if preceded by a digit (decimal / list number)
 *     or by a single letter / known abbreviation (Dr., Mr., etc., bzw., …).
 *
 * Multi-paragraph text is split on blank lines first so each paragraph is
 * processed independently.
 */
function splitIntoSentences(text) {
  // Paragraph breaks are hard boundaries regardless of punctuation
  const paragraphs = text.split(/\n{2,}/);
  const sentences = [];
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed) sentences.push(..._sentencesFromParagraph(trimmed));
  }
  return sentences;
}

// Abbreviations whose trailing "." must not be treated as a sentence end
const _ABBREVS = new Set([
  // English
  'dr','mr','mrs','ms','prof','jr','sr','vs','etc','ca','approx',
  'st','ave','blvd','dept','est','vol','pp','ed','no','fig','ref',
  'jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec',
  // German
  'bzw','usw','ggf','inkl','exkl','bzgl','zzgl','zb','dh','ua','oa',
  'str','tel','nr','mfg','sa','sg','rd','vgl','abs','abb','sog','ca',
]);

function _sentencesFromParagraph(text) {
  const sentences = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '.' && c !== '!' && c !== '?') continue;

    // Absorb consecutive sentence-ending punctuation ("...", "!?", "!!")
    let punctEnd = i;
    while (punctEnd + 1 < text.length && '.!?'.includes(text[punctEnd + 1])) {
      punctEnd++;
    }

    // Absorb closing quotes / brackets attached to the sentence ('."', '!")')
    let afterPunct = punctEnd + 1;
    while (afterPunct < text.length && `"')]}»`.includes(text[afterPunct])) {
      afterPunct++;
    }

    // Boundary requires whitespace or end-of-string after the punctuation cluster
    if (afterPunct < text.length && !/\s/.test(text[afterPunct])) {
      i = punctEnd;
      continue;
    }

    // For a lone "." (not part of "..." or "?!"), apply abbreviation heuristics
    if (c === '.' && i === punctEnd) {
      // Digit before dot → decimal number ("3.14") or ordered list ("1.")
      if (i > 0 && /\d/.test(text[i - 1])) {
        i = punctEnd;
        continue;
      }

      // Extract the word token immediately before the dot
      let ws = i - 1;
      while (ws >= start && !/[\s.!?]/.test(text[ws])) ws--;
      const wordBefore = text.slice(ws + 1, i).toLowerCase();

      // Single-letter initial (e.g., "J.") or known abbreviation → not a boundary
      if (wordBefore.length === 1 || _ABBREVS.has(wordBefore)) {
        i = punctEnd;
        continue;
      }
    }

    // Valid sentence boundary — record the sentence
    const sentence = text.slice(start, afterPunct).trim();
    if (sentence) sentences.push(sentence);

    // Advance past trailing whitespace
    let next = afterPunct;
    while (next < text.length && /\s/.test(text[next])) next++;
    start = next;
    i = next - 1; // compensate for loop's i++
  }

  // Any remaining text after the last sentence-ending punctuation
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);

  return sentences;
}

/**
 * Splits a single sentence that exceeds maxLength at natural sub-boundaries.
 * Tries semicolons first, then commas, then words (last resort).
 */
function splitLongSentence(sentence, maxLength) {
  // Split after semicolons (keep the semicolon with the preceding clause)
  const bySemicolon = sentence.split(/(?<=;)\s*/);
  if (bySemicolon.length > 1) {
    const packed = _packTokens(bySemicolon, " ", maxLength);
    if (packed.every(c => c.length <= maxLength)) return packed;
  }

  // Split after commas (keep the comma with the preceding clause)
  const byComma = sentence.split(/(?<=,)\s*/);
  if (byComma.length > 1) {
    const packed = _packTokens(byComma, " ", maxLength);
    if (packed.every(c => c.length <= maxLength)) return packed;
  }

  // Last resort: word-by-word (mirrors the original algorithm)
  return _packTokens(sentence.split(" "), " ", maxLength);
}

/**
 * Greedily packs an array of tokens into strings, each ≤ maxLength.
 * Tokens are joined with `glue`.
 */
function _packTokens(tokens, glue, maxLength) {
  const chunks = [];
  let current = "";
  for (const token of tokens) {
    if (!token) continue;
    const candidate = current ? current + glue + token : token;
    if (candidate.length > maxLength) {
      if (current) chunks.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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

// Heuristic: is DeepL currently blocking us with a paywall / character
// limit / disabled input? Used both before each chunk (early bail) and
// when a translation times out empty (to distinguish 'limit' from
// 'genuinely slow translation').
function detectDeepLLimit() {
  const limitSelectors = [
    '[data-testid="paywall-dialog"]',
    '[data-testid*="paywall"]',
    '[data-testid*="limit-reached"]',
    '[data-testid*="char-limit"]',
    '[class*="paywall"]',
    '[class*="limitReached"]',
    '[class*="LimitReached"]',
    '[class*="charLimit"]',
  ];
  for (const sel of limitSelectors) {
    if (document.querySelector(sel)) return true;
  }
  // The source textbox going read-only / aria-disabled is DeepL's other
  // signal that the free tier is throttled.
  const src = document.querySelector(
    "[data-testid='translator-source-input'] [role='textbox']",
  );
  if (src) {
    if (src.getAttribute("aria-disabled") === "true") return true;
    if (src.getAttribute("contenteditable") === "false") return true;
  }
  return false;
}

// Main translation function with verification.
// Returns { ok: true, text } on success or { ok: false, errorType } on
// failure. errorType is 'dom' (selectors missing), 'char_limit' (paywall
// detected), or 'timeout' (no stable output after 30s).
async function insertAndTranslateWithVerification(text, chunkIndex) {
  const sourceInput = document.querySelector(
    "[data-testid='translator-source-input'] [role='textbox']"
  );
  const targetInput = document.querySelector(
    "[data-testid='translator-target-input'] [role='textbox']"
  );

  if (!sourceInput || !targetInput) {
    console.error("Could not find DeepL input/output fields");
    return { ok: false, errorType: "dom", text: "" };
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

  if (result.ok) {
    console.log(`[Chunk ${chunkIndex}] Got translation (${result.text.length} chars)`);
  } else {
    console.warn(`[Chunk ${chunkIndex}] Failed: ${result.errorType}`);
  }

  return result;
}

// Wait for translation to be complete AND stable (not changing anymore).
// Resolves with { ok, text, errorType? } so the caller can distinguish a
// genuine empty-output timeout from a paywall hit.
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
      // Fast-fail: paywall / char-limit detected mid-wait. No reason to
      // burn the rest of the 30s window.
      if (detectDeepLLimit()) {
        clearInterval(checkInterval);
        resolve({ ok: false, text: "", errorType: "char_limit" });
        return;
      }

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
          resolve({ ok: true, text: finalText });
        }, 500);
        return;
      }

      // Timeout fallback. If the output never appeared at all AND the
      // paywall was detected, it's a char-limit hit; if no paywall is
      // visible, it's a genuine timeout (DeepL silently never produced
      // output). If we got *something* but it never stabilised, also
      // treat as timeout so the user can just retry.
      //
      // Bugfix in this commit: the false-branch used to also report
      // "char_limit", so every silent-empty timeout was misclassified
      // as a paywall hit in the documents_translation_failed event.
      // PostHog error_type counts before this commit are biased — the
      // "char_limit" tally lumps paywall + true-timeout together.
      if (attempts >= maxAttempts) {
        clearInterval(checkInterval);
        console.warn(`[Chunk ${chunkIndex}] Timeout reached, current=${currentText.length} chars`);
        if (currentText.length === 0) {
          resolve({
            ok: false,
            text: "",
            errorType: detectDeepLLimit() ? "char_limit" : "timeout",
          });
        } else {
          resolve({ ok: false, text: currentText, errorType: "timeout" });
        }
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
// Add a listener for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "insideDeepL") {
    // Check if the element with class "overlayer active" exists
    // To ensure the user can't start if the countdown for the game still exists
    const path = window.location.pathname;

    const writeRegex = /^\/[^\/]+\/write/;
    const translateRegex = /^\/[^\/]+\/(translate|translator)/;

    const inside = writeRegex.test(path) || translateRegex.test(path);

    sendResponse({ inside });
    return true;
  }
});