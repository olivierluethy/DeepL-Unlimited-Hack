// Shared translated-document download helpers.
//
// Generates a translated PDF. When a layout captured from the source PDF is
// available (see js/pdf-image-extract.js), the output is rebuilt page-by-page:
// each output page matches the source page's size and rotation, the source
// page's images are re-embedded at their original positions/sizes, and that
// page's translated text is flowed on top. Without a layout (old history
// entries, image-free PDFs, or a failed/oversized extraction) it falls back to
// the original blank text-only document, so nothing regresses.
//
// Text is drawn with an embedded Unicode font (Noto Sans CJK SC) registered
// through fontkit, so Japanese, Chinese, Korean and other non-Latin scripts
// render correctly. pdf-lib's StandardFonts (Helvetica/Times/Courier) use
// WinAnsi encoding and throw `WinAnsi cannot encode "..."` on any character
// outside Latin-1 — which is why CJK PDFs previously failed to download.
//
// Requires PDFLib (js/pdf-lib.min.js) and fontkit (js/fontkit.umd.min.js) to be
// loaded before use.

// Bundled as a web-accessible resource (see manifest.json) so it works offline
// and within the extension's CSP — no external fetch needed.
const CJK_FONT_URL = "fonts/NotoSansCJKsc-Regular.otf";

// ---------------------------------------------------------------------------
// Pure helpers (also exported for Node tests at the bottom of the file).
// ---------------------------------------------------------------------------

// Split the flat translated string back into per-page text so each source
// page can be paired with its translation.
//
// Best case: the translation preserved paragraph boundaries and there is
// exactly one translated paragraph per text-bearing page — then the mapping is
// exact 1:1. Otherwise we fall back to a character-proportional split weighted
// by each page's original text length, snapping to whitespace so words aren't
// cut. Image-only pages (no source text) get an empty string and just show
// their images. Never throws; returns one entry per page in `layout.pages`.
function splitTranslationIntoPages(translatedText, layout) {
    const pages = (layout && layout.pages) || [];
    const result = new Array(pages.length).fill("");
    const textIdx = [];
    for (let i = 0; i < pages.length; i++) if (pages[i].hasText) textIdx.push(i);
    if (!textIdx.length) return result;

    const paras = String(translatedText || "")
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean);

    // Exact per-page mapping when paragraph count matches text-page count.
    if (paras.length === textIdx.length) {
        textIdx.forEach((pi, k) => (result[pi] = paras[k]));
        return result;
    }

    // Character-proportional fallback.
    const full = String(translatedText || "").trim();
    if (!full) return result;
    const weights = textIdx.map((pi) => Math.max(1, pages[pi].textLen || 1));
    const totalW = weights.reduce((a, b) => a + b, 0);
    const N = full.length;

    const snap = (pos) => {
        if (pos <= 0) return 0;
        if (pos >= N) return N;
        for (let d = 0; d <= 80; d++) {
            if (/\s/.test(full[pos - d] || "")) return pos - d + 1;
            if (/\s/.test(full[pos + d] || "")) return pos + d + 1;
        }
        return pos;
    };

    let cursor = 0;
    let accW = 0;
    for (let k = 0; k < textIdx.length; k++) {
        accW += weights[k];
        const end = k === textIdx.length - 1 ? N : snap(Math.round((accW / totalW) * N));
        result[textIdx[k]] = full.slice(cursor, Math.max(cursor, end)).trim();
        cursor = Math.max(cursor, end);
    }
    return result;
}

// Decode a `data:image/png;base64,...` URL to bytes.
function dataUrlToBytes(url) {
    const i = String(url).indexOf(",");
    if (i < 0) return new Uint8Array(0);
    const bin = atob(url.slice(i + 1));
    const out = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
    return out;
}

// ---------------------------------------------------------------------------
// Font loading
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

// Flow wrapped text into a document, adding continuation pages as needed.
// `makePage()` must return a fresh { page, top } whenever the current page is
// full. Returns nothing; draws directly. `opts.backing` draws a translucent
// white strip behind each line so text stays legible over images.
function makeTextFlow(font, rgb, opts) {
    const { size = 11, line = 17.05, margin = 50, bottom = 67.05, backing = false } = opts;
    let page = null;
    let maxW = 0;
    let y = 0;

    const widthOf = (s) => {
        try {
            return font.widthOfTextAtSize(s, size);
        } catch {
            return size * s.length * 0.6;
        }
    };

    function setPage(p) {
        page = p.page;
        y = p.top;
        maxW = p.width - 2 * margin;
    }

    function ensureRoom(next) {
        if (y < bottom) setPage(next());
    }

    function drawLine(text, next) {
        ensureRoom(next);
        if (backing && text) {
            const w = Math.min(maxW, widthOf(text) + 4);
            try {
                page.drawRectangle({
                    x: margin - 2,
                    y: y - 3.5,
                    width: w,
                    height: size + 4,
                    color: rgb(1, 1, 1),
                    opacity: 0.72,
                });
            } catch {}
        }
        try {
            page.drawText(text, { x: margin, y, font, size, color: rgb(0, 0, 0) });
        } catch (e) {
            console.warn("Skipped undrawable text segment:", e && e.message);
        }
        y -= line;
    }

    function breakLongToken(token, next) {
        let acc = "";
        for (const ch of token) {
            const trial = acc + ch;
            if (acc && widthOf(trial) > maxW) {
                drawLine(acc, next);
                acc = ch;
            } else {
                acc = trial;
            }
        }
        return acc;
    }

    function wrapParagraph(text, next) {
        if (!text.trim()) return;
        let acc = "";
        for (const tok of text.split(" ")) {
            if (!tok) continue;
            const trial = acc ? acc + " " + tok : tok;
            if (widthOf(trial) <= maxW) {
                acc = trial;
                continue;
            }
            if (acc) {
                drawLine(acc, next);
                acc = "";
            }
            acc = widthOf(tok) > maxW ? breakLongToken(tok, next) : tok;
        }
        if (acc) drawLine(acc, next);
    }

    // Flow a block of text (paragraphs separated by newlines) onto pages
    // supplied by next(). first() provides the starting page.
    function flow(text, first, next) {
        setPage(first());
        for (const para of String(text).split("\n")) {
            const t = para.trim();
            if (t) {
                wrapParagraph(t, next);
                y -= 4.2625;
            } else {
                y -= 8.525;
                ensureRoom(next);
            }
        }
    }

    return { flow };
}

// Rebuild the translated PDF from the captured source layout, re-embedding
// every image at its original position/size and flowing the translated text.
async function buildLayoutPDF(doc, font, rgb, degrees, translatedText, layout, report) {
    const perPage = splitTranslationIntoPages(translatedText, layout);
    const MARGIN = 50;

    for (let i = 0; i < layout.pages.length; i++) {
        const src = layout.pages[i];
        const W = src.width || 595;
        const H = src.height || 842;

        const first = () => {
            const p = doc.addPage([W, H]);
            if (src.rotation) {
                try {
                    p.setRotation(degrees(src.rotation));
                } catch {}
            }
            return { page: p, top: H - MARGIN, width: W };
        };
        // Continuation pages (when a page's translation overflows) are blank,
        // same size, so no text is lost.
        const cont = () => {
            const p = doc.addPage([W, H]);
            if (src.rotation) {
                try {
                    p.setRotation(degrees(src.rotation));
                } catch {}
            }
            report.continuationPages++;
            return { page: p, top: H - MARGIN, width: W };
        };

        const firstPageRef = first();

        // Images first (below the text), preserving their z-order among
        // themselves.
        for (const img of src.images || []) {
            try {
                const png = await doc.embedPng(dataUrlToBytes(img.png));
                firstPageRef.page.drawImage(png, {
                    x: img.x,
                    y: img.y,
                    width: img.w,
                    height: img.h,
                });
                report.embeddedImages++;
            } catch (e) {
                report.warnings.push("Page " + (i + 1) + ": failed to embed an image (" + (e && e.message) + ")");
            }
        }

        // Translated text for this page, on top of the images.
        const text = perPage[i];
        if (text && text.trim()) {
            const flow = makeTextFlow(font, rgb, {
                backing: (src.images || []).length > 0,
            }).flow;
            flow(text, () => firstPageRef, cont);
        }
    }
}

// Original blank text-only document (fallback / no-layout path).
async function buildTextPDF(doc, font, rgb, filename, translatedText) {
    const PAGE_W = 595;
    const PAGE_H = 842;
    const MARGIN = 50;

    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = 777;

    const title = filename.replace(/\.pdf$/i, "");
    page.drawText("Translation: " + title, { x: MARGIN, y, font, size: 13, color: rgb(0.05, 0.27, 0.98) });
    y -= 17.05;
    page.drawText(new Date().toLocaleString(), { x: MARGIN, y, font, size: 9, color: rgb(0.5, 0.5, 0.5) });
    y -= 10.23;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: 545, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    y -= 23.87;

    const flowState = { page, top: y, width: PAGE_W };
    const flow = makeTextFlow(font, rgb, {}).flow;
    flow(
        translatedText,
        () => flowState,
        () => ({ page: doc.addPage([PAGE_W, PAGE_H]), top: 777, width: PAGE_W })
    );
}

// Build the translated PDF. Returns { bytes, report }.
//
// report = {
//   mode: 'layout' | 'text',
//   expectedImages, embeddedImages, continuationPages,
//   truncated, anyRotated, ok, warnings: []
// }
async function createTranslatedPDF(filename, translatedText, layout) {
    const { PDFDocument, rgb, degrees } = PDFLib;
    const doc = await PDFDocument.create();

    if (!window.fontkit) throw new Error("fontkit is not loaded");
    doc.registerFontkit(window.fontkit);
    const fontBytes = await loadCJKFontBytes();
    const font = await doc.embedFont(fontBytes, { subset: true });

    const hasLayout =
        layout &&
        !layout.storeFailed &&
        Array.isArray(layout.pages) &&
        layout.pages.length > 0;

    const report = {
        mode: hasLayout ? "layout" : "text",
        expectedImages: layout ? layout.imageCount || 0 : 0,
        embeddedImages: 0,
        continuationPages: 0,
        truncated: !!(layout && layout.truncated),
        anyRotated: !!(layout && layout.anyRotated),
        warnings: [],
        ok: true,
    };

    if (hasLayout) {
        await buildLayoutPDF(doc, font, rgb, degrees, translatedText, layout, report);
    } else {
        await buildTextPDF(doc, font, rgb, filename, translatedText);
        if (report.expectedImages > 0) {
            report.warnings.push(
                report.truncated
                    ? report.expectedImages + " image(s) could not be preserved (too large to store)."
                    : "This document has " + report.expectedImages + " image(s) that could not be preserved."
            );
        }
    }

    // Verification: every expected image should have been embedded.
    if (report.expectedImages > 0 && report.embeddedImages < report.expectedImages) {
        report.ok = false;
        report.warnings.unshift(
            "Only " + report.embeddedImages + " of " + report.expectedImages + " image(s) were preserved in the output."
        );
    }
    if (report.truncated) {
        report.ok = false;
    }

    const bytes = await doc.save();
    return { bytes, report };
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// Produce the converted PDF. Preferred path: keep the ORIGINAL PDF as the base
// and only replace its text (layout-preserving overlay). Falls back to the
// legacy blank rebuild only when no original/blocks are available (e.g. old
// history entries). Returns { bytes, report }.
async function createOutputPDF(filename, translatedText, layout, originalB64) {
    const canOverlay =
        originalB64 &&
        layout &&
        layout.version >= 2 &&
        !layout.storeFailed &&
        Array.isArray(layout.blocks) &&
        layout.blocks.length > 0 &&
        window.pdfOverlay &&
        typeof window.pdfOverlay.buildOverlayPDF === "function";

    if (canOverlay) {
        if (!window.fontkit) throw new Error("fontkit is not loaded");
        const fontBytes = await loadCJKFontBytes();
        const { bytes, report } = await window.pdfOverlay.buildOverlayPDF(
            PDFLib,
            window.fontkit,
            fontBytes,
            base64ToBytes(originalB64),
            translatedText,
            layout
        );
        return { bytes, report };
    }

    // Fallback: no original document to edit in place.
    const { bytes, report } = await createTranslatedPDF(filename, translatedText, layout);
    if (report && report.mode === "text" && layout && layout.blocks && layout.blocks.length) {
        report.warnings = report.warnings || [];
        report.warnings.unshift("Original PDF was not available, so the layout could not be preserved (text-only output).");
        report.ok = false;
    }
    return { bytes, report };
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

if (typeof module !== "undefined" && module.exports) {
    module.exports = { splitTranslationIntoPages, dataUrlToBytes, base64ToBytes, createTranslatedPDF };
}
