// Tests the DeepL document-translation flow (upload -> poll -> result) with a
// mocked fetch, plus endpoint selection and error handling. No network, no deps.
// Run: node js/deepl-doc.test.js
"use strict";
const assert = require("assert");
// Minimal shims so the module loads in Node.
global.FormData = global.FormData || class { append() {} };
global.Blob = global.Blob || class { constructor() {} };
const { translateDocumentViaApi, endpointFor } = require("./deepl-doc.js");

let pass = 0;
const t = (n, fn) => { try { fn(); pass++; console.log("  ok -", n); } catch (e) { console.error("  FAIL -", n, "\n   ", e.message); process.exitCode = 1; } };

t("free keys use the free endpoint", () => {
    assert.strictEqual(endpointFor("abc-123:fx"), "https://api-free.deepl.com");
    assert.strictEqual(endpointFor("abc-123"), "https://api.deepl.com");
});

(async () => {
    // Mock: upload -> two status polls (translating, done) -> result bytes.
    const calls = [];
    let statusCount = 0;
    const fetchImpl = async (url) => {
        calls.push(url.replace("https://api-free.deepl.com", ""));
        if (url.endsWith("/v2/document")) return { ok: true, json: async () => ({ document_id: "DID", document_key: "DKEY" }) };
        if (url.endsWith("/result")) return { ok: true, arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer };
        statusCount++;
        return { ok: true, json: async () => ({ status: statusCount < 2 ? "translating" : "done" }) };
    };
    const statuses = [];
    const out = await translateDocumentViaApi({
        bytes: new Uint8Array([1, 2, 3]), filename: "cv.pdf", targetLang: "de", key: "k:fx",
        fetchImpl, sleepImpl: async () => {}, onStatus: (s) => statuses.push(s.status),
    });

    t("returns translated PDF bytes", () => {
        assert(out instanceof Uint8Array && out.length === 4 && out[0] === 0x25, "expected %PDF bytes");
    });
    t("polls status until done", () => {
        assert.deepStrictEqual(statuses, ["translating", "done"]);
    });
    t("uploads once and downloads the result", () => {
        assert.strictEqual(calls.filter((c) => c === "/v2/document").length, 1);
        assert(calls.includes("/v2/document/DID/result"));
    });

    t("missing key throws", async () => {
        await assert.rejects(
            translateDocumentViaApi({ bytes: new Uint8Array([1]), key: "", fetchImpl, sleepImpl: async () => {} }),
            /No DeepL API key/
        );
    });
    t("403 surfaces a key error", async () => {
        const f = async () => ({ ok: false, status: 403, text: async () => "" });
        await assert.rejects(
            translateDocumentViaApi({ bytes: new Uint8Array([1]), key: "k:fx", fetchImpl: f, sleepImpl: async () => {} }),
            /rejected the API key/
        );
    });
    t("status 'error' is surfaced", async () => {
        const f = async (url) => {
            if (url.endsWith("/v2/document")) return { ok: true, json: async () => ({ document_id: "D", document_key: "K" }) };
            return { ok: true, json: async () => ({ status: "error", message: "boom" }) };
        };
        await assert.rejects(
            translateDocumentViaApi({ bytes: new Uint8Array([1]), key: "k:fx", fetchImpl: f, sleepImpl: async () => {} }),
            /boom/
        );
    });

    console.log("\n" + pass + " checks passed.");
})();
