# Tracking Audit — Phase 2 (Property Completeness)

**Stand:** 2026-05-10
**Scope:** Audit existing analytics events for property completeness, naming
consistency, and the gaps that block paywall threshold calibration.
**Predecessor:** Phase 1 (2026-05-07) coverage audit lives in
[`tracking-audit-phase1.md`](./tracking-audit-phase1.md). Phase 1 closed
the "events don't fire" gaps; Phase 2 closes the "events fire but lack
the data we need" gaps.

---

## TL;DR

1. **Main translation has no character-count granularity beyond buckets.**
   No exact counts. No `lang_from` / `lang_to`. No `run_id` to join started
   → completed/failed pairs. This is the single biggest blocker for picking a
   sensible chars-per-month paywall threshold.
2. **Documents flow has the right shape but uneven coverage.** `total_char_count_bucket`
   is on `documents_translation_started/completed`, but no exact count, no
   `lang_from`/`lang_to`, and `batches_completed` is omitted on the success
   path.
3. **Naming inconsistency between surfaces.** Main uses `char_count_bucket`;
   documents uses `total_char_count_bucket`. Both refer to the same concept
   (input chars). Standardise on `input_char_count_bucket` going forward.
4. **No singular `document_translation_*` events exist.** The original
   request implied a singular/plural inconsistency between fullpage and SW.
   It does not exist in the code — fullpage.js never fires translation
   events; only `documents_file_*` and `documents_extraction_*`. All
   document translation events come from the SW (`background.js`) with
   plural names. The 162 `char_limit` failures attributed to "the
   fullpage flow" came from `documents_translation_failed` (plural,
   SW-fired). No standardisation work needed — this is a non-issue.
5. **Per-user aggregates must be computed post-hoc in PostHog.** With
   thousands of events per user per month, aggregate queries get slow and
   expensive. A snapshotting `user_monthly_summary` event closes that.
6. **Tab engagement is invisible.** `popup_tab_viewed` fires on every tab
   switch but says nothing about whether the user spent 200ms or 80s on
   that tab, or interacted with anything inside it.
7. **No paywall-readiness baseline.** Even though no paywall is wired
   today, we should fire `paywall_eligibility_check` at the would-be
   trigger points so when a paywall comes back we have last-month's
   baseline already in PostHog.

---

## 1. Base properties — uniformly attached?

Every event automatically carries (from `track.js` or `analytics.js`):

| Property | Source | Coverage | Notes |
|---|---|---|---|
| `distinct_id` | `analytics.js` (PostHog) | ✅ all events | UUID per install. Stable across browser restarts. |
| `extension_version` | `analytics.js` | ✅ all events | From manifest. |
| `browser_language` | `analytics.js` | ✅ all events | From `navigator.language` (SW context — `navigator` is available in MV3 SW). |
| `$lib` | `analytics.js` | ✅ all events | Always `chrome-extension`. |
| `tab_context` | `track.js` | ✅ page-side events only | Not on SW-side events. Documented and intentional. |
| `popup_session_id` | `track.js` | ✅ events from popup.html only | Sequence-scope identifier per popup mount. |

**Verdict:** baseline is solid. No changes needed here.

---

## 2. Event inventory — what each event currently carries

Sourced from `popup.js`, `background.js`, `fullpage.js`, `loop.js`. Sub-agent
mapped 50+ call sites. Properties listed are the ones explicitly passed
at the call site, on top of the base properties from §1.

### 2.1 App-level

| Event | Properties | File |
|---|---|---|
| `popup_opened` | – | popup.js:15 |
| `popup_tab_viewed` | `tab` | popup.js:84 |
| `settings_opened` | – | popup.js:20 |
| `extension_installed` | `version` | analytics.js:137 |
| `extension_updated` | `from`, `to` | analytics.js:139 |

### 2.2 Main translation

| Event | Properties | File:line |
|---|---|---|
| `main_send_to_deepl_clicked` | `char_count_bucket`, `has_text`, `trigger` | popup.js:459 |
| `main_send_aborted` | `reason`, `char_count_bucket` | popup.js:479 |
| `main_translation_started` | `char_count_bucket` | popup.js:492 |
| `main_translation_completed` | `char_count_bucket`, `duration_ms` | popup.js:543 |
| `main_translation_failed` | `char_count_bucket`, `error_type`, `duration_ms` | popup.js:583 |
| `main_session_summary` | `actions_used`, `action_count` | popup.js:40 |
| `main_paste_used` | `char_count_bucket`, `had_text` | popup.js:749 |
| `main_copy_used` | `target`, `char_count_bucket` | popup.js:722 |
| `main_clear_used` | `target`, `char_count_bucket` | popup.js:787 |
| `main_magic_fix_used` | `char_count_bucket_pre`, `char_count_bucket_post`, `chars_removed_bucket` | popup.js:690 |
| `main_swap_used` | `had_input`, `had_output` | popup.js:651 |

### 2.3 Documents

| Event | Properties | File:line |
|---|---|---|
| `documents_tab_viewed_state` | `has_pending_translation`, `pending_count`, `pending_file_types`, `has_failed_state`, `failed_count` | popup.js:148 |
| `documents_failed_state_viewed` | `pending_status`, `pending_file_type`, `paused_count`, `error_count`, `pending_count_total` | popup.js:167 |
| `documents_open_fullpage_clicked` | `reopened` | popup.js:1144 |
| `documents_resume_button_clicked` | – | popup.js:1200 |
| `documents_pending_doc_deleted` | – | popup.js:1211 |
| `documents_page_reloaded_during_translation` | `pending_status`, `pending_file_type`, `paused_count`, `error_count`, `pending_count_total`, `time_since_failure_ms` | fullpage.js:85 |
| `documents_file_selected` | `file_type`, `file_size_bucket`, `source` | fullpage.js:169 |
| `documents_file_rejected` | `reason`, `file_size_bucket`, `mime_type`, `source`(drop)/–(picker) | fullpage.js:116, 151 |
| `documents_extraction_completed` | `file_type`, `page_count`, `total_char_count_bucket` | fullpage.js:216 |
| `documents_extraction_failed` | `file_type`, `file_size_bucket`, `error_class` | fullpage.js:254 |
| `documents_translation_started` | `run_id`, `file_type`, `page_count`, `batch_count`, `total_char_count_bucket` | background.js:148 |
| `documents_translation_resumed` | `run_id`, `file_type`, `page_count`, `batch_count`, `total_char_count_bucket`, `resume_trigger`, `time_since_failure_ms`, `previous_status` | background.js:137 |
| `documents_translation_completed` | `run_id`, `file_type`, `batch_count`, `batches_total`, `total_char_count_bucket`, `duration_ms` | background.js:338 |
| `documents_translation_failed` | `run_id`, `file_type`, `error_type`, `batches_completed`, `batches_total`, `duration_ms` | background.js:164/308/362 |
| `documents_translation_stopped_by_user` | `run_id` | background.js:81 |

### 2.4 History

| Event | Properties | File:line |
|---|---|---|
| `history_tab_viewed_state` | `has_entries`, `entry_count` | popup.js:127 |
| `history_entry_clicked` | `action` | popup.js:953 |
| `history_single_save_clicked` | `format`, `source` | popup.js:991 |
| `history_bulk_copy_clicked` | `entry_count`, `char_count_bucket` | popup.js:231 |
| `history_bulk_save_clicked` | `format`, `entry_count` | popup.js:253, 278 |
| `history_entry_deleted` | `source` | popup.js:1003 |
| `history_bulk_deleted` | `entry_count` | popup.js:301 |

### 2.5 Loop

| Event | Properties | File:line |
|---|---|---|
| `loop_tab_viewed_state` | `has_entries`, `entry_count`, `total_subentries` | popup.js:114 |
| `loop_start_clicked` | `iteration_count` | loop.js:209 |
| `loop_aborted` | `reason`, `iteration_count`, `iterations_completed`(deepl_lost) | loop.js:219, 237, 275, 1069 |
| `loop_run_started` | `iteration_count` | loop.js:248 |
| `loop_run_completed` | `iteration_count`, `iterations_completed`, `iterations_failed`, `duration_ms` | loop.js:348 |
| `loop_run_failed` | `iteration_count`, `iterations_completed`, `iterations_failed`, `duration_ms`, `error_type`(catch only) | loop.js:346, 355 |
| `loop_run_cancelled` | `iteration_count`, `iterations_completed`, `iterations_failed`, `duration_ms` | loop.js:344 |
| `loop_group_created` | `entry_count_after` | loop.js:989 |
| `loop_group_edited` | `char_count_bucket` | loop.js:1229 |
| `loop_group_deleted` | – | loop.js:1282 |
| `loop_subentry_added` | `method`, `count` | loop.js:845, 859, 898 |
| `loop_subentry_edited` | `char_count_bucket` | loop.js:1282 |
| `loop_subentry_deleted` | – | loop.js:1282 |
| `loop_group_reordered` | – | loop.js:411 |
| `loop_subentry_reordered` | – | loop.js:443 |
| `loop_copy_used` | `char_count_bucket` | loop.js:692 |
| `loop_paste_used` | `char_count_bucket` | loop.js:708 |
| `loop_clear_used` | `char_count_bucket` | loop.js:721 |

---

## 3. Inconsistencies and gaps that block paywall calibration

### 3.1 Char-count granularity is bucketed-only

Every char-count today is a `*_bucket` value (`0-500`, `500-2k`, ..., `25k+`).
Buckets work for at-a-glance dashboards but not for threshold tuning. A
question like *"if we put a paywall at 7,500 chars/month, what % of users
hit it?"* needs the exact integer count, not a bucket. **None of the
existing events carry an exact count.**

### 3.2 No `run_id` on main flow

`documents_translation_started/completed/failed` carries `run_id` (UUID
generated in `background.js:121` per run). Main translation events do not
— so joining `main_translation_started` to its matching `_completed` /
`_failed` is by `popup_session_id` only, which is too coarse (one popup
session can do multiple sends).

### 3.3 No language pair tracking

Neither main nor documents events carry `lang_from` / `lang_to`. We can
see *that* a user translated 25k chars but not *which language pair*. For
DeepL specifically this matters because some pairs are slower and more
likely to time out, which biases the failure data.

### 3.4 Silent property gaps

| Event | Missing today | Why it matters |
|---|---|---|
| `main_send_to_deepl_clicked` | `lang_from`, `lang_to`, `was_pasted`, `*_exact` | Click-funnel intent vs eventual run; can't bin paste-driven users. |
| `main_translation_started` | `run_id`, `*_exact`, `lang_*`, `batch_count` | Can't join to completed/failed reliably. |
| `main_translation_completed` | `run_id`, `output_char_*` (exact + bucket), `lang_*`, `batch_count`, `batches_completed` | Output count is what DeepL actually returned — needed to spot truncation. |
| `main_translation_failed` | `run_id`, `*_exact`, `batches_completed`, `batches_total` | Can't measure how far failed runs got. |
| `main_send_aborted` | `batches_completed`, `duration_ms` | Aborts during a batch loop today look identical to immediate aborts. |
| `documents_extraction_completed` | `extracted_char_count_exact`, `extraction_duration_ms`, `mime_type` | Have the bucket; not the integer. |
| `documents_translation_started` | `total_char_count_exact`, `lang_*` | Bucket exists; integer doesn't. |
| `documents_translation_completed` | `input_char_count_exact`, `output_char_count_*` (exact + bucket), `lang_*`, `batches_completed` | Same. Plus output count. |
| `documents_translation_failed` | `total_char_count_bucket`, `total_char_count_exact`, `lang_*` | Failed events don't carry char counts at all today. |

### 3.5 `total_char_count_bucket` appearing as null in PostHog

Hypotheses (sub-agent + `git log`):

1. **Most likely: pre-fix event rows.** The property was added in commit
   `554e5d7 feat(tracking): documents tab events + fix content.js timeout/char_limit tautology`
   and the file-naming convention `documents_*` plural is from that
   commit set. PostHog rows fired before that commit lack the property
   entirely → render as null in the export.
2. **Code-side fallback never produces null today.** Defensive code
   (`background.js:167`) computes `(doc.originalText || '').length`,
   bucketed via `bucketChars(0) === '0-500'`. So even an empty doc
   yields `"0-500"`, not null. No null-producing path exists currently.
3. **Verify hypothesis 1** with a PostHog filter: `event = "documents_translation_started"` AND `timestamp >= '2026-05-07'` → if `total_char_count_bucket` is ~100% populated post-cutoff, hypothesis 1 is confirmed.

**Action:** none on the code side. The fix is forward-only — once Phase 2
ships, this field will additionally carry an exact count, removing the
ambiguity.

### 3.6 `batches_completed` missing on documents success path

`documents_translation_completed` (background.js:338) carries
`batch_count` and `batches_total` but not `batches_completed`. On the
success path they're equal by definition. On the failure path
`batches_completed` *is* sent. Inconsistent — adding it to success makes
PostHog filters uniform.

### 3.7 `file_type` propagation gap

`documents_file_selected` carries `file_type`. The downstream
`documents_extraction_completed` also carries it, sourced from the same
local variable. *However*, in some PostHog rows `file_type` is reportedly
unknown — most likely from the legacy `upload-page.html` path
(`upload.js`) which uses different bucket conventions and may not always
set the field. Filter via `source === "fullpage"` to isolate the modern
path; we'll verify the gap in implementation.

### 3.8 Singular vs plural naming — no actual gap

The original task description suggested a singular `document_translation_*`
naming on fullpage.js conflicting with plural `documents_translation_*`
on background.js. **No singular events exist.** The fullpage code
(`fullpage.js`) only fires `documents_file_*` and `documents_extraction_*`
— it does not fire any translation events. All document translation
events fire from the service worker with plural names. The 162 `char_limit`
failures attributed to "the fullpage flow" actually came from
`documents_translation_failed` (plural, SW-fired).

**Conclusion:** No standardisation work required for this. Documented
here so future PRs don't re-investigate.

### 3.9 `consecutive_char_limit_failures` is invisible

The 76+72 char_limit failures from two users would have been spotted
weeks earlier if a per-user counter ticked into a property and a single
PostHog filter `consecutive_char_limit_failures > 5` would have surfaced
them. Today there is no such counter.

### 3.10 Tab engagement is invisible

`popup_tab_viewed` fires on every tab switch — so we know how often
each tab is opened, but not:

- How long the user stayed on the tab
- Whether they did anything inside it before switching away

This is the gap behind the user-noted "lots of views, very few actions"
on History and Loop.

---

## 4. Required additions — summary

### 4.1 New properties on existing events (additive, no rename)

| Event | New props |
|---|---|
| `main_send_to_deepl_clicked` | `input_char_count_bucket`, `input_char_count_exact`, `lang_from`, `lang_to`, `was_pasted` |
| `main_translation_started` | `input_char_count_bucket`, `input_char_count_exact`, `lang_from`, `lang_to`, `batch_count`, `run_id` |
| `main_translation_completed` | `input_char_count_bucket`, `input_char_count_exact`, `output_char_count_bucket`, `output_char_count_exact`, `lang_from`, `lang_to`, `duration_ms`(already), `batch_count`, `batches_completed`, `run_id` |
| `main_translation_failed` | `input_char_count_bucket`, `input_char_count_exact`, `error_type`(already), `batches_completed`, `batches_total`, `duration_ms`(already), `run_id` |
| `main_send_aborted` | `input_char_count_bucket`, `reason`(already), `batches_completed`, `duration_ms` |
| `documents_file_selected` | `mime_type` (was on rejected only) |
| `documents_extraction_completed` | `extracted_char_count_bucket`(rename `total_char_count_bucket` to this on this event for clarity), `extracted_char_count_exact`, `extraction_duration_ms`, `mime_type` |
| `documents_translation_started` | `total_char_count_exact`, `lang_from`, `lang_to` |
| `documents_translation_resumed` | `total_char_count_exact`, `lang_from`, `lang_to` |
| `documents_translation_completed` | `input_char_count_exact`, `output_char_count_bucket`, `output_char_count_exact`, `lang_from`, `lang_to`, `batches_completed` |
| `documents_translation_failed` | `total_char_count_bucket`, `total_char_count_exact`, `lang_from`, `lang_to` |

### 4.2 New events

| Event | When | Purpose |
|---|---|---|
| `user_monthly_summary` | First `popup_opened` of a new UTC month, snapshotting the previous month | Per-user aggregate in one query, not thousands of joins |
| `popup_tab_dwell` | On tab switch and on popup `pagehide` | Time-on-tab + had_interaction signal |
| `paywall_eligibility_check` | At `main_send_to_deepl_clicked` and at `START_DOC` | Baseline for paywall threshold tuning without showing a paywall |

### 4.3 New user-level counter

`consecutive_char_limit_failures`: integer, stored in
`chrome.storage.local`. Increments on `documents_translation_failed`
when `error_type === 'char_limit'`; resets on any successful run.
Attached as a property on every `documents_translation_*` event so it's
visible in PostHog without aggregation.

### 4.4 Privacy invariants for `*_exact` properties

`*_exact` is a positive integer (or `null` if the count cannot be
computed). It is never the source text, never the translated text. A
one-line comment is added at every `*_exact` call site stating this.

---

## 5. Implementation order

1. **Consolidate `bucketChars()`** — single source of truth in
   `analytics.js`; `track.js` and `background.js` re-export.
2. **Main flow char tracking** — add input/output char counts, lang,
   run_id to all `main_*` events. (Largest single change to popup.js.)
3. **Documents flow backfill** — add the missing exact counts and lang
   props. Smaller change because the event scaffolding already exists.
4. **Monthly tracker + `user_monthly_summary`** — new infrastructure in
   `analytics.js`. Hook all `*_completed` events.
5. **Tab dwell** — small popup.js addition.
6. **Paywall eligibility** — small new event, reuses monthly tracker.
7. **Data quality fixes** — `consecutive_char_limit_failures`,
   `mime_type` propagation, lang on every translation event.
8. **Update `tracking-events.md`** — append new events + props, add
   PostHog query cookbook section.

---

## 6. Out of scope

- The `paywall.js` module and the popup-side `Paywall.checkPdfPaywall`
  call. The paywall has been removed; we leave it removed.
- Any change to the translation logic itself (DeepL DOM scraping in
  `content.js`, batching in `background.js`).
- ExtensionPay / `js/ExtPay.js`.
- Renaming any existing event. **Additive only.**

---

**End of audit. Next step:** implement steps §5.1–5.2 and check in.
