# Tracking Events Reference — DeepL Pro Unlimited

**Stand:** 2026-05-07 (nach Phase 2/3 Implementation)
**Branch:** `main`

This is the canonical list of every PostHog event the extension emits, what triggers it, what properties it carries, and what business question it answers.

---

## Base properties on every event

Every event automatically carries (injected by `track.js` / `analytics.js`):

| Property | Source | Notes |
|---|---|---|
| `tab_context` | `track.js` from `location.pathname` | One of: `popup`, `documents_fullpage`, `history_detail`, `options`, `upload_page`, `unknown`. |
| `popup_session_id` | `track.js`, generated per popup mount | **Only on events from `popup.html`.** Format: `ps-<base36>-<random>`. Lets you group all events from one popup-open. fullpage and history-detail have no `popup_session_id` (different surface). |
| `distinct_id` | `analytics.js` (PostHog), persistent per install | User-scope identity. Kept stable across browser restarts. |
| `extension_version` | `analytics.js`, from manifest | e.g. `1.1.0` |
| `browser_language` | `analytics.js`, from `navigator.language` | |
| `$lib` | `analytics.js` | Always `chrome-extension`. |

For SW-side events (`background.js` → `self.analytics.capture`), the `tab_context` and `popup_session_id` are **not** added — those are page-side concepts. SW events carry the same `distinct_id`, `extension_version`, and `browser_language`.

---

## App-level events (not bereich-specific)

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `popup_opened` | popup.html DOMContentLoaded | – | Tagesaktive Popup-Öffnungen. Baseline für jeden Funnel. |
| `popup_tab_viewed` | Bootstrap `shown.bs.tab` auf einem Tab | `tab` (`main`/`loop`/`history`/`pdf`) | Tab-Switch-Counts. Pairs mit den `<bereich>_tab_viewed_state` Events für reichere Analyse. |
| `settings_opened` | `#settingsBtn` click | – | Wie oft öffnen User die Settings? |
| `extension_installed` | `chrome.runtime.onInstalled` reason `install` | `version` | Install-Funnel. |
| `extension_updated` | `chrome.runtime.onInstalled` reason `update` | `from`, `to` | Versions-Migration tracken. |

---

## Loop / Batch Tab

Frage, die diese Events beantworten: "Wird der Batch-Tab überhaupt sinnvoll genutzt, oder können wir ihn entfernen?"

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `loop_tab_viewed_state` | `#loop` Tab-Switch | `has_entries` (bool), `entry_count` (int), `total_subentries` (int). **Feuert immer, auch bei 0/0.** | Empty-State-Conversion: wie viele User sehen einen leeren Tab und springen ab? |
| `loop_group_created` | `#addLoop` click (mit nicht-leerem Input) | `entry_count_after` (int) | Erste konkrete Aktion. |
| `loop_subentry_added` | `.addSubEntry` click → `addSubEntryFromInput` ODER `handleMultiPaste` | `method` (`single` / `multi_paste` / `multi_paste_declined`), `count` (int) | Single vs Multi-Paste Verhältnis. `multi_paste_declined` = User hat im Confirm "Cancel" gedrückt. |
| `loop_subentry_edited` | `saveEditText` (sub) | `char_count_bucket` | Wie oft werden Subentries editiert? |
| `loop_group_edited` | `saveEditText` (entry) | `char_count_bucket` | Wie oft werden Group-Names editiert? |
| `loop_subentry_deleted` | `deleteEntry` (sub) | – | |
| `loop_group_deleted` | `deleteEntry` (entry) | – | |
| `loop_group_reordered` | Sortable.js onEnd, nur wenn `oldIndex !== newIndex` | – | Wird Drag&Drop wirklich genutzt? |
| `loop_subentry_reordered` | Sortable.js onEnd, nur wenn `oldIndex !== newIndex` | – | Dito für Sub-Entries. |
| `loop_start_clicked` | Erste Zeile in `startGroupTranslation`, **vor** allen Validierungen | `iteration_count` (int) | Capture-all für Start-Klicks, inkl. Aborts. |
| `loop_aborted` | Branches die einen Run frühzeitig oder mid-run beenden | `reason` (`deepl_not_open` / `no_entries` / `deepl_lost_during_run` / `user_stopped`), `iteration_count`, `iterations_completed` (nur deepl_lost_during_run) | Granular: warum bricht ein Run ab? |
| `loop_run_started` | Nach Validierung, vor Schleifen-Loop | `iteration_count` | Run-State-Event (paart mit cancelled/failed/completed). |
| `loop_run_completed` | End-of-Loop ohne Fehler | `iteration_count`, `iterations_completed`, `iterations_failed`, `duration_ms` | |
| `loop_run_failed` | Mind. 1 Iteration failed (oder outer catch) | `iteration_count`, `iterations_completed`, `iterations_failed`, `duration_ms`, `error_type` (nur outer catch) | |
| `loop_run_cancelled` | `stopTranslation === true` am Ende | (gleiche Properties) | |
| `loop_copy_used` | `.copySubEntry` click | `char_count_bucket` | Wird der Copy-Button im Sub-Input wirklich gebraucht? |
| `loop_paste_used` | `.pasteSubEntry` click | `char_count_bucket` | |
| `loop_clear_used` | `.clearSubEntry` click | `char_count_bucket` | |

> **Doppel-Event-Hinweis:** Wenn der User auf STOP klickt, feuern **beide** `loop_aborted` (reason: `user_stopped`) **und** `loop_run_cancelled`. Sie sind komplementär — `loop_aborted` ist das User-Intent-Signal, `loop_run_cancelled` ist der Run-State. Für eindeutige Stop-Counts → `loop_aborted`. Für "Runs die im cancelled-State endeten" → `loop_run_cancelled`.

---

## Main Tab

Frage: "In welcher Konstellation/Sequenz werden die Buttons verwendet? Welche Buttons sind überflüssig?"

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `main_paste_used` | `#pasteBtn` click (auf beiden navigator.clipboard.readText paths) | `char_count_bucket`, `had_text` (bool) | |
| `main_copy_used` | `#copyInputBtn` click (nur wenn Input nicht leer) | `target` (`input` heute, `output` reserviert), `char_count_bucket` | |
| `main_clear_used` | `#clearBtn` click | `target` (`input`), `char_count_bucket` (vor Clear) | |
| `main_magic_fix_used` | `#magicFixBtn` click | `char_count_bucket_pre`, `char_count_bucket_post`, `chars_removed_bucket` | Misst tatsächlichen Effekt: räumt Magic Fix wirklich auf? |
| `main_swap_used` | `#swapBtn` click | `had_input` (bool), `had_output` (bool, true wenn verlauf nicht leer) | Sehen wir unsinnige Swaps (had_output: false)? |
| `main_send_to_deepl_clicked` | Erste Zeile `sendBtn` click, **vor** allen Validierungen | `char_count_bucket`, `has_text`, `trigger` (`button` heute) | Capture-all für Send-Intentions. |
| `main_send_aborted` | Send-Click der wegen non-DeepL-Tab abgebrochen wird | `reason` (`deepl_not_open`), `char_count_bucket` | Empty-Input-Aborts werden NICHT separat getrackt — `main_send_to_deepl_clicked.has_text === false` reicht. |
| `main_translation_started` | Nach allen Pre-Checks | `char_count_bucket` | Run-State. |
| `main_translation_completed` | Erfolgreicher Completion-Signal | `char_count_bucket`, `duration_ms` | |
| `main_translation_failed` | Catch-Branch | `char_count_bucket`, `error_type` (`timeout` / `rate_limited` / `network` / `other`), `duration_ms` | |
| `main_session_summary` | Tab-Switch weg von #main ODER popup `pagehide` | `actions_used` (sortiertes Array, Members: `paste`, `copy`, `clear`, `magic_fix`, `swap`, `send`), `action_count` (int) | Aggregierte Sequenz pro Popup-Open. **Feuert nur wenn ≥1 Action.** |

> **popup_session_id**: Jedes Main-Event trägt automatisch `popup_session_id` (siehe Base-Properties). Damit kannst Du in PostHog Sequenzen wie `paste → magic_fix → send → copy` als gemeinsame Session sehen — auch ohne `main_session_summary` abzuwarten.

---

## History Tab

Fragen: "Wird die Details-Seite überhaupt geöffnet? Welche Save-Option wird am meisten genutzt? Sind es zu viele?"

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `history_tab_viewed_state` | `#history` Tab-Switch | `has_entries` (bool), `entry_count` (int). **Feuert immer.** | Empty-State + Tab-Open-Häufigkeit. |
| `history_entry_clicked` | `.details-entry` click in popup | `action` (`open_details`) | Heute nur 1 Action; Property zukunftsfest. |
| `history_details_opened` | history-detail.html DOMContentLoaded | – | |
| `history_details_closed` | history-detail.html `pagehide` | `duration_ms` | Lesen User Details (>5s) oder schließen sie sofort? |
| `history_single_save_clicked` | Single-Entry-Dropdown click in popup ODER auf history-detail.html | `format` (Werte unten), `source` (`popup` / `detail_page`) | **Welche Formate werden gebraucht?** |
| `history_bulk_copy_clicked` | `#bulkCopyBtn` click | `entry_count`, `char_count_bucket` | |
| `history_bulk_save_clicked` | `#bulkExportTxt` / `#bulkExportWord` click | `format` (Werte unten), `entry_count` | |
| `history_entry_deleted` | Single-Row Del-Button in popup ODER `#deleteBtn` auf detail page | `source` (`popup` / `detail_page`) | |
| `history_bulk_deleted` | `#bulkDeleteBtn` click (nach confirm) | `entry_count` | |

### Allowed `format` values

| Event | Allowed values | Wo verwendet |
|---|---|---|
| `history_single_save_clicked` (source=`popup`) | `txt`, `word`, `pdf`, `md`, `json`, `csv` | popup.js Dropdown — siehe popup.html:709-715 |
| `history_single_save_clicked` (source=`detail_page`) | `txt`, `word`, `pdf`, `md`, `json`, `csv` | history-detail.html:284-290 (identisch) |
| `history_bulk_save_clicked` | `txt`, `word` | popup.html:585-592 — nur diese zwei. Pro Klick **genau ein** Format, keine Mehrfachauswahl. |

> Reuse-Original / Reuse-Converted und die View-Tabs auf der Detailseite (Differences / Side-by-Side / Original Only / Converted Only) sind **nicht** instrumentiert — bewusst out-of-scope. Falls relevant, später als `history_reuse_clicked` und `history_detail_view_changed` ergänzen.

---

## Documents Tab

Fragen: "Welcher Dateityp wird am meisten verwendet? Wie oft müssen User die Übersetzung fortsetzen? Wissen sie, dass Reload das Problem löst?"

### Popup-side (popup.js)

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `documents_tab_viewed_state` | `#pdf` Tab-Switch | `has_pending_translation` (bool), `pending_count`, `pending_file_types` (sorted unique array), `has_failed_state` (bool), `failed_count` | Tab-Health-Check. |
| `documents_failed_state_viewed` | Tab-Switch UND ≥1 paused/error Doc | `pending_status` (`paused`/`error` vom most-recent Doc), `pending_file_type`, `paused_count`, `error_count`, `pending_count_total` | "Sieht der User Failed-State?" — pairs mit `documents_page_reloaded_during_translation` für UX-Gap-Analyse. **Genau 1 Event pro Tab-Open**, nicht pro Doc. |
| `documents_open_fullpage_clicked` | `#openFullPageBtn` click | `reopened` (bool — true wenn fullpage-Tab schon existiert) | |
| `documents_resume_button_clicked` | `[data-doc-action="resume"]` click | – | Click-Intent. Pairs mit `documents_translation_resumed` (SW). |
| `documents_pending_doc_deleted` | `[data-doc-action="delete"]` click | – | |

### Fullpage-side (fullpage.js)

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `documents_file_selected` | Drop ODER File-Picker change ODER `upload-page.html` (legacy) | `file_type` (`pdf`/`excel`/`pptx`/`docx`-legacy), `file_size_bucket` (siehe unten), `source` (`fullpage` / `upload_page` / `drop_zone`) | **Welcher Dateityp wird am meisten verwendet?** |
| `documents_file_rejected` | Drop oder Picker mit unsupported file type | `reason` (`unsupported_file_type`), `mime_type`, `file_size_bucket`, `source` (`drop_zone` only on drop, fullpage on picker) | |
| `documents_extraction_completed` | Erfolgreiche Text-Extraktion | `file_type`, `page_count`, `total_char_count_bucket` | |
| `documents_extraction_failed` | Catch-Branch in `handleFileSelected` | `file_type`, `file_size_bucket`, `error_class` (`library_missing` / `pptx_no_slides` / `parse_error`) | |
| `documents_page_reloaded_during_translation` | DOMContentLoaded UND ≥1 paused/error Doc | `pending_status`, `pending_file_type`, `paused_count`, `error_count`, `pending_count_total`, `time_since_failure_ms` | Implizites "User reloaded um zu resumen". |

### SW-side (background.js)

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `documents_translation_started` | `START_DOC` Message → `startDocumentTranslation` (resume=false) | `run_id` (UUID), `file_type`, `page_count`, `batch_count`, `total_char_count_bucket` | |
| `documents_translation_resumed` | `RESUME_DOC` Message → `startDocumentTranslation` (resume=true) | `run_id`, `file_type`, `page_count`, `batch_count`, `total_char_count_bucket`, `resume_trigger` (`explicit_button` / `auto_on_load` reserved), `time_since_failure_ms`, `previous_status` | **`resume_trigger`** ist heute immer `explicit_button` — `auto_on_load` ist reserviert für eine zukünftige Auto-Resume-Funktion (heute nicht implementiert; siehe Implementations-Hinweis unten). |
| `documents_translation_completed` | End-of-Loop ohne Fehler | `run_id`, `file_type`, `batch_count`, `batches_total`, `total_char_count_bucket`, `duration_ms` | |
| `documents_translation_failed` | Pause-Path mit Fehler-Reason ODER no-DeepL-tab ODER outer catch | `run_id`, `file_type`, `error_type` (`no_deepl_tab` / `char_limit` / `timeout` / `dom` / `network` / `rate_limited` / `other` / `batch_failed`), `batches_completed`, `batches_total`, `duration_ms` | |
| `documents_translation_stopped_by_user` | `STOP_DOC` Message | `run_id` | |

### Allowed `file_type` values

`pdf`, `excel`, `pptx`. Plus from the **legacy** upload-page surface (`upload.js`): `docx` (mammoth.js path — currently broken, see audit). New uploads via fullpage do not produce `docx`.

### Allowed `file_size_bucket` values

Canonical (from `track.js#bucketFileSize`): `<1MB`, `1-5MB`, `5-20MB`, `>20MB`.

> ⚠ **Legacy Bucket-Schema**: `upload.js` (the alte upload-page surface) emits `documents_file_selected` with a different bucket scheme (`0-50k`, `50k-250k`, `250k-1m`, `1m-5m`, `5m+`). This is intentional — kept for backward comparability of pre-existing rows. Filter by `source === "fullpage"` to compare apples to apples; `source === "upload_page"` rows use the legacy buckets.

### `resume_trigger` — implementierter Zustand

| Wert | Bedeutung | Status |
|---|---|---|
| `explicit_button` | User hat aktiv den Resume-Button im Popup gedrückt. | **Heute der einzige Pfad.** |
| `auto_on_load` | Auto-Resume beim Tab-Öffnen oder ähnlich. | **Reserviert, heute nie gesetzt.** Falls ein Auto-Resume-Feature kommt: dann hier verwenden, kein Property-Schema-Bruch. |

---

## char_count_bucket Werte

Mirror in `track.js#bucketChars` und `background.js#bucketChars`:

| Bucket | Range |
|---|---|
| `0-500` | n < 500 |
| `500-2k` | 500 ≤ n < 2000 |
| `2k-5k` | 2000 ≤ n < 5000 |
| `5k-10k` | 5000 ≤ n < 10000 |
| `10k-25k` | 10000 ≤ n < 25000 |
| `25k+` | n ≥ 25000 |

---

## Migration / Vorher → Nachher (für Dashboards)

| Alter Name | Neuer Name | Datei |
|---|---|---|
| `result_copied` (target=`input`) | `main_copy_used` | popup.js |
| `result_copied` (target=`history_bulk`) | `history_bulk_copy_clicked` | popup.js |
| `translation_started` (trigger=`popup_main`) | `main_translation_started` | popup.js |
| `translation_completed` (trigger=`popup_main`) | `main_translation_completed` | popup.js |
| `translation_failed` (trigger=`popup_main`) | `main_translation_failed` | popup.js |
| `swap_used` | `main_swap_used` | popup.js |
| `magic_fix_used` | `main_magic_fix_used` | popup.js |
| `document_uploaded` | `documents_file_selected` (source=`upload_page`) | upload.js |
| `document_translation_started` | `documents_translation_started` | background.js |
| `document_translation_resumed` | `documents_translation_resumed` | background.js |
| `document_translation_completed` | `documents_translation_completed` | background.js |
| `document_translation_failed` | `documents_translation_failed` | background.js |
| `document_translation_stopped_by_user` | `documents_translation_stopped_by_user` | background.js |

> **Property-Renames**: `result_copied.count` (legacy bulk) → `history_bulk_copy_clicked.entry_count`. `document_uploaded.size_bucket` → `documents_file_selected.file_size_bucket`.

---

## Bekannte Limitierungen / Datenwarnungen

1. **Pre-fix `error_type: "char_limit"` Daten sind biased.** content.js:574 hat vor diesem Commit-Set jeden silent-empty Timeout als `char_limit` getaggt. PostHog `documents_translation_failed.error_type` Counts vor dem fix-Commit (siehe Git: `feat(tracking): documents tab events + fix content.js timeout/char_limit tautology`) sind eine Mischung aus echten Paywall-Hits und echten Timeouts.
2. **Legacy upload-page** (`upload.js` / `upload-page.html`) feuert `documents_file_selected` mit alten size_bucket-Werten. Filter via `source === "upload_page"` zum Trennen.
3. **Reuse / View-Tabs auf history-detail** sind nicht getrackt. Falls relevant: Bonus-Commit.
4. **`main_session_summary` kann unter Last verloren gehen.** Pagehide-Hooks im Chrome MV3 popup sind nicht 100% zuverlässig. Treat counts als Lower-Bound.
5. **Doppelte Stop-Events bei Loop**: `loop_aborted` (reason=user_stopped) UND `loop_run_cancelled` feuern beide. Siehe Hinweis im Loop-Block.

---

**Ende der Event-Reference. Letzte Änderung: 2026-05-07.**
