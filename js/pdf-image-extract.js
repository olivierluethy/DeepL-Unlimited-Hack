// PDF layout + image extraction.
//
// The translation pipeline used to extract *text only* (PDF.js
// getTextContent) and rebuild a blank text-only PDF, silently dropping every
// embedded image. This module extracts, per page, the page geometry and every
// raster image with its exact position/size, so the generator can re-embed the
// images at their original locations alongside the translated text.
//
// Images are recovered by walking the page operator list to track the current
// transformation matrix (CTM) for each image-painting op, then cropping the
// image's region out of a rendered page canvas. Cropping the *rendered* page is
// deliberately format-agnostic: JPEG, PNG, CMYK, image masks, soft masks and
// transparency are all already decoded and composited by PDF.js at render time,
// so the crop is always a valid, correctly-coloured PNG regardless of the
// original embedded format. Scanned/image-only pages, full-page backgrounds and
// multiple images per page all fall out of the same code path.
//
// Requires pdfjsLib (js/pdf.min.js) and a DOM <canvas> (extension page).

(function () {
    "use strict";

    // Render resolution for cropping. 150 DPI keeps images crisp without
    // bloating storage; per-page pixel dimensions are capped so a huge page
    // can't allocate an enormous canvas.
    const TARGET_DPI = 150;
    const MAX_PAGE_PX = 2600;

    // Total budget for stored image PNG bytes across the whole document. If a
    // document's images exceed this, extraction stops adding images and flags
    // `truncated` so the pipeline degrades gracefully and reports it instead of
    // silently dropping images.
    const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;

    // Ignore sub-pixel/degenerate image ops (spacer pixels, rules drawn as
    // 1x1 images, etc.) that aren't meaningful content.
    const MIN_IMAGE_UNITS = 3;

    // PDF affine-matrix helpers ([a,b,c,d,e,f], point maps x' = a*x + c*y + e,
    // y' = b*x + d*y + f). matMul composes so that `args` is applied *before*
    // the existing CTM, matching PDF.js's transform-op accumulation.
    function matMul(m, n) {
        return [
            m[0] * n[0] + m[2] * n[1],
            m[1] * n[0] + m[3] * n[1],
            m[0] * n[2] + m[2] * n[3],
            m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4],
            m[1] * n[4] + m[3] * n[5] + m[5],
        ];
    }
    function applyPt(m, x, y) {
        return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }

    // Bounding box of the unit square [0,1]x[0,1] mapped through matrix `m`.
    function unitSquareBBox(m) {
        const pts = [applyPt(m, 0, 0), applyPt(m, 1, 0), applyPt(m, 1, 1), applyPt(m, 0, 1)];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of pts) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    function isRotated(m) {
        // Non-negligible shear/rotation terms (b or c) mean the image is not
        // axis-aligned; we still place its axis-aligned bbox but flag it.
        return Math.abs(m[1]) > 1e-3 || Math.abs(m[2]) > 1e-3;
    }

    // Collect every image-painting op on the page with its CTM, by walking the
    // operator list and maintaining the save/restore transform stack.
    function collectImagePlacements(opList, OPS) {
        const IMAGE_OPS = new Set(
            [
                OPS.paintImageXObject,
                OPS.paintJpegXObject,
                OPS.paintImageXObjectRepeat,
                OPS.paintInlineImageXObject,
                OPS.paintImageMaskXObject,
            ].filter((v) => typeof v === "number")
        );

        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];
        const placements = [];

        for (let i = 0; i < opList.fnArray.length; i++) {
            const fn = opList.fnArray[i];
            const args = opList.argsArray[i];
            if (fn === OPS.save) {
                stack.push(ctm.slice());
            } else if (fn === OPS.restore) {
                ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
            } else if (fn === OPS.transform) {
                ctm = matMul(ctm, args);
            } else if (IMAGE_OPS.has(fn)) {
                placements.push({ ctm: ctm.slice() });
            }
        }
        return placements;
    }

    // Crop a device-space rectangle out of the rendered page canvas into a PNG
    // data URL. Returns null if the rect is empty/off-canvas.
    function cropToPng(pageCanvas, dev) {
        const cw = pageCanvas.width, ch = pageCanvas.height;
        const sx = Math.max(0, Math.floor(Math.min(dev.x0, dev.x1)));
        const sy = Math.max(0, Math.floor(Math.min(dev.y0, dev.y1)));
        const ex = Math.min(cw, Math.ceil(Math.max(dev.x0, dev.x1)));
        const ey = Math.min(ch, Math.ceil(Math.max(dev.y0, dev.y1)));
        const w = ex - sx, h = ey - sy;
        if (w < 1 || h < 1) return null;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(pageCanvas, sx, sy, w, h, 0, 0, w, h);
        return c.toDataURL("image/png");
    }

    // Rough byte size of a base64 data URL payload.
    function dataUrlBytes(url) {
        const i = url.indexOf(",");
        return i < 0 ? 0 : Math.ceil((url.length - i - 1) * 0.75);
    }

    // Extract text (matching the pipeline's existing behaviour) and the image
    // layout for every page in one pass.
    //
    // Returns:
    //   {
    //     text,        // concatenated page text, non-empty pages joined by \n\n
    //     pageCount,
    //     layout: {
    //       imageCount, truncated, anyRotated,
    //       pages: [{ index, width, height, rotation, hasText, textLen,
    //                 images: [{ png, x, y, w, h, rotated }] }]
    //     }
    //   }
    async function extractPdfLayout(pdfjsLib, arrayBuffer) {
        const OPS = pdfjsLib.OPS;
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const textParts = [];
        const pages = [];
        let imageCount = 0;
        let storedBytes = 0;
        let truncated = false;
        let anyRotated = false;

        for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
            let page;
            try {
                page = await pdf.getPage(pageNo);
            } catch (e) {
                // A page we can't even open still occupies a slot in the
                // document; record an empty placeholder so geometry/ordering
                // downstream stays aligned.
                pages.push({ index: pageNo - 1, width: 595, height: 842, rotation: 0, hasText: false, textLen: 0, images: [] });
                continue;
            }

            // Unrotated media-box dimensions — these match the coordinate
            // space of the operator-list CTM (and pdf-lib's page space).
            // Rotation is carried separately and re-applied at generation.
            const view = page.view; // [x0, y0, x1, y1]
            const pageWidth = view[2] - view[0];
            const pageHeight = view[3] - view[1];
            const rotation = ((page.rotate || 0) % 360 + 360) % 360;

            // Text (same normalisation the pipeline already used: collapse
            // whitespace, one block per page).
            let pageText = "";
            try {
                const tc = await page.getTextContent();
                pageText = tc.items
                    .map((it) => it.str)
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim();
            } catch (e) {
                pageText = "";
            }
            const hasText = !!pageText;
            if (hasText) textParts.push(pageText);

            const pageRecord = {
                index: pageNo - 1,
                width: pageWidth,
                height: pageHeight,
                rotation,
                hasText,
                textLen: pageText.length,
                images: [],
            };
            pages.push(pageRecord);

            // Images.
            try {
                const opList = await page.getOperatorList();
                const placements = collectImagePlacements(opList, OPS);
                if (placements.length && !truncated) {
                    // Render the page once at a capped resolution, then crop.
                    let scale = TARGET_DPI / 72;
                    const longest = Math.max(pageWidth, pageHeight) * scale;
                    if (longest > MAX_PAGE_PX) scale *= MAX_PAGE_PX / longest;
                    const viewport = page.getViewport({ scale });

                    const canvas = document.createElement("canvas");
                    canvas.width = Math.max(1, Math.ceil(viewport.width));
                    canvas.height = Math.max(1, Math.ceil(viewport.height));
                    const ctx = canvas.getContext("2d");
                    await page.render({ canvasContext: ctx, viewport }).promise;

                    for (const pl of placements) {
                        if (truncated) break;
                        const bbox = unitSquareBBox(pl.ctm); // PDF space, bottom-left origin
                        if (bbox.w < MIN_IMAGE_UNITS || bbox.h < MIN_IMAGE_UNITS) continue;

                        const rotated = isRotated(pl.ctm);
                        if (rotated) anyRotated = true;

                        // Map the PDF-space bbox corners into device pixels.
                        const [dx0, dy0] = applyPt(viewport.transform, bbox.x, bbox.y);
                        const [dx1, dy1] = applyPt(viewport.transform, bbox.x + bbox.w, bbox.y + bbox.h);
                        const png = cropToPng(canvas, { x0: dx0, y0: dy0, x1: dx1, y1: dy1 });
                        if (!png) continue;

                        const bytes = dataUrlBytes(png);
                        if (storedBytes + bytes > MAX_TOTAL_IMAGE_BYTES) {
                            truncated = true;
                            break;
                        }
                        storedBytes += bytes;
                        imageCount++;
                        // Clamp to page box so re-embedding never overflows.
                        const x = Math.max(0, bbox.x);
                        const y = Math.max(0, bbox.y);
                        pageRecord.images.push({
                            png,
                            x,
                            y,
                            w: Math.min(bbox.w, pageWidth - x),
                            h: Math.min(bbox.h, pageHeight - y),
                            rotated,
                        });
                    }
                    // Release the full-page canvas backing store.
                    canvas.width = canvas.height = 0;
                }
            } catch (e) {
                // Image extraction for this page failed; keep the page (text
                // still preserved) and let verification report the shortfall.
                console.warn("[pdf-image-extract] page", pageNo, "image extraction failed:", e && e.message);
            }
        }

        return {
            text: textParts.join("\n\n"),
            pageCount: pdf.numPages,
            layout: { imageCount, truncated, anyRotated, pages },
        };
    }

    if (typeof window !== "undefined") {
        window.extractPdfLayout = extractPdfLayout;
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { extractPdfLayout, matMul, applyPt, unitSquareBBox, isRotated, collectImagePlacements };
    }
})();
