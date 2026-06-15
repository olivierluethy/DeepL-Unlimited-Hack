// Shared translated-document download helpers.
//
// Generates a PDF from translated text. The text is drawn with an embedded
// Unicode font (Noto Sans CJK SC) registered through fontkit, so Japanese,
// Chinese, Korean and other non-Latin scripts render correctly. pdf-lib's
// StandardFonts (Helvetica/Times/Courier) use WinAnsi encoding and throw
// `WinAnsi cannot encode "..."` on any character outside Latin-1 — which is
// why CJK PDFs previously failed to download.
//
// Requires PDFLib (js/pdf-lib.min.js) and fontkit (js/fontkit.umd.min.js)
// to be loaded before use.

// Bundled as a web-accessible resource (see manifest.json) so it works
// offline and within the extension's CSP — no external fetch needed.
const CJK_FONT_URL = "fonts/NotoSansCJKsc-Regular.otf";

// Load the font bytes once and cache the in-flight promise so repeated
// downloads don't refetch ~16MB each time. Cleared on failure so a later
// attempt can retry.
let _cjkFontBytesPromise = null;
function loadCJKFontBytes() {
    if (!_cjkFontBytesPromise) {
        const url =
            typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
                ? chrome.runtime.getURL(CJK_FONT_URL)
                : CJK_FONT_URL;
        _cjkFontBytesPromise = fetch(url)
            .then((r) => {
                if (!r.ok) throw new Error("Failed to load CJK font (HTTP " + r.status + ")");
                return r.arrayBuffer();
            })
            .catch((e) => {
                _cjkFontBytesPromise = null;
                throw e;
            });
    }
    return _cjkFontBytesPromise;
}

async function createTranslatedPDF(filename, translatedText) {
    const { PDFDocument, rgb } = PDFLib;
    const doc = await PDFDocument.create();

    if (!window.fontkit) throw new Error("fontkit is not loaded");
    doc.registerFontkit(window.fontkit);

    // subset:true embeds only the glyphs actually used, keeping the output
    // PDF small (tens of KB) despite the large source font.
    const fontBytes = await loadCJKFontBytes();
    const font = await doc.embedFont(fontBytes, { subset: true });

    const PAGE_W = 595;
    const PAGE_H = 842;
    const MARGIN = 50;
    const LINE = 17.05;
    const MAX_W = 495;

    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = 777;

    const title = filename.replace(/\.pdf$/i, "");
    // A single pan-CJK font is embedded, so the title is emphasized with a
    // larger size and accent color rather than a separate bold cut.
    page.drawText("Translation: " + title, {
        x: MARGIN,
        y,
        font,
        size: 13,
        color: rgb(0.05, 0.27, 0.98),
    });
    y -= LINE;
    page.drawText(new Date().toLocaleString(), {
        x: MARGIN,
        y,
        font,
        size: 9,
        color: rgb(0.5, 0.5, 0.5),
    });
    y -= 10.23;
    page.drawLine({
        start: { x: MARGIN, y },
        end: { x: 545, y },
        thickness: 0.5,
        color: rgb(0.8, 0.8, 0.8),
    });
    y -= 23.87;

    const needsPage = () => y < 67.05;
    const newPage = () => {
        page = doc.addPage([PAGE_W, PAGE_H]);
        y = 777;
    };

    const widthOf = (s) => {
        try {
            return font.widthOfTextAtSize(s, 11);
        } catch {
            return 11 * s.length * 0.6;
        }
    };

    // Draw one already-fitted line. With a custom font, characters missing
    // from the font render as the .notdef glyph instead of throwing, but we
    // still guard the draw so a single bad segment degrades gracefully
    // (logged warning) rather than aborting the whole download.
    function drawLine(line) {
        if (needsPage()) newPage();
        try {
            page.drawText(line, { x: MARGIN, y, font, size: 11, color: rgb(0, 0, 0) });
        } catch (e) {
            console.warn("Skipped undrawable text segment:", e && e.message);
        }
        y -= LINE;
    }

    // Break a token that is itself wider than a line (long CJK runs without
    // spaces, or long URLs) at the character level. Returns the leftover
    // partial line.
    function breakLongToken(token) {
        let line = "";
        for (const ch of token) {
            const trial = line + ch;
            if (line && widthOf(trial) > MAX_W) {
                drawLine(line);
                line = ch;
            } else {
                line = trial;
            }
        }
        return line;
    }

    function wrapParagraph(text) {
        if (!text.trim()) return;
        let line = "";
        for (const tok of text.split(" ")) {
            if (!tok) continue;
            const trial = line ? line + " " + tok : tok;
            if (widthOf(trial) <= MAX_W) {
                line = trial;
                continue;
            }
            // trial is too wide: flush the current line first.
            if (line) {
                drawLine(line);
                line = "";
            }
            // A token longer than a whole line (common for spaceless CJK)
            // is broken character-by-character; otherwise it starts the
            // next line.
            line = widthOf(tok) > MAX_W ? breakLongToken(tok) : tok;
        }
        if (line) drawLine(line);
    }

    for (const para of translatedText.split("\n")) {
        const t = para.trim();
        if (t) {
            wrapParagraph(t);
            y -= 4.2625;
        } else {
            y -= 8.525;
            if (needsPage()) newPage();
        }
    }

    return await doc.save();
}

function triggerPdfDownload(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5e3);
}
