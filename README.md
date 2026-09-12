<div align="center">
  <img src="logo.png" alt="DeepL Pro Unlimited logo" width="140" />
  <h1>DeepL Pro Unlimited</h1>
  <p><b>Translate long texts and documents with DeepL — without the length limit.</b><br/>A Manifest V3 Chrome extension that splits big texts into blocks, batch-translates them on deepl.com, and exports the result as TXT, Word, or PDF.</p>
  <p>
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
    <img alt="Chrome Extension MV3" src="https://img.shields.io/badge/Chrome%20Extension-MV3-4285F4?logo=googlechrome&logoColor=white">
    <img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black">
    <img alt="Bootstrap 5" src="https://img.shields.io/badge/Bootstrap-5-7952B3?logo=bootstrap&logoColor=white">
  </p>
</div>

---

DeepL's free translator caps how much text you can translate at once. **DeepL Pro Unlimited** works
around that limit for long content: it automatically breaks a large text into DeepL-sized blocks,
translates each block in turn, and stitches the results back together — so you can translate
articles, chapters, or whole documents in one pass and download them in the format you want.

## Features

- **Unlimited long-text translation** — automatically splits input into blocks and batch-translates
  them on deepl.com, then reassembles the full translation.
- **Document translator** — a full-page workspace (`fullpage.html`) for translating and exporting
  larger documents.
- **Multiple export formats** — download the finished translation as **TXT**, **Word (.docx)**, or
  **PDF** (via jsPDF / pdf-lib), instead of a forced auto-download.
- **Translation history** — both the source and translated text are saved with a date, so you can
  revisit an entry, re-download it in any format, or delete it.
- **Diff view** — inspect the textual differences between versions of a text.
- **PDF handling** — extract and render text from PDFs for translation.
- CJK font bundled (Noto Sans CJK) for correct rendering and export of Chinese/Japanese/Korean text.

## How it works

The extension runs a content script on `www.deepl.com` and coordinates translation from a background
service worker. Long input is chunked into blocks that fit DeepL's per-request limit, each block is
translated, and the pieces are joined back into a single document that you can review, keep in your
history, and export.

## Install (developer mode)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome or Edge.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. The extension icon appears in your toolbar — open the popup, or the full-page document translator,
   to start translating.

## Permissions

The extension requests only what it needs to translate and export: `scripting`, `downloads`,
`storage` / `unlimitedStorage`, `clipboardRead`, `cookies`, `tabs`, and `alarms`, with host access
limited to `www.deepl.com` and the DeepL API endpoints.

## Tech stack

- **Chrome Extension (Manifest V3)** — background service worker + content script
- **JavaScript**
- **Bootstrap 5** for the UI
- **jsPDF** and **pdf-lib** / **pdf.js** for PDF export and rendering
- **diff** for version comparison

## License

Released under the [MIT License](LICENSE) © 2026 Olivier Lüthy. You're free to use, modify and distribute this
software, including commercially, as long as the copyright notice and license are included.

## Author

Built by **Olivier Lüthy** — [GitHub](https://github.com/olivierluethy).
