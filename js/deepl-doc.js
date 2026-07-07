// DeepL document translation (layout-preserving).
//
// When a DeepL API key is configured (Options), whole PDFs are translated by
// DeepL's document endpoint, which returns a translated PDF with the original
// layout, columns, fonts and images intact — the most faithful path. This runs
// in the background service worker (host permissions cover api[-free].deepl.com).
//
// Flow: POST /v2/document (upload) -> poll /v2/document/{id} (status) ->
// POST /v2/document/{id}/result (download translated bytes).

(function () {
    "use strict";

    // Free API keys end in ":fx" and must use the free host.
    function endpointFor(key) {
        return key && String(key).trim().endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }
    async function safeText(r) {
        try { return await r.text(); } catch { return ""; }
    }

    // fetchImpl/sleepImpl are injectable for testing.
    async function translateDocumentViaApi(opts) {
        const {
            bytes, filename, targetLang, sourceLang, key,
            onStatus, signal,
            fetchImpl = fetch, sleepImpl = sleep, maxPolls = 240,
        } = opts;
        if (!key) throw new Error("No DeepL API key configured.");
        if (!bytes || !bytes.length) throw new Error("No document bytes to translate.");

        const base = endpointFor(key);
        const auth = { Authorization: "DeepL-Auth-Key " + String(key).trim() };

        // 1) Upload.
        const fd = new FormData();
        fd.append("target_lang", String(targetLang || "EN-US").toUpperCase());
        if (sourceLang) fd.append("source_lang", String(sourceLang).toUpperCase());
        fd.append("file", new Blob([bytes], { type: "application/pdf" }), filename || "document.pdf");
        const up = await fetchImpl(base + "/v2/document", { method: "POST", headers: auth, body: fd, signal });
        if (!up.ok) {
            const t = await safeText(up);
            if (up.status === 403) throw new Error("DeepL rejected the API key (403). Check the key in Settings.");
            if (up.status === 456) throw new Error("DeepL quota exceeded (456). Character limit reached for this key.");
            throw new Error("Document upload failed (" + up.status + "). " + t.slice(0, 200));
        }
        const { document_id, document_key } = await up.json();
        if (!document_id || !document_key) throw new Error("DeepL did not return a document handle.");

        // 2) Poll status.
        const jsonAuth = { "Content-Type": "application/json", ...auth };
        let polls = 0;
        for (;;) {
            await sleepImpl(Math.min(6000, 1200 + polls * 400));
            const st = await fetchImpl(base + "/v2/document/" + document_id, {
                method: "POST", headers: jsonAuth, body: JSON.stringify({ document_key }), signal,
            });
            if (!st.ok) throw new Error("Status check failed (" + st.status + ").");
            const j = await st.json();
            if (onStatus) try { onStatus(j); } catch {}
            if (j.status === "done") break;
            if (j.status === "error") throw new Error(j.message || j.error_message || "DeepL document translation failed.");
            if (++polls > maxPolls) throw new Error("Document translation timed out.");
        }

        // 3) Download result.
        const res = await fetchImpl(base + "/v2/document/" + document_id + "/result", {
            method: "POST", headers: jsonAuth, body: JSON.stringify({ document_key }), signal,
        });
        if (!res.ok) throw new Error("Downloading translated document failed (" + res.status + ").");
        return new Uint8Array(await res.arrayBuffer());
    }

    const api = { translateDocumentViaApi, endpointFor };
    if (typeof self !== "undefined") Object.assign(self, api);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
