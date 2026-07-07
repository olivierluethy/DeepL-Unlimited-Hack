// Layout-preserving in-place text overlay.
//
// The old pipeline extracted text and rebuilt a brand-new PDF, destroying the
// original layout (columns, reading order, images, colours). This module keeps
// the ORIGINAL PDF as the base and only replaces its text:
//
//   1. extractOverlayLayout() groups the page's text runs into blocks
//      (paragraphs/labels) with their bounding box, font size, and sampled
//      background/foreground colours, in a stable order. The blocks joined by
//      blank lines become the text that gets translated by the existing engine.
//   2. buildOverlayPDF() loads the original PDF with pdf-lib (so every image,
//      vector graphic, colour and position is preserved untouched), covers each
//      block's original glyphs with the sampled background colour, and redraws
//      the translated text at the same position/colour — wrapped and auto-fit
//      to the original block box so length changes don't reflow the layout.
//
// Extraction needs pdfjsLib (js/pdf.min.js) + a DOM <canvas>. Building needs
// PDFLib (js/pdf-lib.min.js) + fontkit. Pure helpers are exported for Node.

(function () {
    "use strict";

    const RENDER_SCALE = 2; // colour-sampling resolution
    const MAX_PAGE_PX = 2600;

    // ---- pure geometry / grouping helpers (Node-testable) ----

    // Approximate a text item's box in PDF space (bottom-left origin).
    // transform = [a,b,c,d,e,f]; (e,f) is the baseline origin.
    function itemBox(it) {
        const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
        const x = it.transform[4];
        const baseline = it.transform[5];
        const w = it.width || size * (it.str ? it.str.length : 1) * 0.5;
        return { x, baseline, size, w, yTop: baseline + size * 0.8, yBot: baseline - size * 0.2, str: it.str || "" };
    }

    // Group text items into lines then blocks. Returns blocks ordered by
    // column (left→right) then top→bottom, each: {x,yTop,w,h,size,text}.
    function groupIntoBlocks(items) {
        const boxes = items.map(itemBox).filter((b) => b.str.trim() !== "" || b.w > 0);
        if (!boxes.length) return [];

        // Group by baseline (within 0.5*size), sorted top→bottom then x.
        boxes.sort((a, b) => b.baseline - a.baseline || a.x - b.x);
        const rows = [];
        for (const b of boxes) {
            const tol = Math.max(2, b.size * 0.5);
            let row = rows.find((l) => Math.abs(l.baseline - b.baseline) <= tol && b.size >= l.size * 0.6 && b.size <= l.size * 1.7);
            if (!row) {
                row = { baseline: b.baseline, size: b.size, items: [] };
                rows.push(row);
            }
            row.items.push(b);
        }
        // Split each baseline row into separate lines on large horizontal gaps
        // (column boundaries) so two-column text never merges into one block.
        const lines = [];
        for (const row of rows) {
            row.items.sort((a, b) => a.x - b.x);
            let seg = null;
            let prev = null;
            for (const it of row.items) {
                const colGap = Math.max(it.size * 2.2, 34);
                if (!seg || (prev && it.x - (prev.x + prev.w) > colGap)) {
                    seg = { baseline: row.baseline, size: it.size, items: [] };
                    lines.push(seg);
                }
                seg.items.push(it);
                prev = it;
            }
        }
        for (const l of lines) {
            l.items.sort((a, b) => a.x - b.x);
            l.size = median(l.items.map((i) => i.size));
            l.x = Math.min(...l.items.map((i) => i.x));
            l.right = Math.max(...l.items.map((i) => i.x + i.w));
            l.yTop = Math.max(...l.items.map((i) => i.yTop));
            l.yBot = Math.min(...l.items.map((i) => i.yBot));
            l.size = median(l.items.map((i) => i.size));
            // Rebuild line text inserting spaces where there are gaps.
            let text = "";
            let prev = null;
            for (const it of l.items) {
                if (prev) {
                    const gap = it.x - (prev.x + prev.w);
                    if (gap > prev.size * 0.25) text += " ";
                }
                text += it.str;
                prev = it;
            }
            l.text = text.replace(/\s+/g, " ").trim();
        }

        // Assign lines to columns, then merge vertically WITHIN each column so
        // adjacent columns never bleed into one block.
        const withText = lines.filter((l) => l.text);
        const colOf = clusterColumns(withText.map((l) => ({ x: l.x })));
        const byCol = new Map();
        for (const l of withText) {
            const c = colOf(l.x);
            if (!byCol.has(c)) byCol.set(c, []);
            byCol.get(c).push(l);
        }
        const blocks = [];
        for (const c of [...byCol.keys()].sort((a, b) => a - b)) {
            const colLines = byCol.get(c).sort((a, b) => b.yTop - a.yTop);
            let cur = null;
            for (const l of colLines) {
                const sameX = cur && Math.abs(cur.x - l.x) <= Math.max(8, l.size * 2);
                const gap = cur ? cur.yBot - l.yTop : Infinity;
                const sameSize = cur && l.size >= cur.size * 0.7 && l.size <= cur.size * 1.4;
                if (cur && sameX && sameSize && gap <= l.size * 1.2 && gap >= -l.size * 0.6) {
                    cur.lines.push(l);
                    cur.x = Math.min(cur.x, l.x);
                    cur.right = Math.max(cur.right, l.right);
                    cur.yBot = Math.min(cur.yBot, l.yBot);
                } else {
                    cur = { x: l.x, right: l.right, yTop: l.yTop, yBot: l.yBot, size: l.size, lines: [l] };
                    blocks.push(cur);
                }
            }
        }

        // Finalise: bbox, text (lines joined by space), representative size.
        const out = blocks.map((b) => ({
            x: b.x,
            yTop: b.yTop,
            w: b.right - b.x,
            h: b.yTop - b.yBot,
            size: median(b.lines.map((l) => l.size)),
            text: b.lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim(),
        })).filter((b) => b.text && b.w > 1 && b.h > 1);

        // Stable reading order: cluster into columns by x, columns L→R,
        // blocks within a column top→bottom.
        const cols = clusterColumns(out);
        out.sort((a, b) => {
            const ca = cols(a.x), cb = cols(b.x);
            if (ca !== cb) return ca - cb;
            return b.yTop - a.yTop;
        });
        return out;
    }

    function clusterColumns(blocks) {
        const xs = blocks.map((b) => b.x).sort((a, b) => a - b);
        const centers = [];
        for (const x of xs) {
            const c = centers.find((c) => Math.abs(c - x) < 60);
            if (c === undefined) centers.push(x);
        }
        centers.sort((a, b) => a - b);
        return (x) => {
            let best = 0, bd = Infinity;
            centers.forEach((c, i) => {
                const d = Math.abs(c - x);
                if (d < bd) { bd = d; best = i; }
            });
            return best;
        };
    }

    function median(a) {
        if (!a.length) return 0;
        const s = [...a].sort((x, y) => x - y);
        return s[Math.floor(s.length / 2)];
    }

    // Split the flat translated string back into per-block text. Exact 1:1 when
    // paragraph count matches block count, else proportional by original block
    // length. Never throws; returns one entry per block plus a `matched` flag.
    function splitTranslationIntoBlocks(translatedText, blocks) {
        const result = new Array(blocks.length).fill("");
        if (!blocks.length) return { texts: result, matched: true };
        const paras = String(translatedText || "").split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
        if (paras.length === blocks.length) {
            return { texts: paras.slice(), matched: true };
        }
        const full = String(translatedText || "").trim();
        if (!full) return { texts: result, matched: false };
        const weights = blocks.map((b) => Math.max(1, (b.text || "").length));
        const total = weights.reduce((a, b) => a + b, 0);
        const N = full.length;
        const snap = (p) => {
            if (p <= 0) return 0;
            if (p >= N) return N;
            for (let d = 0; d <= 80; d++) {
                if (/\s/.test(full[p - d] || "")) return p - d + 1;
                if (/\s/.test(full[p + d] || "")) return p + d + 1;
            }
            return p;
        };
        let cursor = 0, acc = 0;
        for (let i = 0; i < blocks.length; i++) {
            acc += weights[i];
            const end = i === blocks.length - 1 ? N : snap(Math.round((acc / total) * N));
            result[i] = full.slice(cursor, Math.max(cursor, end)).trim();
            cursor = Math.max(cursor, end);
        }
        return { texts: result, matched: false };
    }

    // Wrap `text` to `maxW` at `size` using a width-measuring fn. Returns lines.
    function wrapLines(text, maxW, size, widthOf) {
        const words = String(text).split(/\s+/).filter(Boolean);
        const lines = [];
        let line = "";
        for (const w of words) {
            const trial = line ? line + " " + w : w;
            if (widthOf(trial, size) <= maxW || !line) {
                line = trial;
            } else {
                lines.push(line);
                line = w;
            }
        }
        if (line) lines.push(line);
        return lines;
    }

    // ---- browser extraction (pdfjs + canvas) ----

    function luminance(c) {
        return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    }

    // Sample the background colour in a thin ring just outside a device rect.
    function sampleBg(ctx, dr, cw, ch) {
        const pad = 3;
        const pts = [];
        const push = (x, y) => {
            if (x >= 0 && y >= 0 && x < cw && y < ch) pts.push([Math.floor(x), Math.floor(y)]);
        };
        for (let t = 0; t <= 1; t += 0.2) {
            push(dr.x0 + (dr.x1 - dr.x0) * t, dr.y0 - pad);
            push(dr.x0 + (dr.x1 - dr.x0) * t, dr.y1 + pad);
            push(dr.x0 - pad, dr.y0 + (dr.y1 - dr.y0) * t);
            push(dr.x1 + pad, dr.y0 + (dr.y1 - dr.y0) * t);
        }
        if (!pts.length) return [255, 255, 255];
        const rs = [], gs = [], bs = [];
        for (const [x, y] of pts) {
            const d = ctx.getImageData(x, y, 1, 1).data;
            rs.push(d[0]); gs.push(d[1]); bs.push(d[2]);
        }
        return [median(rs), median(gs), median(bs)];
    }

    async function extractOverlayLayout(pdfjsLib, arrayBuffer) {
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pages = [];
        const allBlocks = [];
        const textParts = [];

        for (let n = 1; n <= pdf.numPages; n++) {
            let page;
            try {
                page = await pdf.getPage(n);
            } catch {
                pages.push({ width: 595, height: 842 });
                continue;
            }
            const view = page.view;
            const pw = view[2] - view[0];
            const ph = view[3] - view[1];
            pages.push({ width: pw, height: ph });

            let blocks = [];
            try {
                const tc = await page.getTextContent();
                blocks = groupIntoBlocks(tc.items);
            } catch (e) {
                console.warn("[pdf-overlay] text extraction failed p", n, e && e.message);
            }
            if (!blocks.length) continue;

            // Sample colours from a rendered page.
            try {
                let scale = RENDER_SCALE;
                if (Math.max(pw, ph) * scale > MAX_PAGE_PX) scale = MAX_PAGE_PX / Math.max(pw, ph);
                const viewport = page.getViewport({ scale });
                const canvas = document.createElement("canvas");
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                await page.render({ canvasContext: ctx, viewport }).promise;
                for (const b of blocks) {
                    const [dx0, dy0] = applyPt(viewport.transform, b.x, b.yTop);
                    const [dx1, dy1] = applyPt(viewport.transform, b.x + b.w, b.yTop - b.h);
                    const dr = { x0: Math.min(dx0, dx1), y0: Math.min(dy0, dy1), x1: Math.max(dx0, dx1), y1: Math.max(dy0, dy1) };
                    b.bg = sampleBg(ctx, dr, canvas.width, canvas.height);
                    b.fg = luminance(b.bg) < 0.5 ? [255, 255, 255] : [17, 17, 17];
                }
                canvas.width = canvas.height = 0;
            } catch (e) {
                for (const b of blocks) { b.bg = [255, 255, 255]; b.fg = [17, 17, 17]; }
            }

            for (const b of blocks) {
                b.page = n - 1;
                allBlocks.push(b);
                textParts.push(b.text);
            }
        }

        return {
            text: textParts.join("\n\n"),
            pageCount: pdf.numPages,
            layout: { version: 2, pages, blocks: allBlocks, blockCount: allBlocks.length },
        };
    }

    function applyPt(m, x, y) {
        return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }

    // ---- pdf-lib overlay build (pure given PDFLib+fontkit+bytes) ----

    async function buildOverlayPDF(PDFLib, fontkit, fontBytes, originalBytes, translatedText, layout) {
        const { PDFDocument, rgb } = PDFLib;
        const doc = await PDFDocument.load(originalBytes);
        doc.registerFontkit(fontkit);
        const font = await doc.embedFont(fontBytes, { subset: true });
        const pages = doc.getPages();

        const blocks = layout.blocks || [];
        const { texts, matched } = splitTranslationIntoBlocks(translatedText, blocks);
        const widthOf = (s, size) => {
            try { return font.widthOfTextAtSize(s, size); } catch { return size * s.length * 0.6; }
        };

        const report = { mode: "overlay", pageCount: pages.length, blocks: blocks.length, covered: 0, matched, warnings: [], ok: true };

        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            const txt = (texts[i] || "").trim();
            const page = pages[b.page];
            if (!page) continue;
            const bg = b.bg || [255, 255, 255];
            const fg = b.fg || [17, 17, 17];
            const pad = Math.max(1, b.size * 0.15);

            // Cover the original glyphs.
            try {
                page.drawRectangle({
                    x: b.x - pad,
                    y: b.yTop - b.h - pad,
                    width: b.w + 2 * pad,
                    height: b.h + 2 * pad,
                    color: rgb(bg[0] / 255, bg[1] / 255, bg[2] / 255),
                });
            } catch {}

            if (!txt) continue;

            // Auto-fit: shrink font until wrapped text fits the block height.
            let size = b.size;
            let lines = wrapLines(txt, b.w, size, widthOf);
            const minSize = Math.max(4, b.size * 0.5);
            while (lines.length * size * 1.18 > b.h + b.size * 0.5 && size > minSize) {
                size -= 0.5;
                lines = wrapLines(txt, b.w, size, widthOf);
            }
            const lh = size * 1.18;
            let y = b.yTop - size;
            for (const ln of lines) {
                try {
                    page.drawText(ln, { x: b.x, y, font, size, color: rgb(fg[0] / 255, fg[1] / 255, fg[2] / 255) });
                } catch (e) {
                    report.warnings.push("Block " + i + ": " + (e && e.message));
                }
                y -= lh;
            }
            report.covered++;
        }

        if (!matched && blocks.length) {
            report.ok = false;
            report.warnings.unshift(
                "Text block alignment is approximate (translation changed the paragraph count). Some text may sit in the wrong block."
            );
        }

        const bytes = await doc.save();
        return { bytes, report };
    }

    const api = { extractOverlayLayout, buildOverlayPDF, groupIntoBlocks, splitTranslationIntoBlocks, wrapLines, itemBox };
    if (typeof window !== "undefined") Object.assign(window, { pdfOverlay: api });
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
