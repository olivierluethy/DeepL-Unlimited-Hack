// Render-level integration test: proves images actually RENDER (not just that
// XObjects exist) in a real output PDF produced by the real createTranslatedPDF.
//
// Builds a source PDF with a distinctive 4-quadrant image (red/green/blue/
// yellow), extracts its layout (real pdfjs + node-canvas), runs the actual
// generator, then re-renders the OUTPUT pdf to a raster and samples pixels at
// each image's position — asserting the four quadrant colours appear in the
// right places. Also writes the rendered pages to a temp dir for eyeballing.
//
// Optional deps (not vendored): npm install pdfjs-dist@3 canvas
// Also needs fonts/NotoSansCJKsc-Regular.otf (bundled). Skips if deps absent.
// Run: node js/pdf-render.e2e.test.js
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const ROOT = __dirname;

let createCanvas, Image, pdfjsLib;
try {
    ({ createCanvas, Image } = require("canvas"));
    pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
} catch (e) {
    console.log("SKIP render e2e: optional deps missing (npm install pdfjs-dist@3 canvas).");
    process.exit(0);
}

const PDFLibMod = require(path.join(ROOT, "pdf-lib.min.js"));
const fontkit = require(path.join(ROOT, "fontkit.umd.min.js"));

// Globals the vendored browser modules and the generator expect in node.
global.window = global;
global.document = { createElement: (t) => (t === "canvas" ? createCanvas(1, 1) : {}) };
global.Image = Image;
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.window.requestAnimationFrame = global.requestAnimationFrame;
global.window.cancelAnimationFrame = global.cancelAnimationFrame;
global.PDFLib = PDFLibMod;
global.window.fontkit = fontkit;
global.fetch = async (url) => {
    const p = url.startsWith("/") ? url : path.join(ROOT, "..", url);
    const buf = fs.readFileSync(p);
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

const { extractPdfLayout } = require(path.join(ROOT, "pdf-image-extract.js"));
const { createTranslatedPDF } = require(path.join(ROOT, "doc-download.js"));
const { PDFDocument, StandardFonts } = PDFLibMod;

function quadrantPng(sz = 120) {
    const c = createCanvas(sz, sz), x = c.getContext("2d"), h = sz / 2;
    x.fillStyle = "rgb(220,20,20)"; x.fillRect(0, 0, h, h);
    x.fillStyle = "rgb(20,180,20)"; x.fillRect(h, 0, h, h);
    x.fillStyle = "rgb(20,20,220)"; x.fillRect(0, h, h, h);
    x.fillStyle = "rgb(230,210,20)"; x.fillRect(h, h, h, h);
    return c.toBuffer("image/png");
}

function avgColor(ctx, x0, y0, x1, y1) {
    const sx = Math.round(Math.min(x0, x1)), sy = Math.round(Math.min(y0, y1));
    const w = Math.round(Math.abs(x1 - x0)), h = Math.round(Math.abs(y1 - y0));
    const d = ctx.getImageData(sx, sy, w, h).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}
const near = (c, [R, G, B], tol = 55) => Math.abs(c[0] - R) < tol && Math.abs(c[1] - G) < tol && Math.abs(c[2] - B) < tol;

(async () => {
    // Source: text+image page, plus an image-only (scanned-like) page.
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(quadrantPng());
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595, 842]);
    p1.drawText("Original page one text.", { x: 50, y: 800, size: 12, font });
    p1.drawImage(png, { x: 200, y: 380, width: 180, height: 180 });
    const p2 = doc.addPage([300, 300]);
    p2.drawImage(png, { x: 0, y: 0, width: 300, height: 300 });
    const src = await doc.save();

    const { layout } = await extractPdfLayout(pdfjsLib, src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));

    // Real generator.
    const { bytes, report } = await createTranslatedPDF("sample.pdf", "Seite eins uebersetzt.", layout);
    assert.strictEqual(report.mode, "layout");
    assert.strictEqual(report.embeddedImages, layout.imageCount);
    assert.strictEqual(report.ok, true);

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-render-"));
    const outDoc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    let checks = 0;
    for (let pageNo = 1; pageNo <= outDoc.numPages; pageNo++) {
        const page = await outDoc.getPage(pageNo);
        const vp = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        fs.writeFileSync(path.join(outDir, `page${pageNo}.png`), canvas.toBuffer("image/png"));

        for (const im of layout.pages[pageNo - 1].images) {
            const map = (x, y) => [vp.transform[0] * x + vp.transform[2] * y + vp.transform[4], vp.transform[1] * x + vp.transform[3] * y + vp.transform[5]];
            const [ax, ay] = map(im.x, im.y), [bx, by] = map(im.x + im.w, im.y + im.h);
            const left = Math.min(ax, bx), right = Math.max(ax, bx), top = Math.min(ay, by), bot = Math.max(ay, by);
            const mx = (left + right) / 2, my = (top + bot) / 2, qw = (right - left) / 2, qh = (bot - top) / 2;
            const TL = avgColor(ctx, left + qw * 0.25, top + qh * 0.25, left + qw * 0.75, top + qh * 0.75);
            const TR = avgColor(ctx, mx + qw * 0.25, top + qh * 0.25, mx + qw * 0.75, top + qh * 0.75);
            const BL = avgColor(ctx, left + qw * 0.25, my + qh * 0.25, left + qw * 0.75, my + qh * 0.75);
            const BR = avgColor(ctx, mx + qw * 0.25, my + qh * 0.25, mx + qw * 0.75, my + qh * 0.75);
            assert(near(TL, [220, 20, 20]), `p${pageNo} TL red, got ${TL}`);
            assert(near(TR, [20, 180, 20]), `p${pageNo} TR green, got ${TR}`);
            assert(near(BL, [20, 20, 220]), `p${pageNo} BL blue, got ${BL}`);
            assert(near(BR, [230, 210, 20]), `p${pageNo} BR yellow, got ${BR}`);
            checks++;
        }
    }
    assert.strictEqual(checks, layout.imageCount, "every image visually verified");
    console.log(`render e2e ok: ${checks} image(s) render with correct colours/orientation/position. Pages written to ${outDir}`);
})().catch((e) => {
    console.error("render e2e FAILED:", e.message);
    process.exit(1);
});
