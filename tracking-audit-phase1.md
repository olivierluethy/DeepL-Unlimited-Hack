# Tracking Audit — DeepL Pro Unlimited

**Stand:** 2026-05-07
**Scope:** Phase 1 — read-only Audit, kein Code geändert.
**Branch:** `main`
**Manifest-Version:** 1.1.0

---

## TL;DR

1. **Größtes strukturelles Problem:** `track.js` wird nur in `popup.html`, `options.html`, `upload-page.html` geladen. **`fullpage.html` und `history-detail.html` haben keinen `window.track` Zugriff.** Das erklärt einen Teil der Lücken im Documents-Funnel — alles, was auf der Upload-Seite passiert (Drag & Drop, File-Pick, Extraktionsfehler), feuert keine Events.
2. **Loop / Batch Tab:** Außerhalb des eigentlichen `loop_run_*` ist **nichts** instrumentiert. Kein Tab-View-State, kein Group-Create, kein Subentry-Add, kein Reorder, kein Edit/Delete, keine Abort-Reasons. Die "31 Öffnungen → 0 Aktionen"-Statistik kommt durch genau diese Lücke zustande.
3. **Main Tab:** Paste & Clear sind **nicht** getrackt. Copy / Magic Fix / Swap / Send werden getrackt, aber ohne `session_id`, daher keine Sequenzanalyse möglich.
4. **History Tab:** Nur `result_copied` (bulk) und Tab-View (generisch) werden getrackt. Single Copy, Save (alle Formate), Delete, Details-Open werden **nicht** getrackt.
5. **Documents Tab:** Solide Backend-Tracking (`background.js`), aber komplett fehlend: File-Selection, Extraction-Errors, Tab-State, Resume-Button-Klick, Failed-State-Viewed, Reload-Heuristik.
6. **Naming-Inkonsistenz:** Bestehende Events haben gemischte Conventions: `popup_*`, `loop_*`, `document_*` (singular), `translation_*` (kein Bereich-Prefix), `result_copied`, `magic_fix_used`, `swap_used`. PostHog-Dashboards, die auf den heutigen Namen sitzen, werden bei Umbenennung brechen — siehe Sektion 7.

---

## 1. Tracking-Infrastruktur — Verfügbarkeit pro Kontext

| Kontext | Datei | Loads `track.js`? | `window.track` verfügbar? | Anmerkung |
|---|---|---|---|---|
| Popup | `popup.html` | ✅ ja (line 656, defer) | ✅ ja | Defer-Ordering: `track.js` → `popup.js` → `loop.js` → ok. |
| Options-Seite | `options.html` | ✅ ja (line 114) | ✅ ja | Wird nur für `getDistinctId()` genutzt, kein Tracking. |
| Upload-Page | `upload-page.html` | ✅ ja (line 145, defer) | ✅ ja | `upload.js` nutzt es einmal (`document_uploaded`). |
| **Fullpage (Documents-Upload)** | `fullpage.html` | ❌ **nein** | ❌ **nein** | **Major Gap** — das ist die zentrale Documents-Surface. |
| **History-Detail** | `history-detail.html` | ❌ **nein** | ❌ **nein** | Details-Open / Reuse / Download / Delete **null Events**. |
| Background SW | `background.js` | n/a | n/a (nutzt `self.analytics.capture`) | OK — direkter SW-Pfad. |
| Content Script | `content.js` | n/a | n/a | Kein Tracking by design — DeepL-Seite. |

**Konsequenz:** Jeder `window.track(...)`-Call in `fullpage.js` oder `history-detail.js` würde silent zum No-Op (Code prüft `if (window.track)`). Das ist der erste Defekt zu fixen.

---

## 2. Inventar der bestehenden track()-Aufrufe

### 2.1 `track.js` — Helper-Definition

| Zeile | Funktion | Zweck |
|---|---|---|
| 15–27 | `track(eventName, properties)` | Sendet `analytics:capture` Message an SW. **Try/catch swallowt alle Fehler still** — keine Warnung bei "Extension context invalidated". |
| 29–34 | `getDistinctId()` | Holt PostHog distinct_id vom SW. |
| 37–44 | `bucketChars(n)` | Char-Count-Buckets (0-500 / 500-2k / 2k-5k / 5k-10k / 10k-25k / 25k+). |

### 2.2 `popup.js` — Events vom Popup

| Zeile | Event-Name | Properties | Trigger / Bedingung |
|---|---|---|---|
| 15 | `popup_opened` | – | `DOMContentLoaded` |
| 20 | `settings_opened` | – | `#settingsBtn` click |
| 65 | `popup_tab_viewed` | `tab` (z.B. "main", "loop", "history", "pdf") | Bootstrap `shown.bs.tab` Event auf jedem Tab |
| 122–127 | `result_copied` | `target: "history_bulk"`, `count`, `char_count_bucket` | `#bulkCopyBtn` click |
| 347–351 | `translation_started` | `trigger: "popup_main"`, `char_count_bucket` | Vor Send-to-DeepL aus Main-Tab |
| 399–404 | `translation_completed` | `trigger: "popup_main"`, `char_count_bucket`, `duration_ms` | Bei Erfolg |
| 432–446 | `translation_failed` | `trigger: "popup_main"`, `char_count_bucket`, `error_type`, `duration_ms` | Bei Catch-Branch |
| 497 | `swap_used` | – | `#swapBtn` click |
| 533–536 | `magic_fix_used` | `char_count_bucket` | `#magicFixBtn` click; **vor** der Reparatur |
| 561–565 | `result_copied` | `target: "input"`, `char_count_bucket` | `#copyInputBtn` click |

### 2.3 `loop.js` — Loop / Batch Events

| Zeile | Event-Name | Properties | Trigger / Bedingung |
|---|---|---|---|
| 225–229 | `loop_run_started` | `iteration_count` | Nach DeepL-Check, vor Schleifen-Loop |
| 315 | `loop_run_cancelled` | `iteration_count`, `iterations_completed`, `iterations_failed`, `duration_ms` | `stopTranslation === true` am Ende |
| 317 | `loop_run_failed` | (siehe oben) | `failCount > 0` |
| 319 | `loop_run_completed` | (siehe oben) | sonst |
| 326–331 | `loop_run_failed` | `iteration_count`, `iterations_completed`, `duration_ms`, `error_type: "unexpected"` | Try/catch outer fallback |

### 2.4 `upload.js` — Document Upload (alte Surface)

| Zeile | Event-Name | Properties | Trigger / Bedingung |
|---|---|---|---|
| 56–69 | `document_uploaded` | `file_type` (docx/pdf), `size_bucket` | File-Picker `change` |

> ⚠ `upload.js` referenziert `mammoth.extractRawText` (line 263), aber `js/mammoth.browser.js` ist nicht im `js/`-Verzeichnis vorhanden. Der "alte" upload-Flow scheint defekt zu sein. Nur als Beobachtung — nicht zu fixen.

### 2.5 `background.js` / `analytics.js` — Service Worker Events

| Zeile (`background.js`) | Event-Name | Properties | Trigger / Bedingung |
|---|---|---|---|
| 75 | `document_translation_stopped_by_user` | `run_id` | `STOP_DOC` Message |
| 121 | `document_translation_started` | `run_id`, `file_type`, `page_count`, `batch_count`, `total_char_count_bucket` | Beim `START_DOC` (resume=false) |
| 121 | `document_translation_resumed` | (gleiche Properties) | Beim `RESUME_DOC` (resume=true) |
| 138–143 | `document_translation_failed` | `run_id`, `error_type: "no_deepl_tab"`, `batches_completed: 0`, `duration_ms` | Vor Loop, kein DeepL-Tab |
| 280–286 | `document_translation_failed` | `run_id`, `error_type` (char_limit/timeout/dom/…), `batches_completed`, `batches_total`, `duration_ms` | Nach Pause-Path |
| 309–315 | `document_translation_completed` | `run_id`, `file_type`, `batch_count`, `total_char_count_bucket`, `duration_ms` | End-of-Loop ohne Fehler |
| 332–336 | `document_translation_failed` | `run_id`, `error_type`, `duration_ms` | Outer try/catch |
| `analytics.js` 137 | `extension_installed` | `version` | `chrome.runtime.onInstalled` (install) |
| `analytics.js` 139–142 | `extension_updated` | `from`, `to` | `chrome.runtime.onInstalled` (update) |

### 2.6 `fullpage.js` / `history-detail.js`

**Kein einziger track()-Aufruf.** Selbst wenn welche eingebaut wären, würden sie no-op'en, weil `track.js` nicht inkludiert ist (siehe Sektion 1).

---

## 3. UI-Elemente pro Tab — Tracking-Coverage

### 3.1 Loop / Batch Tab

| UI-Element | Selector / Listener | Datei | Aktuell getrackt? |
|---|---|---|---|
| Tab-Switch zu Loop | `#loop-tab` shown.bs.tab | popup.js:64 / loop.js:941 | Nur generisch (`popup_tab_viewed`). Kein State. |
| "Add Entry" Button | `#addLoop` click | loop.js:890 | ❌ |
| Main-Entry Input + Enter | `#mainEntryInput` keydown | loop.js:933 | ❌ |
| Edit Group Header | `.edit-entry` click | loop.js:951 | ❌ |
| Save Edit (Group/Sub) | `.save-edit` click | loop.js:959 | ❌ |
| Delete Group | `.delete-entry` click | loop.js:953 | ❌ (kein Confirm-Dialog!) |
| Drag-Reorder Groups | Sortable.js `onEnd` | loop.js:377 | ❌ |
| Drag-Reorder Sub-Entries | Sortable.js `onEnd` | loop.js:406 | ❌ |
| Toggle "Add Subentry" | `.toggle-sub-input` click | loop.js:612 | ❌ |
| "Add" Subentry Button | `.addSubEntry` click | loop.js:650 | ❌ |
| Sub-Input Smart Enter | `keydown` Enter | loop.js:632 | ❌ |
| Multi-Paste Detection | `paste` Event + confirm() | loop.js:642 / 745 | ❌ |
| Copy Sub-Input | `.copySubEntry` click | loop.js:655 | ❌ |
| Paste Sub-Input | `.pasteSubEntry` click | loop.js:661 | ❌ |
| Clear Sub-Input | `.clearSubEntry` click | loop.js:670 | ❌ |
| Edit Sub-Entry | `.edit-sub` click | loop.js:955 | ❌ |
| Delete Sub-Entry | `.delete-sub` click | loop.js:957 | ❌ |
| Copy Sub-Entry | `.copy-sub` click | loop.js:961 | ❌ |
| Show More / Show Less | `.toggle-text` | loop.js:949 / 1219 | ❌ |
| Group "Start" Button | `.start-group` click | loop.js:981 → startGroupTranslation | Teil-Tracking — siehe unten |
| Group "Stop" Button | `.stop-group` click | loop.js:984 | ❌ (nur Flag gesetzt; kein eigenes Event, läuft erst beim End-Of-Loop in `loop_run_cancelled`) |

**Early Returns in `startGroupTranslation` — alle ohne Tracking:**
- `loop.js:208` — `alert("Please open DeepL first.")` → kein Event
- `loop.js:220` — `alert("This group has no entries to translate.")` → kein Event
- `loop.js:251–255` — DeepL-Tab verloren während des Runs → wird zwar als `cancelled` gefeuert, aber ohne Reason ("deepl_lost")

### 3.2 Main Tab

| UI-Element | Selector / Listener | Datei | Aktuell getrackt? |
|---|---|---|---|
| Send-to-DeepL | `#sendBtn` click | popup.js:327 | ✅ `translation_started` / `translation_completed` / `translation_failed` |
| Send Pre-Click (vor Validierung) | – | – | ❌ (bei `alert("Please enter text.")` und DeepL-not-open kein Event) |
| Paste | `#pasteBtn` click | popup.js:585 | ❌ |
| Copy Input | `#copyInputBtn` click | popup.js:558 | ✅ (`result_copied` mit `target: "input"`) |
| Clear | `#clearBtn` click | popup.js:611 | ❌ |
| Magic Fix | `#magicFixBtn` click | popup.js:530 | ✅ (`magic_fix_used`) — aber nur **Pre-Char-Count**, kein Post-Char-Count |
| Swap | `#swapBtn` click | popup.js:496 | ✅ (`swap_used`) — kein `had_input`/`had_output` |
| Bug-Button | `#bugBtn` click | popup.js:1264 | ❌ |
| Feature-Button | `#featureBtn` click | popup.js:1267 | ❌ |
| Settings-Button | `#settingsBtn` click | popup.js:18 | ✅ (`settings_opened`) |
| Download (Main result) | `#downloadSection [data-format]` | popup.html:541 | ❌ — und Listener scheint fehlend, der Section-Hide/Show wird nirgends gewired (toter Code?) |

**Fehlende Konstellation-Korrelation:** Es gibt keine `session_id`. Alle Events aus einer Popup-Öffnung sind in PostHog nicht miteinander verkettbar.

### 3.3 History Tab

| UI-Element | Selector / Listener | Datei | Aktuell getrackt? |
|---|---|---|---|
| Tab-Switch zu History | `#history-tab` shown.bs.tab | popup.js:64 (auslöst `loadHistory`) | Nur generisch (`popup_tab_viewed`). Kein State (entry_count). |
| "Select all" Toggle | `#selectAllHistoryBtn` click | popup.js:97 | ❌ |
| Bulk Copy | `#bulkCopyBtn` click | popup.js:119 | ✅ (`result_copied` mit `target: "history_bulk"`) |
| Bulk Export TXT | `#bulkExportTxt` click | popup.js:141 | ❌ |
| Bulk Export Word | `#bulkExportWord` click | popup.js:160 | ❌ |
| Bulk Delete | `#bulkDeleteBtn` click | popup.js:175 | ❌ (auch kein Track der `confirm()` Cancel-Pfade) |
| Single-Entry Checkbox | `.history-select-cb` change | popup.js:818 | ❌ |
| Reuse Original | `.reuse-original` click | popup.js:756 | ❌ |
| Reuse Converted | `.reuse-converted` click | popup.js:762 | ❌ |
| Single Copy Original | `.copy-btn-original` click | popup.js:774 | ❌ |
| Single Copy Converted | `.copy-btn-converted` click | popup.js:786 | ❌ |
| Open Details | `.details-entry` click | popup.js:768 | ❌ — öffnet `history-detail.html` in neuem Tab |
| Single Save (Dropdown) | `.dropdown-item[data-format]` click | popup.js:798 | ❌ — Formate: `txt`, `word`, `pdf`, `md`, `json`, `csv` |
| Single Delete | `.delete-btn` click | popup.js:805 | ❌ |
| **In `history-detail.html`:** | | | |
| Reuse Original / Converted | `#reuseOriginalBtn`, `#reuseConvertedBtn` | history-detail.js:137 | ❌ (kein track.js geladen) |
| Delete Entry | `#deleteBtn` | history-detail.js:146 | ❌ |
| Copy Buttons (4×) | `.copy-btn` | history-detail.js:177 | ❌ |
| Download (5×) | `.dropdown-item[data-format]` | history-detail.js:162 | ❌ |
| "Back" Button | `#backBtn` | history-detail.js:172 | ❌ |
| Empty-State viewed | – | popup.js:639 | ❌ |
| Time auf Detail-Seite | – | – | ❌ (kein Open/Close-Pair) |

### 3.4 Documents Tab

| UI-Element | Selector / Listener | Datei | Aktuell getrackt? |
|---|---|---|---|
| Tab-Switch zu PDF/Documents | `#pdf-tab` shown.bs.tab | popup.js:64 | Nur generisch. Kein `has_pending_translation` State. |
| "Open Full Page" Button | `#openFullPageBtn` click | popup.js:938 | ❌ |
| Pending Doc Start | `[data-doc-action="start"]` | popup.js:986 → SW `START_DOC` | ✅ (im SW: `document_translation_started`) |
| Pending Doc Resume | `[data-doc-action="resume"]` | popup.js:988 → SW `RESUME_DOC` | ✅ (im SW: `document_translation_resumed`) — **kein** `time_since_failure_ms` |
| Pending Doc Stop | `[data-doc-action="stop"]` | popup.js:990 → SW `STOP_DOC` | ✅ (`document_translation_stopped_by_user`) |
| Pending Doc Delete | `[data-doc-action="delete"]` | popup.js:992 | ❌ (löscht direkt aus storage; kein Event) |
| Empty-State viewed | `#pendingDocsEmpty` | popup.js:617 (HTML), 1015 (toggle) | ❌ |
| **In `fullpage.html` (Upload-Surface):** | | | |
| Drop Zone Drop | `#dropZone` drop | fullpage.js:73 | ❌ |
| Drop Zone Click | `#dropZone` click | fullpage.js:67 | ❌ |
| File-Picker Change | `#pdfFileInput` change | fullpage.js:88 | ❌ |
| File-Type Detected (extract started) | `handleFileSelected` | fullpage.js:103 | ❌ — würde `documents_file_selected` sein |
| Extract success | `setStep("extract", "done")` | fullpage.js:144 | ❌ |
| Extract failed (try/catch) | `setStep("extract", "error")` | fullpage.js:167 | ❌ — keine Telemetrie für Parser-Fehler |
| Unsupported file type | `showAlert(...)` | fullpage.js:81, 105 | ❌ |
| Clear History Button | `#clearHistoryBtn` click | fullpage.js:95 | ❌ |
| History-Item Download | `.dl-btn` click | fullpage.js:582 | ❌ |
| History-Item Delete | `.del-btn` click | fullpage.js:605 | ❌ |
| Page-Reload während Translation | beim Boot DOMContentLoaded + Storage-Check | fullpage.js:57 / popup.js:34 | ❌ (heuristisch erfassbar — siehe unten) |

---

## 4. Identifizierte Lücken — strukturierte Liste

### 4.1 Loop / Batch Tab — fehlende Events
1. **`loop_tab_viewed_state`** mit `has_entries`, `entry_count`, `total_subentries` — komplett fehlend.
2. **`loop_group_created`** — `addLoop` Listener kennt kein Tracking.
3. **`loop_subentry_added`** mit `method: single|multi_paste`, bei multi_paste `count` — fehlt komplett.
4. **`loop_subentry_edited`, `loop_subentry_deleted`, `loop_group_edited`, `loop_group_deleted`** — alle 4 ungetrackt.
5. **`loop_group_reordered`, `loop_subentry_reordered`** — Sortable.js onEnd-Handler hat console.log, aber kein Event.
6. **`loop_start_clicked`** — gewünscht **vor** allen Validierungen. Aktuell springt der Code in `startGroupTranslation`, prüft DeepL, prüft `subEntries.length`, und dann erst feuert `loop_run_started`. Die zwei Early-Returns dazwischen (DeepL nicht offen, keine Subentries) erzeugen heute kein Event.
7. **`loop_aborted`** mit Reason (`deepl_not_open`, `no_entries`, `deepl_lost_during_run`, `user_stopped`) — fehlt.
8. **`loop_copy_used` / `loop_paste_used` / `loop_clear_used`** — fehlen alle.

### 4.2 Main Tab — fehlende Events
1. **`main_paste_used`** — Paste-Button hat keinen Track.
2. **`main_clear_used`** — Clear-Button hat keinen Track.
3. **`main_send_to_deepl_clicked`** vor Validierung — heute existiert nur `translation_started`, das nach DeepL-URL-Check feuert. Wenn der User nicht auf DeepL ist (`alert(...)`), gibt es **keinen** Event.
4. **`main_session_id`** — keine UUID per Popup-Open. Sequenzanalyse unmöglich.
5. **`main_session_summary`** — kein Event beim Schließen / Tab-Wechsel mit `actions_used: []`.
6. **Magic Fix Pre/Post Char Count** — heute nur Pre-Count.
7. **Swap had_input / had_output** — heute nur Bare-Event.

### 4.3 History Tab — fehlende Events
1. **`history_tab_viewed_state`** mit `entry_count`.
2. **`history_entry_clicked`** — kein generisches Click-Event auf Einträge.
3. **`history_details_opened`** vs. `history_details_closed` mit `duration_ms` — geht nur, wenn die Detailseite (history-detail.js) selbst trackt. Heute gar nicht möglich (track.js fehlt dort).
4. **`history_single_save_clicked`** mit `format` (txt/word/pdf/md/json/csv) — verfügbare Formate: 6.
5. **`history_bulk_save_clicked`** mit `format` (txt, word) und `entry_count` — verfügbare Formate: 2.
6. **`history_entry_deleted`** und **`history_bulk_deleted`** mit `entry_count`.
7. **`history_empty_state_viewed`** — Branch in `loadHistory` (popup.js:638).
8. (Es gibt keine Such-/Filter-UI heute — `history_entry_searched / filtered` entfällt.)

### 4.4 Documents Tab — fehlende Events
1. **`documents_tab_viewed_state`** mit `has_pending_translation`, `pending_file_type`, `pending_count`.
2. **`documents_file_selected`** mit `file_type`, `file_size_bucket`, `page_count`. **Aber:** Damit das aus `fullpage.js` feuern kann, muss `track.js` zuerst in `fullpage.html` inkludiert werden.
3. **Extraction-Fehler** — fullpage.js:167 catch-Branch hat keinen Track.
4. **`documents_translation_resumed` mit `time_since_failure_ms`** — Backend trackt heute Resume, aber ohne diese Property.
5. **`documents_resume_button_clicked`** — wird heute mit `RESUME_DOC` Message verschmolzen. Wir können entweder die Message-Sendung im Popup tracken (Klick-Intention) und das `documents_translation_resumed` weiter im SW lassen (Tatsächlicher-Run), oder die zwei zu einem konsolidieren. **Empfehlung:** Klick-Event im Popup, run-Event im SW behalten, weil der SW-Pfad auch nach Browser-Crash beim nächsten Wakeup feuert.
6. **`documents_failed_state_viewed`** — beim Tab-Open in popup.js, wenn pendingDocs ein `status === "error"` enthält.
7. **`documents_page_reloaded_during_translation`** — Heuristik:
   - Beim Boot von `fullpage.html` (DOMContentLoaded): wenn `pendingDocuments` einen Eintrag mit `status === "paused" || "error"` enthält UND der `updatedAt` in der Vergangenheit liegt UND nicht selbst durch User-Klick erreicht — feuern.
   - Alternativ einfacher: wenn der User auf der Documents-Tab-Seite einen `status === "paused"` Eintrag sieht (popup), lässt sich `documents_failed_state_viewed` mit `was_seen_after_reload: true` markieren, falls der Tab gerade neu gerendert wurde.
   - Vorschlag: Zwei Events — `documents_failed_state_viewed` (im Popup beim Tab-Wechsel) UND `documents_page_reloaded_during_translation` (im fullpage.js DOMContentLoaded, wenn ein paused/error Doc existiert).

### 4.5 Cross-Cutting
1. **Helper schluckt Fehler still.** `track.js:22` hat `try { … } catch { /* drop */ }` ohne console.warn. Beim Testen sieht man nicht, wenn ein Event verloren geht (z.B. weil Extension-Context teardown).
2. **Keine Base-Properties.** Jeder Aufrufer baut sein Properties-Object selber. `extension_version`, `tab_context`, `session_id` müssten zentral injiziert werden.
3. **Char-Bucket inkonsistent.** Es gibt `bucketChars` in `track.js` und in `background.js`. Code dupliziert. Halten sie heute synchron, aber bei Drift entsteht ein Property-Mismatch. (Nicht kritisch, nur beim Refactor zu konsolidieren.)
4. **Duplikate möglich nach Refactor.** Wenn wir `documents_translation_*` einführen UND `translation_*` aus popup.js stehen lassen, werden zwei Events für unterschiedliche Sachverhalte denselben Namen haben. Lösung in Sektion 7.

---

## 5. Beobachtete Bugs (nicht zu fixen — nur dokumentiert)

> Auftrag: "Wenn du beim Lesen Bugs findest: dokumentiere sie, fixe sie aber nicht."

1. **`loop.js:953` — Delete-Group hat keinen Confirm-Dialog.** Sub-Entry-Delete läuft auch ohne `confirm()`. Versehentliche Deletes möglich.
2. **`upload.js:263` — `mammoth.extractRawText` ohne dass `js/mammoth.browser.js` im Repo existiert.** Der "alte" Upload-Path scheint defekt. (`upload-page.html:16` referenziert die Datei.)
3. **`popup.js:537–545` — Download-Section** (`#downloadSection`) hat 3 Buttons (TXT/DOCX/PDF) ohne Click-Listener. Toter Code oder Feature im Wartemodus?
4. **`popup.js:805` — Single-Delete via `confirm()`**, **aber** Bulk-Delete (popup.js:175) nutzt auch `confirm()`. Ergonomische Inkonsistenz: Bulk löscht `n` Einträge in einem Confirm, Single in seinem eigenen.
5. **`content.js:574` — Tautologie:** `errorType: detectDeepLLimit() ? "char_limit" : "char_limit"`. Beide Branches gleich. Vermutlich Tippfehler.
6. **`history-detail.js:174` — `window.location.href = "popup.html"`** versucht popup.html in einem normalen Tab zu öffnen — popup.html ist aber eine Browser-Action-Surface. Das könnte je nach Chrome-Version komisch laufen.

---

## 6. Notwendige Reihenfolge der Maßnahmen (Phase 2+)

1. **track.js in `fullpage.html` und `history-detail.html` inkludieren.** Ohne das ist Documents-File-Selection und History-Detail-Tracking strukturell nicht möglich.
2. **`trackEvent(name, props)` Helper** mit:
   - Verfügbarkeitscheck (`window.track`-Path **und** `chrome.runtime?.id`-Path).
   - `console.warn` bei Fehlen (Test-Hinweis).
   - `try/catch` mit warn (statt silent drop).
   - Base-Properties: `extension_version`, `tab_context` (aus aktuellem Tab oder Konstante), optional `session_id`.
   - Optional: `console.log("📊 Tracked: <name>", props)`.
3. **Bestehende `window.track` Calls auf den Helper umstellen** (1:1 Migration, keine Verhaltensänderung).
4. **Bereich für Bereich** (in dieser Order, weil das die fragwürdigsten Daten sind):
   - **Loop:** alle Events neu — größte Lücke.
   - **Documents:** Reload-Heuristik + File-Selection.
   - **Main:** session_id + Buttons.
   - **History:** Single-Operations + Detail-View.

---

## 7. Migrations-Tabelle (Vorher → Nachher)

> ⚠ Diese Umbenennungen brechen bestehende PostHog-Insights / Funnels. Falls Dashboards existieren, vor Deployment Property-Backfill oder Side-by-Side-Tracking einbauen.

| Heutiger Event-Name | Vorgeschlagener neuer Name | Begründung |
|---|---|---|
| `popup_opened` | **bleibt** `popup_opened` | App-weit, nicht Bereichs-spezifisch. |
| `popup_tab_viewed` | **bleibt** als App-Level-Event | Plus zusätzliche `<bereich>_tab_viewed_state` Events mit Kontext. |
| `settings_opened` | **bleibt** | App-weit. |
| `translation_started` (popup_main) | `main_translation_started` | Bereichs-Prefix. |
| `translation_completed` (popup_main) | `main_translation_completed` | Dito. |
| `translation_failed` (popup_main) | `main_translation_failed` | Dito. |
| `swap_used` | `main_swap_used` | Bereichs-Prefix. |
| `magic_fix_used` | `main_magic_fix_used` | Bereichs-Prefix + Pre/Post Char-Count. |
| `result_copied` (target=input) | `main_copy_used` | Konsistenz mit Vorgabe. |
| `result_copied` (target=history_bulk) | `history_bulk_copy_clicked` | Aufbau auf `history_*` Schema. |
| `loop_run_started/completed/failed/cancelled` | **bleiben** | Schon richtig benannt. |
| `document_uploaded` | `documents_file_selected` (mit reicheren Props) | Plural-Prefix konsistent zur Vorgabe. **Achtung:** Heutige Property `size_bucket` → künftig `file_size_bucket` (Vorgabe). |
| `document_translation_started` | `documents_translation_started` | Plural — Konsistenz mit Vorgabe. |
| `document_translation_resumed` | `documents_translation_resumed` | + neue Property `time_since_failure_ms`, `trigger` ("user_click"/"auto"). |
| `document_translation_completed` | `documents_translation_completed` | + Property `batches_total`. |
| `document_translation_failed` | `documents_translation_failed` | + Property `batches_total` (heute teilweise schon da). |
| `document_translation_stopped_by_user` | `documents_translation_stopped_by_user` | Plural. |
| `extension_installed` / `extension_updated` | **bleiben** | App-weit. |

**Empfehlung:** Wir feuern eine kurze Übergangszeit (1–2 Releases) sowohl alte als auch neue Namen parallel ("dual-write"). Dashboards können dann graduell migrieren. Falls Du keine Dashboards hast: direkt umbenennen, kein Dual-Write.

---

## 8. Konstellation-Tracking — wie `main_session_id` aussehen sollte

- Beim ersten Aufruf von `trackEvent` aus dem Popup-Kontext: `crypto.randomUUID()` generieren und als Modul-Variable cachen.
- An jeden Main-Tab-Event als `main_session_id` mitsenden.
- Beim `popup_tab_viewed` mit anderem Tab als "main", **vorher** ein `main_session_summary` Event feuern, falls in dieser Session überhaupt Main-Aktionen passiert sind.
- Beim Popup-Close (`window.beforeunload` / `pagehide`) Summary feuern. Achtung MV3: das popup wird hart zugemacht, `pagehide` ist die zuverlässigere Hook als `beforeunload`. Und PostHog-Send muss synchron via `chrome.runtime.sendMessage` mit `keepalive` analog gehen — das passiert im SW-Hop ohnehin.
- `actions_used` ist ein `Set` während der Session; wird beim Summary zu Array konvertiert.

---

## 9. Was ich vor der Implementierung von Dir bestätigt haben möchte

1. **Dual-Write während Migration?** Sollen alte Event-Namen für 1–2 Releases parallel weiterlaufen, oder direkt clean cut? *(Annahme falls kein Feedback: clean cut, weil PostHog noch jung ist.)*
2. **`session_id` Scope** — pro Popup-Open (mein Vorschlag) oder über mehrere Popup-Öffnungen hinweg? Pro-Popup-Open ist sauberer für Sequenzanalyse. *(Annahme: pro Popup-Open.)*
3. **Reload-Heuristik im Documents-Tab** — soll das Event auch feuern wenn der User explizit `fullpage.html` schließt und neu öffnet (ohne Translation), oder nur wenn ein paused/error Doc da ist? *(Annahme: nur wenn paused/error Doc existiert.)*
4. **Rollout-Risiko Documents-Frontend:** `track.js` in `fullpage.html` + `history-detail.html` einzufügen, ist eine kleine HTML-Änderung — aber neu. Sollen wir vorher CSP / DOM-Checks machen? *(Annahme: nein, `chrome.runtime.sendMessage` wird in beiden Pages auch heute schon genutzt, also klar erlaubt.)*
5. **Empty-State-Tracking** — sollen `*_empty_state_viewed` Events oder Properties auf `*_tab_viewed_state` (z.B. `is_empty: true`)? Letzteres ist DRY-er. *(Annahme: Property auf dem `_state` Event.)*

Wenn Du keine Korrekturen schickst, gehe ich für Phase 2/3 von den Annahmen oben aus.

---

## 10. Anhang — Datei- / Zeilen-Index der zu ändernden Dateien

Reine Lese-Trefferliste, damit Phase 2 zielgenau treffen kann:

- **`track.js`** — Helper umbauen (zentrale Datei).
- **`popup.html` line 656** — bleibt; `track.js` ist da.
- **`fullpage.html` line ~218** — `<script src="track.js" defer></script>` einfügen, vor `<script src="fullpage.js">`.
- **`history-detail.html` line ~16** — `<script src="track.js" defer></script>` einfügen, vor `<script src="history-detail.js">`.
- **`popup.js`** — Main-Tab-Buttons (paste/clear: 585/611), Send-Pre-Click (327), Magic Fix Post-Count (530), Swap had_*  (496), History Bulk-Operations (141/160/175), History Single-Operations (756–805), Tab-Switch State (64), Documents Tab Pending (986–992), `openFullPageBtn` (938), Session-ID-Init (DOMContentLoaded), Session-Summary (`pagehide`).
- **`loop.js`** — `addLoop` (890), Sub-Entry-Add (650, 745), Edit/Delete (951–957), Reorder (377/406), Buttons im Sub-Input (655/661/670), Tab-Open Hook (941), `startGroupTranslation` Validierungen (208/220/250).
- **`fullpage.js`** — Drop/Click/Change (67/73/88), `handleFileSelected` Pre/Post Extract (103/144/167).
- **`history-detail.js`** — Open/Close (DOMContentLoaded + pagehide), Reuse/Delete/Copy/Download (137/146/162/177).
- **`background.js`** — Resume `time_since_failure_ms`, Documents-Failed Reload-Heuristik beim Storage-Read, Event-Renames `document_*` → `documents_*`.
- **`upload.js`** — `document_uploaded` → `documents_file_selected` (oder als deprecated lassen — Frage 1 oben).

---

**Ende des Audits. Bitte gib OK / Korrekturen, dann starte ich Phase 2 + 3 mit Commits pro Bereich.**
