/**
 * docx-utils.js
 *
 * Generates valid Office Open XML (.docx) files entirely in the browser.
 *
 * WHY THE OLD APPROACH BROKE IN WORD:
 * A .docx file is a ZIP archive containing XML files (OOXML spec).
 * The previous code wrote an HTML string to a file named ".docx".
 * LibreOffice is lenient and opens HTML despite the wrong extension.
 * Microsoft Word strictly validates the ZIP/OOXML structure and refuses
 * to open any file that isn't a real ZIP — hence "unreadable content".
 *
 * HOW THIS WORKS:
 * 1. Build minimal but fully spec-compliant OOXML XML strings.
 * 2. Pack them into a real ZIP binary (stored/uncompressed method)
 *    using only built-in browser APIs — no external library needed.
 * 3. Return a Blob with the correct MIME type.
 */

(function (global) {
  "use strict";

  // ─── CRC-32 lookup table (required by the ZIP format) ───────────────────────
  const CRC32_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC32_TABLE[i] = c;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // ─── Minimal ZIP builder (stored / no compression) ──────────────────────────
  // A ZIP with uncompressed files is trivial to build — no DEFLATE needed.
  // The format is: [local entry × N] [central directory × N] [EOCD record]
  function buildZip(files) {
    const enc = new TextEncoder();

    // Pre-encode every file so we have byte-lengths and CRCs up front
    const entries = files.map((f) => {
      const nameBytes = enc.encode(f.name);
      const dataBytes = enc.encode(f.content);
      return { nameBytes, dataBytes, crc: crc32(dataBytes) };
    });

    // ── Local file headers + data ──
    const localParts = [];
    const offsets = [];
    let pos = 0;

    for (const e of entries) {
      offsets.push(pos);

      const hdr = new Uint8Array(30 + e.nameBytes.length);
      const dv = new DataView(hdr.buffer);
      dv.setUint32(0, 0x04034b50, true);          // local file header signature
      dv.setUint16(4, 20, true);                    // version needed to extract (2.0)
      dv.setUint16(6, 0, true);                     // general purpose bit flag
      dv.setUint16(8, 0, true);                     // compression method: stored (0)
      dv.setUint16(10, 0, true);                    // last mod file time
      dv.setUint16(12, 0, true);                    // last mod file date
      dv.setUint32(14, e.crc, true);                // CRC-32
      dv.setUint32(18, e.dataBytes.length, true);   // compressed size
      dv.setUint32(22, e.dataBytes.length, true);   // uncompressed size
      dv.setUint16(26, e.nameBytes.length, true);   // file name length
      dv.setUint16(28, 0, true);                    // extra field length
      hdr.set(e.nameBytes, 30);

      localParts.push(hdr, e.dataBytes);
      pos += hdr.length + e.dataBytes.length;
    }

    // ── Central directory records ──
    const centralParts = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const rec = new Uint8Array(46 + e.nameBytes.length);
      const dv = new DataView(rec.buffer);
      dv.setUint32(0, 0x02014b50, true);           // central dir file header signature
      dv.setUint16(4, 20, true);                    // version made by
      dv.setUint16(6, 20, true);                    // version needed
      dv.setUint16(8, 0, true);                     // general purpose bit flag
      dv.setUint16(10, 0, true);                    // compression method: stored
      dv.setUint16(12, 0, true);                    // last mod file time
      dv.setUint16(14, 0, true);                    // last mod file date
      dv.setUint32(16, e.crc, true);                // CRC-32
      dv.setUint32(20, e.dataBytes.length, true);   // compressed size
      dv.setUint32(24, e.dataBytes.length, true);   // uncompressed size
      dv.setUint16(28, e.nameBytes.length, true);   // file name length
      dv.setUint16(30, 0, true);                    // extra field length
      dv.setUint16(32, 0, true);                    // file comment length
      dv.setUint16(34, 0, true);                    // disk number start
      dv.setUint16(36, 0, true);                    // internal file attributes
      dv.setUint32(38, 0, true);                    // external file attributes
      dv.setUint32(42, offsets[i], true);           // relative offset of local header
      rec.set(e.nameBytes, 46);
      centralParts.push(rec);
    }

    // ── End of central directory record ──
    const centralSize = centralParts.reduce((s, r) => s + r.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);              // EOCD signature
    ev.setUint16(4, 0, true);                        // disk number
    ev.setUint16(6, 0, true);                        // disk where central dir starts
    ev.setUint16(8, entries.length, true);            // number of entries on this disk
    ev.setUint16(10, entries.length, true);           // total number of entries
    ev.setUint32(12, centralSize, true);              // size of central directory
    ev.setUint32(16, pos, true);                      // offset of central directory
    ev.setUint16(20, 0, true);                        // comment length

    // ── Concatenate everything into one Uint8Array ──
    const allParts = [...localParts, ...centralParts, eocd];
    const totalLen = allParts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(totalLen);
    let writePos = 0;
    for (const p of allParts) {
      out.set(p, writePos);
      writePos += p.length;
    }
    return out;
  }

  // ─── XML escaping ────────────────────────────────────────────────────────────
  function xmlEscape(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  // ─── OOXML helpers ───────────────────────────────────────────────────────────
  function makeParagraph(line) {
    // Empty lines become empty paragraphs (preserves blank-line spacing in Word)
    if (!line) return "<w:p/>";
    return (
      '<w:p><w:r><w:t xml:space="preserve">' +
      xmlEscape(line) +
      "</w:t></w:r></w:p>"
    );
  }

  function makeHeading(text, level) {
    // Uses built-in Word heading styles (Heading1 / Heading2)
    const style = "Heading" + level;
    return (
      '<w:p><w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' +
      '<w:r><w:t xml:space="preserve">' +
      xmlEscape(text) +
      "</w:t></w:r></w:p>"
    );
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * buildDocxBlob(text)
   * Creates a valid .docx Blob from a single plain-text string.
   * Each newline becomes a new paragraph in Word.
   *
   * @param {string} text
   * @returns {Blob}
   */
  function buildDocxBlob(text) {
    const paragraphs = text.split("\n").map(makeParagraph).join("");
    return _makeBlob(paragraphs);
  }

  /**
   * buildMultiDocxBlob(entries)
   * Creates a valid .docx Blob from multiple translated entries.
   * Each entry gets a numbered heading followed by its translated text.
   *
   * @param {Array<{timestamp: string, translated: string}>} entries
   * @returns {Blob}
   */
  function buildMultiDocxBlob(entries) {
    const body = entries
      .map((e, i) => {
        const date = new Date(e.timestamp).toLocaleString();
        const heading = makeHeading("[" + (i + 1) + "]  " + date, 2);
        const paragraphs = e.translated.split("\n").map(makeParagraph).join("");
        return heading + paragraphs + "<w:p/>";   // blank line between entries
      })
      .join("");
    return _makeBlob(body);
  }

  // ── Internal: assemble OOXML files and return Blob ──────────────────────────
  function _makeBlob(bodyXml) {
    const files = [
      {
        name: "[Content_Types].xml",
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml"' +
          ' ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          "</Types>",
      },
      {
        name: "_rels/.rels",
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1"' +
          ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"' +
          ' Target="word/document.xml"/>' +
          "</Relationships>",
      },
      {
        name: "word/_rels/document.xml.rels",
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          "</Relationships>",
      },
      {
        name: "word/document.xml",
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          "<w:body>" +
          bodyXml +
          "<w:sectPr/>" +
          "</w:body>" +
          "</w:document>",
      },
    ];

    return new Blob([buildZip(files)], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  }

  // Expose on the global object so popup.js and history-detail.js can call it
  global.buildDocxBlob = buildDocxBlob;
  global.buildMultiDocxBlob = buildMultiDocxBlob;
})(typeof globalThis !== "undefined" ? globalThis : window);
