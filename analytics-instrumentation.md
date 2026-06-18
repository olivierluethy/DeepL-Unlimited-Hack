# Popup instrumentation + uninstall pipeline

Added 2026-06. Goal: compute **action ÷ exposure** per feature. All existing event
names and property keys are preserved; changes below are additive only
(new events, or new properties on existing events). No event was renamed or removed.

## Conventions
- `surface`: `main` | `history` | `documents` | `history_details` | `global`
- `source`: control/location (`entry_row`, `bulk_bar`, `toolbar`, `header`, `details_panel`, `pending_row`, `sub_tab`)
- `format`: copy/save/export/download target — `clipboard_source` | `clipboard_translated` | `clipboard_both` | `source` | `translated` | `txt` | `word` | `pdf` | `docx` | `csv` | `json` | `md`
- `entry_count` / `selection_count` / `scope` (`all`|`selection`) where a list/selection is involved.

---

## UI element inventory

### Main tab (`popup.html` → `popup.js`)
| Element | Event | New/Existing | Notes |
|---|---|---|---|
| `#sendBtn` | `main_send_to_deepl_clicked` → `main_translation_started/completed/failed` | existing | unchanged |
| `#pasteBtn` | `main_paste_used` | existing | |
| `#copyInputBtn` | `main_copy_used` | existing **+props** | added `format:"clipboard_source"`, `surface`, `source` |
| `#clearBtn` | `main_clear_used` | existing | |
| `#magicFixBtn` | `main_magic_fix_used` | existing | |
| `#swapBtn` | `main_swap_used` | existing | restores last result to input (not a language swap) |
| `#inputText` (typing) | — | none | text entry, not instrumented (no PII) |
| `#downloadSection [data-format]` | — | none | **dead UI**: element is `d-none` and has no handler in popup.js. Left uninstrumented. |
| Tab bar `#appTabs` | `popup_tab_viewed` / `popup_tab_dwell` / `*_tab_viewed_state` | existing | exposure baseline |

> **`main_lang_changed` — not applicable.** There is no language selector in the popup; the source/target pair is controlled on the DeepL page and read from its URL (`parseDeepLLangs`). No control to bind to, so this event was intentionally not added.

### Global header
| Element | Event | New/Existing |
|---|---|---|
| `#bugBtn` | `popup_bug_report_clicked` | **new** |
| `#featureBtn` | `popup_feature_request_clicked` | **new** |

### History tab
| Element | Event | New/Existing | Notes |
|---|---|---|---|
| Tab shown | `history_tab_viewed_state` (`has_entries`, `entry_count`) | existing | exposure |
| `.details-entry` (row) | `history_entry_clicked` (`action:open_details`) | existing | navigates to details page |
| `.copy-btn-original` | `history_entry_copied` (`source:entry_row`, `format:clipboard_source`) | **new** | |
| `.copy-btn-converted` | `history_entry_copied` (`source:entry_row`, `format:clipboard_translated`) | **new** | |
| `.reuse-original` | `history_entry_reused` (`format:source`) | **new** | |
| `.reuse-converted` | `history_entry_reused` (`format:translated`) | **new** | |
| `.dropdown-item[data-format]` (save) | `history_single_save_clicked` (`format`, `source`, +`surface`) | existing (already had `format`) | enriched |
| `.delete-btn` | `history_entry_deleted` | existing | |
| `.history-select-cb` (change) | `history_selection_changed` (`selection_count`) | **new** | programmatic select-all does not re-fire this |
| `#selectAllHistoryBtn` | `history_select_all_clicked` (`entry_count`, `selection_count`) | **new** | |
| `#bulkCopyBtn` | `history_bulk_copy_clicked` (+`selection_count`, `format:clipboard_translated`, `surface`, `source`) | existing **+props** | satisfies requested **`history_selection_copied`** without double-firing |
| `#bulkExportTxt` | `history_bulk_save_clicked` (`format:txt`, +`scope:selection`, `entry_count`) | existing **+props** | satisfies requested **`history_export_clicked`** |
| `#bulkExportWord` | `history_bulk_save_clicked` (`format:word`, +`scope:selection`, `entry_count`) | existing **+props** | |
| `#bulkDeleteBtn` | `history_bulk_deleted` (+`count`, `scope:selection`, `surface`, `source`) | existing **+props** | |

> **`history_search_used` — not applicable.** There is no search/filter input in the History tab.

### History details page (`history-detail.html` → `history-detail.js`, opens in its own tab)
| Element | Event | New/Existing |
|---|---|---|
| page load | `history_details_opened` | existing (exposure) |
| page hide | `history_details_closed` (`duration_ms`) | existing |
| `#reuseOriginalBtn` | `history_details_source_reused` (`format:source`) | **new** |
| `#reuseConvertedBtn` | `history_details_translation_reused` (`format:translated`) | **new** |
| `.copy-btn[data-target=*original*]` | `history_details_source_copied` (`format:clipboard_source`) | **new** |
| `.copy-btn[data-target=*translated*]` | `history_details_translation_copied` (`format:clipboard_translated`) | **new** |
| `#backBtn` | `history_details_back_clicked` | **new** |
| `#deleteBtn` | `history_entry_deleted` (`source:detail_page`) | existing |
| `.dropdown-item[data-format]` (save) | `history_single_save_clicked` (`format`, `source:detail_page`) | existing |

> These five new events are the requested **`history_details_action_*`** family (one event per distinct action; break down by event name / `format`).

### Documents tab
| Element | Event | New/Existing | Notes |
|---|---|---|---|
| `#pdf` tab shown | `documents_tab_viewed_state`, `documents_failed_state_viewed` | existing | exposure |
| `#docs-translated` sub-tab shown | `documents_translated_list_viewed` (`entry_count`, `has_entries`) | **new** | exposure for the download/delete actions (the requested **`documents_translated_viewed`**) |
| `#docs-uploaded` sub-tab shown | `documents_uploaded_list_viewed` (`entry_count`, `has_entries`) | **new** | exposure |
| `#openFullPageBtn` | `documents_open_fullpage_clicked` | existing | |
| pending row `start` | `documents_start_button_clicked` | **new** | (lifecycle `documents_translation_started` still fires in background) |
| pending row `resume` | `documents_resume_button_clicked` | existing | |
| pending row `stop` | `documents_translation_stopped_by_user` (background) | existing | |
| pending row `delete` | `documents_pending_doc_deleted` | existing | |
| translated row `download` | `documents_translated_downloaded` (+`format:pdf`, `surface`) | existing **+props** | confirmed fires on the only download path (`createTranslatedPDF`) |
| translated row `delete` | `documents_translated_deleted` | existing | |

> **`documents_translated_copied` — not applicable in the popup.** The translated-docs list exposes only download + delete; copying translated text happens in History / details, which is instrumented there.

---

## Uninstall pipeline

### How it works
1. `background.js → updateUninstallURL()` builds
   `https://<gh-pages>/uninstall.html?d=<distinct_id>&v=<version>&mc=<main_completed>&dc=<docs_completed>`
   using `self.analytics.getDistinctId()` (the **exact** id stored in
   `chrome.storage.local["analytics_distinct_id"]` and reported on every PostHog event),
   and calls `chrome.runtime.setUninstallURL(url)`.
   - Called at SW startup (top-level), on `onStartup`, and on `onInstalled`, so the
     embedded id is never empty/stale. URL is capped at ~1 KB (drops `mc`/`dc` if needed);
     falls back to the bare Google Form if anything throws.
2. On uninstall Chrome opens `uninstall.html`, which reads `d/v/mc/dc`, fires
   `extension_uninstalled` to PostHog `/e/` via `navigator.sendBeacon` (keepalive `fetch`
   fallback) **using that same `distinct_id`**, shows a loading screen, and redirects to
   the survey after delivery or a 1.5 s ceiling.

### `extension_uninstalled` properties
`distinct_id`, `extension_version`, `main_translations_completed`, `documents_completed`,
`$lib:"uninstall-page"`, `browser_language`, `$current_url`.

### Setup notes
- **`// FILL IN` markers**: `uninstall.html` (PostHog public key, PostHog host, Google Form URL — public key/host are pre-filled from `analytics.js`, verify before publish) and `background.js → updateUninstallURL()` (`UNINSTALL_PAGE_URL` = your GitHub Pages URL).
- **Enable GitHub Pages**: push `uninstall.html` to a public repo → Settings → Pages → Source = `main` / root (or `/docs`) → Save. Final URL: `https://<user>.github.io/<repo>/uninstall.html`. Put that exact URL in `UNINSTALL_PAGE_URL`.
- **Public key only** — `phc_…` is a write-only ingestion key, safe in a public repo. Never put a personal/private PostHog API key in the page.
- **Privacy/store-listing reminder**: disclose the uninstall ping + survey redirect in the privacy policy and Chrome Web Store listing (an `extension_uninstalled` analytics event is sent on uninstall and the user is redirected to a feedback form).

---

## Test plan

### Popup events (DevTools console shows `📊 Tracked: <event>` from `track.js`)
1. **History row**: copy source / copy translated → one `history_entry_copied` each with correct `format`. Reuse source/translated → `history_entry_reused`. Save dropdown (each format) → `history_single_save_clicked` with that `format`. Delete → `history_entry_deleted`.
2. **History selection**: tick a checkbox → `history_selection_changed` with rising `selection_count`. Click Select all → exactly one `history_select_all_clicked` (and **no** flood of `history_selection_changed`). Bulk copy → `history_bulk_copy_clicked` w/ `selection_count`+`format`. Export TXT/Word → `history_bulk_save_clicked` w/ `scope:selection`. Bulk delete → `history_bulk_deleted` w/ `count`.
3. **Details page**: open an entry → `history_details_opened`; copy source/translation → `history_details_*_copied`; reuse → `history_details_*_reused`; Back → `history_details_back_clicked`; close tab → `history_details_closed`.
4. **Documents**: switch to Translated sub-tab → `documents_translated_list_viewed` w/ `entry_count`; download a translated doc → `documents_translated_downloaded` w/ `format:pdf`; Start a pending doc → `documents_start_button_clicked`. Switch to Uploaded → `documents_uploaded_list_viewed`.
5. **Main/global**: copy input → `main_copy_used` w/ `format`. Bug/Feature buttons → `popup_bug_report_clicked` / `popup_feature_request_clicked`.
6. Confirm each fires **once** per intent (no double-fire), and existing events still carry their original keys.

### Uninstall flow
1. Temporarily point `UNINSTALL_PAGE_URL` at a local/staging copy of `uninstall.html`. Reload the extension; in the SW console run `chrome.runtime.getManifest()` and verify via `chrome.runtime.setUninstallURL` was called (or log the built URL).
2. Note this profile's id: SW console → `await self.analytics.getDistinctId()`.
3. Uninstall the extension → Chrome opens `uninstall.html` → loading screen → redirect to the form.
4. In PostHog, confirm an `extension_uninstalled` event arrives with `distinct_id` **equal to** the id from step 2, stitched onto that user's earlier events; `extension_version` matches.
5. Re-test with PostHog blocked (devtools offline) → page still redirects within 1.5 s.
