# Tracking Events Reference — DeepL Pro Unlimited

**Stand:** 2026-05-10 (after Phase 2 — char-count granularity)
**Branch:** `main`
**Predecessor:** [tracking-audit.md](./tracking-audit.md) (Phase 2 audit)
**Phase 1:** [tracking-audit-phase1.md](./tracking-audit-phase1.md) (historical)

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

For SW-side events (`background.js` → `self.analytics.capture`), the `tab_context` and `popup_session_id` are **not** automatically added — those are page-side concepts. Two SW-side events manually attach `popup_session_id` and `tab_context: "popup"` so they have the same shape as their popup-side counterparts:

- `popup_tab_dwell` (when fired from the SW disconnect handler)
- `user_monthly_summary` carries no popup_session_id (it's lifecycle-scoped, not session-scoped)

---

## App-level events (not bereich-specific)

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `popup_opened` | popup.html DOMContentLoaded | – | Tagesaktive Popup-Öffnungen. Baseline für jeden Funnel. **Also** triggers the monthly-tracker rollover check (closes any prior period and fires `user_monthly_summary` if applicable). |
| `popup_tab_viewed` | Bootstrap `shown.bs.tab` auf einem Tab | `tab` (`main`/`loop`/`history`/`pdf`) | Tab-Switch-Counts. Pairs mit den `<bereich>_tab_viewed_state` Events für reichere Analyse. |
| `popup_tab_dwell` | (1) Bootstrap `shown.bs.tab` — for the leaving tab. (2) SW disconnect of the long-lived `popup_dwell` port — for the tab that was active when the popup closed. | `tab`, `dwell_ms`, `had_interaction` (bool — flipped by any non-pure-view trackEvent during this dwell), `closed_via` (`tab_switch` / `popup_close`), `popup_session_id`, `tab_context` (manually attached on the SW-fired path) | "Wie lang sehen User welchen Tab — und tun sie etwas darin?" Answers the "lots of views, very few actions" gap on History and Loop. **The popup-close path uses `chrome.runtime.connect` with a long-lived port** because `beforeunload`/`pagehide` are unreliable in MV3 popups. |
| `paywall_eligibility_check` | (1) `main_send_to_deepl_clicked` after validation passes (in popup.js, before `main_translation_started`). (2) `documents_translation_started` (in `background.js`, only on fresh starts — never on resumes). | `surface` (`main` / `documents`), `current_period_count` (post-action snapshot: completed_count + 1), `current_period_chars` (total_chars + projected this attempt), `would_paywall_at_count_3` (bool), `would_paywall_at_chars_5k` (bool), `would_paywall_at_chars_25k` (bool), `file_type` (documents only) | Baseline for paywall threshold tuning **without showing a paywall**. Counts and chars include the action that's about to happen, so a `true` flag means "this attempt would have been blocked". |
| `user_monthly_summary` | First `popup_opened` of a new UTC calendar month, snapshotting the previous (now closed) month | `period` (`YYYY-MM` of the month being summarized), `period_full_month` (bool — false when the period is the user's install month), `main_translation_count` (started events), `main_translation_completed_count`, `main_translation_total_chars_input`, `main_translation_total_chars_output`, `main_translation_max_single_chars`, `documents_pdf_completed_count`, `documents_xlsx_completed_count` (note: `excel` filetype is mapped to `xlsx` here), `documents_pptx_completed_count`, `documents_total_chars_input`, `loop_runs_count`, `unique_active_days` (count only — exact dates never sent) | Per-user aggregate in one query, no event-level joins. Skipped when the closed period had zero activity (handles install-mid-month and inactive-for-months cases without firing empty rollups). |
| `settings_opened` | `#settingsBtn` click | – | Wie oft öffnen User die Settings? |
| `extension_installed` | `chrome.runtime.onInstalled` reason `install` | `version` | Install-Funnel. |
| `extension_updated` | `chrome.runtime.onInstalled` reason `update` | `from`, `to` | Versions-Migration tracken. |

> **Implementation note (rollover):** The monthly-tracker rollover check fires inside the SW's `capture()` for `popup_opened`. All counter increments live in the same path, serialized through `withMonthlyTrackerLock` to prevent storage-RMW races between near-simultaneous events. See `analytics.js` and `tracking-audit.md` §5 for the full design.

---

## Loop / Batch Tab

Frage, die diese Events beantworten: "Wird der Batch-Tab überhaupt sinnvoll genutzt, oder können wir ihn entfernen?"

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `loop_tab_viewed_state` | `#loop` Tab-Switch | `has_entries` (bool), `entry_count` (int), `total_subentries` (int). **Feuert immer, auch bei 0/0.** | Empty-State-Conversion: wie viele User sehen einen leeren Tab und springen ab? |
| `loop_group_created` | `#addLoop` click (mit nicht-leerem Input) | `entry_count_after` (int) | Erste konkrete Aktion. |
| `loop_subentry_added` | `.addSubEntry` click → `addSubEntryFromInput` ODER `handleMultiPaste` | `method` (`single` / `multi_paste` / `multi_paste_declined`), `count` (int) | Single vs Multi-Paste Verhältnis. `multi_paste_declined` = User hat im Confirm "Cancel" gedrückt. |
| `loop_subentry_edited` | `saveEditText` (sub) | `char_count_bucket` | |
| `loop_group_edited` | `saveEditText` (entry) | `char_count_bucket` | |
| `loop_subentry_deleted` | `deleteEntry` (sub) | – | |
| `loop_group_deleted` | `deleteEntry` (entry) | – | |
| `loop_group_reordered` | Sortable.js onEnd, nur wenn `oldIndex !== newIndex` | – | |
| `loop_subentry_reordered` | Sortable.js onEnd, nur wenn `oldIndex !== newIndex` | – | |
| `loop_start_clicked` | Erste Zeile in `startGroupTranslation`, **vor** allen Validierungen | `iteration_count` (int) | Capture-all für Start-Klicks, inkl. Aborts. |
| `loop_aborted` | Branches die einen Run frühzeitig oder mid-run beenden | `reason` (`deepl_not_open` / `no_entries` / `deepl_lost_during_run` / `user_stopped`), `iteration_count`, `iterations_completed` (nur deepl_lost_during_run) | Granular: warum bricht ein Run ab? |
| `loop_run_started` | Nach Validierung, vor Schleifen-Loop | `iteration_count` | Run-State-Event. |
| `loop_run_completed` | End-of-Loop ohne Fehler | `iteration_count`, `iterations_completed`, `iterations_failed`, `duration_ms` | **Increments `loop_runs_count`** in the monthly tracker. |
| `loop_run_failed` | Mind. 1 Iteration failed (oder outer catch) | `iteration_count`, `iterations_completed`, `iterations_failed`, `duration_ms`, `error_type` (nur outer catch) | |
| `loop_run_cancelled` | `stopTranslation === true` am Ende | (gleiche Properties) | |
| `loop_copy_used` / `loop_paste_used` / `loop_clear_used` | `.copy/paste/clearSubEntry` click | `char_count_bucket` | |

> **Doppel-Event-Hinweis:** Wenn der User auf STOP klickt, feuern **beide** `loop_aborted` (reason: `user_stopped`) **und** `loop_run_cancelled`. Sie sind komplementär — `loop_aborted` ist das User-Intent-Signal, `loop_run_cancelled` ist der Run-State.

---

## Main Tab

Frage: "In welcher Konstellation/Sequenz werden die Buttons verwendet? Welche Buttons sind überflüssig?"

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `main_paste_used` | `#pasteBtn` click | `char_count_bucket`, `had_text` (bool) | Stamps `mainLastPasteAt` for the `was_pasted` heuristic on the next Send. |
| `main_copy_used` | `#copyInputBtn` click (Input nicht leer) | `target` (`input` / `output` reserved), `char_count_bucket` | |
| `main_clear_used` | `#clearBtn` click | `target` (`input`), `char_count_bucket` (vor Clear) | |
| `main_magic_fix_used` | `#magicFixBtn` click | `char_count_bucket_pre`, `char_count_bucket_post`, `chars_removed_bucket` | |
| `main_swap_used` | `#swapBtn` click | `had_input` (bool), `had_output` (bool) | |
| `main_send_to_deepl_clicked` | First line of `sendBtn` click, **vor** allen Validierungen | `char_count_bucket` (legacy), `input_char_count_bucket`, `input_char_count_exact` (privacy: count only), `has_text`, `trigger`, `lang_from`, `lang_to`, `was_pasted` (bool — Send within 5s of `main_paste_used`) | Capture-all für Send-Intentions. |
| `main_send_aborted` | Send-Click der wegen non-DeepL-Tab abgebrochen wird | `reason` (`deepl_not_open`), `char_count_bucket` (legacy), `input_char_count_bucket`, `input_char_count_exact`, `batches_completed: 0`, `duration_ms: 0`, `lang_from`, `lang_to` | Empty-Input-Aborts werden NICHT separat getrackt — `main_send_to_deepl_clicked.has_text === false` reicht. |
| `main_translation_started` | Nach allen Pre-Checks; AFTER `paywall_eligibility_check` fires | `char_count_bucket` (legacy), `input_char_count_bucket`, `input_char_count_exact`, `lang_from`, `lang_to`, `run_id` (UUID) | Run-State. `run_id` joins started → completed/failed in PostHog. |
| `main_translation_completed` | Erfolgreicher Completion-Signal | `char_count_bucket` (legacy), `input_char_count_bucket`, `input_char_count_exact`, `output_char_count_bucket`, `output_char_count_exact` (from `result.translatedLength`), `lang_from`, `lang_to`, `duration_ms`, `batch_count`, `batches_completed`, `run_id` | **Increments `main_translation_completed_count` + chars in monthly tracker.** |
| `main_translation_failed` | (1) In-line when `result.success === false` (preserves `batch_count`/`batches_completed` from the result). (2) Catch branch when no `result` is available (timeout, network blip). | `char_count_bucket` (legacy), `input_char_count_bucket`, `input_char_count_exact`, `error_type` (canonical: see vocabulary below), `duration_ms`, `batches_completed` (null on catch path), `batches_total` (null on catch path), `lang_from`, `lang_to`, `run_id` | The catch branch is guarded by `runHadFailureTracked` so the inline emit isn't double-fired. |
| `main_session_summary` | Tab-Switch weg von `#main` ODER popup `pagehide` | `actions_used` (sortiertes Array), `action_count` (int) | Aggregierte Sequenz pro Popup-Open. **Feuert nur wenn ≥1 Action.** |

> **`run_id`**: New in Phase 2. Joins `main_translation_started` → `main_translation_completed`/`failed` for the same Send press. Use it instead of `popup_session_id` when computing per-run duration distributions (one popup session can do multiple sends).
>
> **`*_exact` properties — privacy invariant**: integer counts only. Source and translated text are NEVER sent. A one-line comment at every `*_exact` call site enforces this.

---

## History Tab

Fragen: "Wird die Details-Seite überhaupt geöffnet? Welche Save-Option wird am meisten genutzt?"

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `history_tab_viewed_state` | `#history` Tab-Switch | `has_entries` (bool), `entry_count` (int) | |
| `history_entry_clicked` | `.details-entry` click in popup | `action` (`open_details`) | |
| `history_details_opened` | history-detail.html DOMContentLoaded | – | |
| `history_details_closed` | history-detail.html `pagehide` | `duration_ms` | |
| `history_single_save_clicked` | Single-Entry-Dropdown click in popup ODER auf history-detail.html | `format` (`txt`/`word`/`pdf`/`md`/`json`/`csv`), `source` (`popup` / `detail_page`) | |
| `history_bulk_copy_clicked` | `#bulkCopyBtn` click | `entry_count`, `char_count_bucket` | |
| `history_bulk_save_clicked` | `#bulkExportTxt` / `#bulkExportWord` click | `format` (`txt`/`word`), `entry_count` | |
| `history_entry_deleted` | Single-Row Del-Button in popup ODER `#deleteBtn` auf detail page | `source` (`popup` / `detail_page`) | |
| `history_bulk_deleted` | `#bulkDeleteBtn` click (nach confirm) | `entry_count` | |

---

## Documents Tab

### Popup-side (popup.js)

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `documents_tab_viewed_state` | `#pdf` Tab-Switch | `has_pending_translation`, `pending_count`, `pending_file_types`, `has_failed_state`, `failed_count` | |
| `documents_failed_state_viewed` | Tab-Switch UND ≥1 paused/error Doc | `pending_status`, `pending_file_type`, `paused_count`, `error_count`, `pending_count_total` | Genau 1 Event pro Tab-Open. |
| `documents_open_fullpage_clicked` | `#openFullPageBtn` click | `reopened` (bool) | |
| `documents_resume_button_clicked` | `[data-doc-action="resume"]` click | – | Pairs mit `documents_translation_resumed` (SW). |
| `documents_pending_doc_deleted` | `[data-doc-action="delete"]` click | – | |

### Fullpage-side (fullpage.js)

| Event | Trigger | Properties | Zweck |
|---|---|---|---|
| `documents_file_selected` | Drop ODER File-Picker change ODER `upload-page.html` (legacy) | `file_type`, `file_size_bucket`, `mime_type` (Phase 2 add — was on rejected only), `source` | |
| `documents_file_rejected` | Drop oder Picker mit unsupported file type | `reason`, `mime_type`, `file_size_bucket`, `source` | |
| `documents_extraction_completed` | Erfolgreiche Text-Extraktion | `file_type`, `page_count`, `total_char_count_bucket` (legacy — kept for dashboard backward-compat), `extracted_char_count_bucket` (Phase 2 — canonical "extracted" naming on this event), `extracted_char_count_exact` (privacy: count only), `extraction_duration_ms`, `mime_type` | The dual-write of `total_char_count_bucket` + `extracted_char_count_bucket` is intentional: existing PostHog dashboards continue to work; new dashboards use the more precise name. |
| `documents_extraction_failed` | Catch-Branch in `handleFileSelected` | `file_type`, `file_size_bucket`, `error_class` (`library_missing` / `pptx_no_slides` / `parse_error`) | |
| `documents_page_reloaded_during_translation` | DOMContentLoaded UND ≥1 paused/error Doc | `pending_status`, `pending_file_type`, `paused_count`, `error_count`, `pending_count_total`, `time_since_failure_ms` | |

### SW-side (background.js)

All SW-side translation events share a `runEventBase` of properties: `run_id`, `file_type`, `lang_from`, `lang_to`, `total_char_count_bucket`, `total_char_count_exact`, `consecutive_char_limit_failures` (snapshot at run-start). Per-event additions are listed below on top of the base.

| Event | Trigger | Additional Properties |
|---|---|---|
| `documents_translation_started` | `START_DOC` Message → `startDocumentTranslation` (resume=false). **AFTER** `paywall_eligibility_check` fires. | `page_count`, `batch_count` |
| `documents_translation_resumed` | `RESUME_DOC` Message (resume=true) | `page_count`, `batch_count`, `resume_trigger` (`explicit_button` / `auto_on_load` reserved), `time_since_failure_ms`, `previous_status` |
| `documents_translation_completed` | End-of-Loop ohne Fehler | `batch_count`, `batches_total`, `batches_completed`, `input_char_count_bucket`, `input_char_count_exact`, `output_char_count_bucket`, `output_char_count_exact` (from `translatedText.length`), `duration_ms`, **`consecutive_char_limit_failures: 0`** (override — counter was just reset), **`consecutive_char_limit_failures_before_success`** (the value that was reset; non-zero means "user finally broke through after N failed attempts") |
| `documents_translation_failed` | (1) `no_deepl_tab` path. (2) In-loop batch failure path. (3) Outer catch branch. | `error_type` (normalized — see vocabulary), `batches_completed`, `batches_total`, `duration_ms`. **On `error_type === 'char_limit'`**, `consecutive_char_limit_failures` is overridden with the bumped (post-increment) value. |
| `documents_translation_stopped_by_user` | `STOP_DOC` Message | `run_id` only (no run context — STOP can fire even when no `runEventBase` is in scope) |

### `consecutive_char_limit_failures` — stuck-user counter

Per-install counter that increments on each `documents_translation_failed` with `error_type === 'char_limit'`, and resets to 0 on the next successful documents run. **Persists across calendar months** (deliberately — the 76+72 char_limit-failure observation that motivated this counter spanned weeks).

- Storage key: `analyticsStuckUserState_v1` in `chrome.storage.local`
- Mutated only via `analytics.{get,bump,reset}ConsecutiveCharLimitFailures()` in the SW (single-writer + serialized RMW via `withStuckUserLock`)
- Attached to every `documents_translation_*` event (via `runEventBase`)
- Reset on `documents_translation_completed`; the prior value is emitted as `consecutive_char_limit_failures_before_success`

### Allowed `file_type` values

`pdf`, `excel`, `pptx`. Plus from the **legacy** upload-page surface (`upload.js`): `docx` (mammoth.js path — currently broken). Filter via `source === "fullpage"` to compare apples to apples. Note: in `user_monthly_summary`, `excel` is mapped to `xlsx` for the canonical PostHog name (`documents_xlsx_completed_count`).

### Allowed `file_size_bucket` values

Canonical (from `js/buckets.js#bucketFileSize`): `<1MB`, `1-5MB`, `5-20MB`, `>20MB`.

### `resume_trigger` — implementierter Zustand

`explicit_button` is the only path wired today. `auto_on_load` is reserved for a future auto-resume feature.

---

## Canonical `error_type` vocabulary

Source of truth: `js/deepl-utils.js#normalizeErrorType`. All `*_translation_failed` events route their `error_type` through this normalizer so PostHog filters across `main_translation_failed` and `documents_translation_failed` work uniformly.

| Value | Meaning |
|---|---|
| `char_limit` | DeepL paywall hit. **Increments `consecutive_char_limit_failures`** on documents events. |
| `timeout` | Batch / run timed out. |
| `dom` | DeepL UI elements not found. |
| `network` | fetch / connectivity error. |
| `no_deepl_tab` | No DeepL tab open at run-start. |
| `rate_limited` | 429 from DeepL. |
| `other` | Catch-all. Pre-Phase-2 values like `batch_failed` and `unknown` collapse into this. |

> The internal `pausedReason` field on stored documents (state used by the popup UI) is **not** normalized — it includes additional values like `user` (user pressed Pop) that don't apply to analytics. Don't confuse the two.

---

## char_count_bucket values

Source of truth: `js/buckets.js#bucketChars`.

| Bucket | Range |
|---|---|
| `0-500` | n < 500 |
| `500-2k` | 500 ≤ n < 2000 |
| `2k-5k` | 2000 ≤ n < 5000 |
| `5k-10k` | 5000 ≤ n < 10000 |
| `10k-25k` | 10000 ≤ n < 25000 |
| `25k+` | n ≥ 25000 |

### Bucket / exact dual-write naming

Phase 2 added `*_exact` integer properties alongside the buckets, plus canonical `input_*` / `output_*` / `extracted_*` prefixes. The legacy bucket fields are kept on every event so existing dashboards keep working.

| Event | Legacy bucket | Phase-2 canonical |
|---|---|---|
| `main_*` | `char_count_bucket` | `input_char_count_bucket`, `input_char_count_exact` (+ `output_char_count_*` on completed) |
| `documents_extraction_completed` | `total_char_count_bucket` | `extracted_char_count_bucket`, `extracted_char_count_exact` |
| `documents_translation_*` | `total_char_count_bucket` | `total_char_count_exact` (+ `input_char_count_*` and `output_char_count_*` on completed) |

---

## Paywall analysis queries (HogQL)

These are the queries that justified Phase 2's existence. Each is runnable as-is in PostHog's HogQL editor.

> **Replace `now() - interval 30 day` with explicit date ranges** when you want to lock in a comparison window. Example results below are illustrative shapes, not real data.

### Q1 — Distribution of input chars per user per month (main flow)

```sql
SELECT
  period,
  CASE
    WHEN main_translation_total_chars_input < 1000   THEN '0-1k'
    WHEN main_translation_total_chars_input < 5000   THEN '1k-5k'
    WHEN main_translation_total_chars_input < 25000  THEN '5k-25k'
    WHEN main_translation_total_chars_input < 100000 THEN '25k-100k'
    WHEN main_translation_total_chars_input < 500000 THEN '100k-500k'
    ELSE '500k+'
  END AS bucket,
  count(distinct distinct_id) AS users
FROM events
WHERE event = 'user_monthly_summary'
  AND period_full_month = true
GROUP BY period, bucket
ORDER BY period DESC,
  -- preserve bucket ordering
  CASE bucket
    WHEN '0-1k' THEN 1 WHEN '1k-5k' THEN 2 WHEN '5k-25k' THEN 3
    WHEN '25k-100k' THEN 4 WHEN '100k-500k' THEN 5 ELSE 6
  END
```

**Example result shape**:

| period | bucket | users |
|---|---|---|
| 2026-04 | 0-1k | 312 |
| 2026-04 | 1k-5k | 187 |
| 2026-04 | 5k-25k | 94 |
| 2026-04 | 25k-100k | 41 |
| 2026-04 | 100k-500k | 12 |
| 2026-04 | 500k+ | 3 |

Read it: in April, 12 users translated between 100k–500k chars and 3 users went above 500k. **Filter `period_full_month = true`** to exclude install-month rollups (partial by definition).

### Q2 — Top 10 heavy users by cumulative chars in a single month

```sql
SELECT
  distinct_id,
  period,
  main_translation_total_chars_input,
  documents_total_chars_input,
  main_translation_total_chars_input + documents_total_chars_input AS total_chars,
  unique_active_days,
  documents_pdf_completed_count + documents_xlsx_completed_count + documents_pptx_completed_count AS docs_completed
FROM events
WHERE event = 'user_monthly_summary'
  AND period = '2026-04'
  AND period_full_month = true
ORDER BY total_chars DESC
LIMIT 10
```

**Example result shape**:

| distinct_id | period | main_chars | docs_chars | total_chars | active_days | docs_completed |
|---|---|---|---|---|---|---|
| 7a4f-... | 2026-04 | 184,210 | 312,540 | 496,750 | 24 | 17 |
| 1c2b-... | 2026-04 | 421,300 | 0 | 421,300 | 19 | 0 |
| 9e0d-... | 2026-04 | 38,100 | 287,900 | 326,000 | 12 | 9 |
| ... | | | | | | |

Read it: heavy users tend to either be document-heavy or main-heavy, rarely both. That changes the paywall positioning question — a chars-per-month gate captures both; a docs-completed gate misses the main-heavy cohort.

### Q3 — % of users who would hit threshold X (paywall calibration)

```sql
WITH per_user_month AS (
  SELECT
    distinct_id,
    surface,
    toStartOfMonth(timestamp) AS month,
    -- max() over bools = "did this user hit the flag at least once this month?"
    max(would_paywall_at_count_3)  AS hit_count_3,
    max(would_paywall_at_chars_5k) AS hit_5k,
    max(would_paywall_at_chars_25k) AS hit_25k
  FROM events
  WHERE event = 'paywall_eligibility_check'
    AND timestamp >= now() - interval 30 day
  GROUP BY distinct_id, surface, month
)
SELECT
  month,
  surface,
  count() AS total_users,
  countIf(hit_count_3) AS users_at_count_3,
  countIf(hit_5k)      AS users_at_5k,
  countIf(hit_25k)     AS users_at_25k,
  round(countIf(hit_count_3) * 100.0 / count(), 1) AS pct_at_count_3,
  round(countIf(hit_5k)      * 100.0 / count(), 1) AS pct_at_5k,
  round(countIf(hit_25k)     * 100.0 / count(), 1) AS pct_at_25k
FROM per_user_month
GROUP BY month, surface
ORDER BY month DESC, surface
```

**Example result shape**:

| month | surface | total_users | pct_at_count_3 | pct_at_5k | pct_at_25k |
|---|---|---|---|---|---|
| 2026-05 | main | 642 | 12.5 | 28.4 | 6.7 |
| 2026-05 | documents | 89 | 18.0 | 41.6 | 14.6 |

Read it: at a 5k-chars-per-month gate, ~28% of main-flow users would hit the paywall (and presumably need to upgrade or churn). At 25k it's ~7%. Use this to find the threshold that catches "real" heavy users without alienating casual ones. **Re-run with additional thresholds** (`would_paywall_at_chars_50k`, `_100k`) by extending the boolean fields in `analytics.js#paywallEligibilityCheck` — they're trivially extensible.

### Q4 — Tab dwell distribution per tab (engagement)

```sql
SELECT
  tab,
  had_interaction,
  count() AS samples,
  quantile(0.5)(dwell_ms)  AS p50_ms,
  quantile(0.9)(dwell_ms)  AS p90_ms,
  quantile(0.99)(dwell_ms) AS p99_ms,
  round(avg(dwell_ms))     AS mean_ms
FROM events
WHERE event = 'popup_tab_dwell'
  AND timestamp >= now() - interval 7 day
  AND dwell_ms < 600000  -- exclude pathological 10-min+ outliers
GROUP BY tab, had_interaction
ORDER BY tab, had_interaction DESC
```

**Example result shape**:

| tab | had_interaction | samples | p50_ms | p90_ms | p99_ms | mean_ms |
|---|---|---|---|---|---|---|
| main | true | 4,812 | 8,400 | 42,100 | 132,000 | 18,300 |
| main | false | 1,210 | 2,100 | 8,400 | 28,000 | 4,200 |
| history | true | 142 | 6,200 | 31,000 | 88,000 | 14,100 |
| history | false | 1,807 | 1,400 | 5,200 | 16,000 | 2,900 |
| loop | true | 88 | 9,100 | 38,000 | 95,000 | 16,400 |
| loop | false | 2,041 | 2,600 | 8,100 | 22,000 | 4,800 |
| pdf | true | 612 | 7,400 | 28,000 | 91,000 | 14,200 |
| pdf | false | 1,003 | 2,800 | 9,000 | 24,000 | 5,100 |

Read it: History and Loop have very high `had_interaction = false` sample counts compared to `true` — that's the "lots of views, very few actions" gap quantified. Compare ratios: main has ~80% interactions, history has ~7%, loop has ~4%. Pick a threshold for "is this tab pulling its weight?".

### Q5 — Stuck-user detection (DeepL char_limit recovery)

Two complementary queries.

**Currently stuck users (max streak in the window):**

```sql
SELECT
  distinct_id,
  max(consecutive_char_limit_failures) AS max_streak,
  count() AS char_limit_events
FROM events
WHERE event = 'documents_translation_failed'
  AND error_type = 'char_limit'
  AND timestamp >= now() - interval 30 day
GROUP BY distinct_id
HAVING max_streak >= 5
ORDER BY max_streak DESC
LIMIT 50
```

**Breakthrough events (the user finally got unstuck):**

```sql
SELECT
  distinct_id,
  toStartOfDay(timestamp) AS day,
  consecutive_char_limit_failures_before_success
FROM events
WHERE event = 'documents_translation_completed'
  AND consecutive_char_limit_failures_before_success >= 5
  AND timestamp >= now() - interval 30 day
ORDER BY consecutive_char_limit_failures_before_success DESC
LIMIT 50
```

**Example result shape (breakthrough)**:

| distinct_id | day | streak_before_success |
|---|---|---|
| 4f9c-... | 2026-05-08 | 76 |
| 8b2e-... | 2026-05-03 | 72 |
| 0a17-... | 2026-04-29 | 18 |

Read it: the two outliers from the original audit (76 and 72 streaks) would have surfaced via the second query as a single PostHog filter rather than requiring manual sequence correlation across hundreds of events.

---

## Migration / Vorher → Nachher

### Phase 1 (2026-05-07) — see `tracking-audit-phase1.md`

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
| `document_translation_*` | `documents_translation_*` | background.js |

### Phase 2 (2026-05-10) — additive only

No event renames. New properties are additive on existing events; legacy property names (`char_count_bucket`, `total_char_count_bucket`) are preserved alongside the new canonical names so existing dashboards keep working. Three new events: `popup_tab_dwell`, `paywall_eligibility_check`, `user_monthly_summary`.

---

## Bekannte Limitierungen / Datenwarnungen

1. **Pre-Phase-2 events lack the `*_exact` and `lang_*` properties.** Filter `timestamp >= 'YYYY-MM-DD'` (deploy date) when computing distributions that depend on those fields.
2. **`total_char_count_bucket` may render as `null`** on `documents_translation_started` rows fired before commit `554e5d7` (2026-05-07). Filter the timestamp to exclude pre-fix rows.
3. **`error_type` vocabulary changed in Phase 2.** Old rows may carry `batch_failed` or `unknown`; new rows normalize those to `other`. When comparing across the cutoff, include both: `error_type IN ('other', 'batch_failed', 'unknown')`.
4. **`main_session_summary` can be lost on popup close.** pagehide hooks in MV3 popups aren't 100% reliable. For end-of-session analysis, prefer `popup_tab_dwell` events (port-based, more reliable).
5. **Legacy upload-page** (`upload.js` / `upload-page.html`) emits `documents_file_selected` with old size_bucket values. Filter via `source === "upload_page"`.
6. **Doppelte Stop-Events bei Loop**: `loop_aborted` (reason=user_stopped) UND `loop_run_cancelled` feuern beide.
7. **Pre-existing queue race in `enqueueEvent`** (analytics.js): two near-simultaneous `capture()` calls can lose the earlier one's queue write. Last-write-wins. Tracked in `tracking-audit.md` §6 — out of scope for Phase 2; the monthly tracker has its own mutex that's not affected.

---

**Ende der Event-Reference. Letzte Änderung: 2026-05-10.**
