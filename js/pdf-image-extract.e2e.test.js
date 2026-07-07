// End-to-end integration test for image preservation.
//
// Builds a real PDF (text + images + an image-only page) with pdf-lib, runs
// the actual extraction module against it via pdfjs-dist + node-canvas, then
// rebuilds and verifies the images survive the round-trip.
//
// Requires optional dev deps not vendored in the extension:
//   npm install pdfjs-dist@3 canvas
// If they're absent this test SKIPS (exit 0) so the default unit test still
// runs. Run:  node js/pdf-image-extract.e2e.test.js
"use strict";
const path = require("path");
const assert = require("assert");
const ROOT = __dirname;

let createCanvas, Image, pdfjsLib;
try {
    ({ createCanvas, Image } = require("canvas"));
    pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
} catch (e) {
    console.log("SKIP e2e: optional deps missing (npm install pdfjs-dist@3 canvas).");
    process.exit(0);
}

const { PDFDocument, StandardFonts } = require(path.join(ROOT, "pdf-lib.min.js"));
const { splitTranslationIntoPages, dataUrlToBytes } = require(path.join(ROOT, "doc-download.js"));

// Browser-API shims pdfjs's canvas renderer expects in node.
global.window = global;
global.document = { createElement: (t) => (t === "canvas" ? createCanvas(1, 1) : {}) };
global.Image = Image;
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.window.requestAnimationFrame = global.requestAnimationFrame;
global.window.cancelAnimationFrame = global.cancelAnimationFrame;

const { extractPdfLayout } = require(path.join(ROOT, "pdf-image-extract.js"));

const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAlXwMKX0eGGQAAAABJRU5ErkJggg==";

async function buildSourcePdf() {
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(Uint8Array.from(atob(RED_PNG), (c) => c.charCodeAt(0)));
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595, 842]);
    p1.drawText("Page one original text.", { x: 50, y: 800, size: 14, font });
    p1.drawImage(png, { x: 100, y: 500, width: 120, height: 90 }); // 2 images on one page
    p1.drawImage(png, { x: 300, y: 200, width: 80, height: 200 });
    const p2 = doc.addPage([400, 300]);
    p2.drawImage(png, { x: 0, y: 0, width: 400, height: 300 }); // image-only / scanned-like page
    const p3 = doc.addPage([595, 842]);
    p3.drawText("Page three original text.", { x: 50, y: 800, size: 14, font });
    return doc.save();
}

(async () => {
    const src = await buildSourcePdf();
    const ab = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
    const { layout, text } = await extractPdfLayout(pdfjsLib, ab);

    // Extraction: exact counts, positions, image-only detection.
    assert.strictEqual(layout.imageCount, 3, "total images 2+1+0");
    assert.strictEqual(layout.pages[0].images.length, 2, "page 1 has two images");
    assert.strictEqual(layout.pages[1].images.length, 1, "page 2 has one image");
    assert.strictEqual(layout.pages[1].hasText, false, "page 2 is image-only");
    assert.strictEqual(layout.pages[2].images.length, 0, "page 3 has no images");
    const a = layout.pages[0].images.find((im) => Math.abs(im.x - 100) < 3);
    assert(a && Math.abs(a.y - 500) < 3 && Math.abs(a.w - 120) < 3 && Math.abs(a.h - 90) < 3, "image A at exact coords");
    assert(text.includes("Page one") && text.includes("Page three"), "text preserved");

    // Split + rebuild + verify.
    const translated = "Seite eins uebersetzt.\n\nSeite drei uebersetzt.";
    const perPage = splitTranslationIntoPages(translated, layout);
    assert.deepStrictEqual(perPage, ["Seite eins uebersetzt.", "", "Seite drei uebersetzt."], "per-page split");

    const out = await PDFDocument.create();
    const font = await out.embedFont(StandardFonts.Helvetica);
    let embedded = 0;
    for (let i = 0; i < layout.pages.length; i++) {
        const s = layout.pages[i];
        const pg = out.addPage([s.width, s.height]);
        for (const img of s.images) {
            pg.drawImage(await out.embedPng(dataUrlToBytes(img.png)), { x: img.x, y: img.y, width: img.w, height: img.h });
            embedded++;
        }
        if (perPage[i]) pg.drawText(perPage[i], { x: 50, y: s.height - 50, size: 12, font });
    }
    const outBytes = await out.save();
    const reload = await PDFDocument.load(outBytes);
    const xobjects = (Buffer.from(outBytes).toString("latin1").match(/\/Subtype\s*\/Image/g) || []).length;

    assert.strictEqual(embedded, layout.imageCount, "all images re-embedded");
    assert(xobjects >= layout.imageCount, "output PDF contains image XObjects");
    assert.strictEqual(reload.getPageCount(), 3, "page count preserved");
    assert.strictEqual(reload.getPage(1).getSize().width, 400, "page 2 kept its size");

    console.log("e2e ok: extracted", layout.imageCount, "images, re-embedded", embedded, "verified", xobjects, "XObjects across", reload.getPageCount(), "pages.");
})().catch((e) => {
    console.error("e2e FAILED:", e.message);
    process.exit(1);
});
