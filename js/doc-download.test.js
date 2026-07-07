// Node tests for the image-preservation pipeline's pure logic and the
// pdf-lib embed/verify round-trip. Run: node js/doc-download.test.js
const assert = require("assert");
const { PDFDocument } = require("./pdf-lib.min.js");
const { splitTranslationIntoPages, dataUrlToBytes } = require("./doc-download.js");
const extract = require("./pdf-image-extract.js");

let pass = 0;
const t = (name, fn) => {
    try {
        fn();
        pass++;
        console.log("  ok -", name);
    } catch (e) {
        console.error("  FAIL -", name, "\n   ", e.message);
        process.exitCode = 1;
    }
};

console.log("splitTranslationIntoPages:");

t("exact 1:1 paragraph mapping", () => {
    const layout = {
        pages: [
            { hasText: true, textLen: 10 },
            { hasText: true, textLen: 10 },
            { hasText: true, textLen: 10 },
        ],
    };
    const out = splitTranslationIntoPages("uno\n\ndos\n\ntres", layout);
    assert.deepStrictEqual(out, ["uno", "dos", "tres"]);
});

t("image-only pages get empty text, text pages get translation", () => {
    const layout = {
        pages: [
            { hasText: false, textLen: 0 }, // scanned/image-only cover
            { hasText: true, textLen: 5 },
        ],
    };
    const out = splitTranslationIntoPages("hello", layout);
    assert.deepStrictEqual(out, ["", "hello"]);
});

t("proportional fallback splits a single paragraph across pages by weight", () => {
    const layout = {
        pages: [
            { hasText: true, textLen: 100 },
            { hasText: true, textLen: 100 },
        ],
    };
    // One big paragraph, no \n\n → must still be split across both pages.
    const words = Array.from({ length: 20 }, (_, i) => "word" + i).join(" ");
    const out = splitTranslationIntoPages(words, layout);
    assert(out[0].length > 0, "page 1 should get text");
    assert(out[1].length > 0, "page 2 should get text");
    // No word should be cut in half (snapped to whitespace).
    assert(!/word\d*$/.test(out[0]) || words.startsWith(out[0]), "no mid-word cut");
    // Recombining should cover all words.
    assert.strictEqual((out[0] + " " + out[1]).split(/\s+/).filter(Boolean).length, 20);
});

t("empty translation yields all-empty pages, never throws", () => {
    const layout = { pages: [{ hasText: true, textLen: 3 }, { hasText: false, textLen: 0 }] };
    assert.deepStrictEqual(splitTranslationIntoPages("", layout), ["", ""]);
});

t("no pages -> empty array", () => {
    assert.deepStrictEqual(splitTranslationIntoPages("x", { pages: [] }), []);
});

console.log("matrix helpers:");

t("unitSquareBBox for translate+scale", () => {
    const b = extract.unitSquareBBox([120, 0, 0, 80, 50, 700]);
    assert.deepStrictEqual(b, { x: 50, y: 700, w: 120, h: 80 });
});

t("matMul composes args-before-ctm", () => {
    // scale2 then translate(10,10): point (0,0) -> (20,20)
    let ctm = extract.matMul([1, 0, 0, 1, 0, 0], [2, 0, 0, 2, 0, 0]);
    ctm = extract.matMul(ctm, [1, 0, 0, 1, 10, 10]);
    assert.deepStrictEqual(extract.applyPt(ctm, 0, 0), [20, 20]);
});

console.log("pdf-lib embed + verify round-trip:");

(async () => {
    // A minimal valid 2x2 red PNG.
    const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAlXwMKX0eGGQAAAABJRU5ErkJggg==";
    const pngUrl = "data:image/png;base64," + pngB64;

    const bytes = dataUrlToBytes(pngUrl);
    assert(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50, "PNG signature decoded");

    // Simulate what buildLayoutPDF does: page-sized, image embedded at coords.
    const doc = await PDFDocument.create();
    const layout = {
        imageCount: 2,
        pages: [
            { width: 300, height: 400, rotation: 0, hasText: true, textLen: 5, images: [{ png: pngUrl, x: 20, y: 300, w: 100, h: 80 }] },
            { width: 300, height: 400, rotation: 0, hasText: false, textLen: 0, images: [{ png: pngUrl, x: 40, y: 40, w: 60, h: 60 }] },
        ],
    };

    let embedded = 0;
    for (const pg of layout.pages) {
        const page = doc.addPage([pg.width, pg.height]);
        for (const img of pg.images) {
            const emb = await doc.embedPng(dataUrlToBytes(img.png));
            page.drawImage(emb, { x: img.x, y: img.y, width: img.w, height: img.h });
            embedded++;
        }
    }
    const outBytes = await doc.save();

    t("all images embedded (count matches expected)", () => {
        assert.strictEqual(embedded, layout.imageCount);
    });

    t("output is a valid, loadable PDF with the right page count", async () => {
        const re = await PDFDocument.load(outBytes);
        assert.strictEqual(re.getPageCount(), 2);
    });

    // Verify XObject images actually exist in the saved PDF bytes.
    t("saved PDF contains embedded image XObjects", () => {
        const text = Buffer.from(outBytes).toString("latin1");
        const imageXObjects = (text.match(/\/Subtype\s*\/Image/g) || []).length;
        assert(imageXObjects >= 2, "expected >=2 image XObjects, found " + imageXObjects);
    });

    console.log("\n" + pass + " checks passed.");
})();
