# PostHog Insights TODO — DeepL Pro Unlimited

**Stand:** 2026-05-07 (post Phase 2/3 deployment)

This is the to-build list for PostHog dashboards / insights once the new tracking is live and has accumulated ~1 week of data. Each item names the question it answers, the chart type, and the events / filters needed.

Order is roughly by business value — the first three were the explicit motivating questions for this tracking pass.

---

## 1. ⭐ Bar chart — Save-format distribution across all History saves

> **Direkt antwortet:** "Sind 6 Single-Save-Formate zu viele?"

- **Insight type:** Bar chart, breakdown by `format`.
- **Events:** `history_single_save_clicked` UNION `history_bulk_save_clicked`.
- **Breakdown:** `format`.
- **Optional split:** `source` (`popup` vs `detail_page`) — answers "wird die Detail-Seite überhaupt zum Speichern genutzt?".
- **Filter:** Last 30 days.
- **Action threshold:** Wenn ein Format <2% aller Saves hat → Kandidat zum Entfernen.

Zweitansicht — gleiches Insight aber nur `history_bulk_save_clicked`:
- Beantwortet: "Brauchen wir Word für Bulk wirklich, oder reicht TXT?"
- `format` Werte hier nur: `txt`, `word`.

---

## 2. ⭐ Funnel — Loop / Batch tab usage

> **Direkt antwortet:** "Wird der Batch-Tab überhaupt sinnvoll genutzt?"

**Funnel steps:**
1. `loop_tab_viewed_state` (any)
2. `loop_group_created`
3. `loop_subentry_added`
4. `loop_start_clicked`
5. `loop_run_started`
6. `loop_run_completed`

- **Insight type:** Funnel.
- **Conversion window:** 1 day per popup_session_id.
- **Breakdown idea:** `loop_subentry_added.method` to see if multi-paste users convert better than single-add users.
- **Action threshold:** Wenn Drop-off zwischen Step 1 und Step 2 >80% → Tab ist Cargo-Cult, kandidatieren zum Entfernen.

**Companion-Insight — abort-reasons:**
- **Insight type:** Bar chart, breakdown by `reason`.
- **Event:** `loop_aborted`.
- **Zweck:** Wenn `deepl_not_open` dominiert → UX-Hinweis "Open DeepL first" prominenter machen. Wenn `no_entries` dominiert → Start-Button bei leerer Group disablen.

---

## 3. ⭐ Funnel — Documents reload heuristic UX-Gap

> **Direkt antwortet:** "Wissen User, dass Reload das Problem löst?"

**Funnel steps:**
1. `documents_translation_failed` (any error_type)
2. EITHER `documents_failed_state_viewed` (popup) OR `documents_page_reloaded_during_translation` (fullpage)
3. `documents_resume_button_clicked`
4. `documents_translation_resumed`
5. `documents_translation_completed`

- **Insight type:** Funnel.
- **Conversion window:** 7 days per `distinct_id`.
- **Breakdown idea:** `documents_translation_failed.error_type` — manche Fehler sind selbsterklärend (char_limit), andere nicht (timeout).
- **Action threshold:**
  - Wenn Drop-off Step 2 → Step 3 >50% → User sehen den Failed-State, kommen aber nicht auf den Resume-Button. UX-Hinweis nötig.
  - Wenn `documents_page_reloaded_during_translation` >> `documents_failed_state_viewed` → User reloaden ohne den Tab zu öffnen. Onboarding-Hinweis im Failed-State.

---

## 4. Funnel — Main-tab button sequences

> **Antwortet:** "In welcher Konstellation werden Main-Tab Buttons verwendet?"

**Mehrere Funnels parallel:**

| Funnel name | Steps |
|---|---|
| Paste → Magic Fix → Send | `main_paste_used` → `main_magic_fix_used` → `main_send_to_deepl_clicked` → `main_translation_completed` |
| Paste → Send (skip Magic Fix) | `main_paste_used` → `main_send_to_deepl_clicked` → `main_translation_completed` |
| Send → Copy result | `main_translation_completed` → `main_copy_used` |

- **Conversion window:** Pro `popup_session_id` (Trends > Filters > "popup_session_id is set").
- **Insight type:** Funnel.

**Companion-Insight — main_session_summary breakdown:**
- **Insight type:** Bar chart on `main_session_summary`.
- **Breakdown:** `actions_used` (Array-Property — PostHog rendert das als Multi-Value).
- **Zweck:** Top 10 Action-Konstellationen pro Popup-Open. Die häufigste Konstellation zeigt den Default-Workflow; alles drunter ist Long-Tail.

---

## 5. Magic-Fix-Effektivität

> **Antwortet:** "Macht Magic Fix sichtbar Arbeit, oder wird er reflexhaft geklickt?"

- **Insight type:** Bar chart on `main_magic_fix_used`.
- **Breakdown:** `chars_removed_bucket`.
- **Action threshold:** Wenn der `0-500` (≈"nichts geändert") Bucket >50% hat → User klicken Magic Fix unnötig. Tooltip härten oder Default deaktivieren.

---

## 6. File-type-distribution für Dokumente

> **Antwortet:** "Welcher Dateityp wird am meisten verwendet?"

- **Insight type:** Bar chart on `documents_file_selected`.
- **Breakdown:** `file_type`.
- **Filter:** `source === "fullpage"` (canonical Pfad; legacy upload-page rausfiltern).
- **Companion:** Same chart breakdown by `file_size_bucket` — entscheidet ob Performance-Optimierungen für große Dateien Priorität haben.

**Failure-Rate per file_type:**
- **Insight type:** Funnel `documents_file_selected → documents_extraction_completed → documents_translation_started → documents_translation_completed`.
- **Breakdown:** `file_type`.
- **Zweck:** PPTX hat typischerweise höhere Extraktionsraten als skurriles PDF. Wenn ein Typ besonders schlecht abschneidet → Library-Update oder Warnung im UI.

---

## 7. Time-to-first-action pro Popup-Mount

> **Antwortet:** "Wie schnell ist der User aktiv? Findet er was er sucht?"

- **Insight type:** Trend, Function: average time between events.
- **Events:** `popup_opened` → erstes `<bereich>_*` Event mit derselben `popup_session_id`.
- **Implementation:** PostHog's "time-to-event" function with `popup_session_id` als correlation key. Das ist nicht out-of-the-box ein Standard-Insight — eventuell als HogQL-Query bauen.

**Variant:** Histogramm der Zeit zwischen `popup_opened` und `popup_pagehide` (über alle Sessions). Median-Session-Length als Indikator.

---

## 8. History-Detail-Engagement

> **Antwortet:** "Schauen User die Details wirklich an oder schließen sie sofort?"

- **Insight type:** Histogram on `history_details_closed.duration_ms`.
- **Buckets:** `< 2s`, `2-5s`, `5-15s`, `15-60s`, `> 60s`.
- **Action threshold:** Wenn `< 2s` Bucket >50% → Detail-Seite ist Cargo-Cult oder die Daten dort wertlos. Inhalts-Audit machen.

**Companion:** Conversion-Rate von `history_entry_clicked` → `history_details_opened`. Wenn <100% → Page-Loading-Probleme oder Popup-Closes vor Tab-Open.

---

## 9. Resume-Verhalten Histogramm

> **Antwortet:** "Wie lange liegt ein fehlgeschlagenes Dokument rum, bevor User resume drücken?"

- **Insight type:** Histogram on `documents_translation_resumed.time_since_failure_ms`.
- **Buckets:** `< 1min`, `1-10min`, `10-60min`, `1-24h`, `> 24h`.
- **Zweck:** Innerhalb 1 Minute = "User hat sofort gesehen, dass es kaputt ging und hat reagiert" → Failed-State-UI funktioniert. >24h = "User hat es vergessen, kommt zurück" → braucht aktive Erinnerung (Badge / Tab-Title).

---

## 10. Empty-state Bounce-Rate pro Tab

> **Antwortet:** "Welche Tabs werden geöffnet, dort aber nichts gemacht?"

- **Insight type:** Bar chart, custom calculation per tab.
- **Per Tab:**
  - Loop: count(`loop_tab_viewed_state` where entry_count=0) / count(`loop_tab_viewed_state`)
  - History: count(`history_tab_viewed_state` where entry_count=0) / count(`history_tab_viewed_state`)
  - Documents: count(`documents_tab_viewed_state` where has_pending_translation=false) / count(`documents_tab_viewed_state`)
- **Zweck:** Empty-Tabs ohne Follow-up-Action sind UX-Schwachstellen.

---

## 11. Setup für Lifecycle-Tracking

> Nicht ein Insight per se, aber für die obigen Funnels nötig.

- PostHog Person-Properties auf `extension_version` setzen (heute schon Property auf jedem Event — als Person-Property gepinnt feed das Cohort-Filter).
- Cohort: "Hat installed in den letzten 7 Tagen" via `extension_installed`.
- Cohort: "Aktiv (Popup geöffnet) in den letzten 14 Tagen" via `popup_opened`.
- Cohort: "Power-User Loop" — `loop_run_completed` ≥3 mal in 30 Tagen.

---

## 12. Sanity-Check-Insight (sofort einrichten)

> Damit Du sofort siehst, ob die neue Pipeline funktioniert.

- **Insight type:** Trend.
- **Events:** Stacked counts der wichtigsten neuen Events der letzten 7 Tage:
  - `loop_tab_viewed_state`
  - `main_session_summary`
  - `history_tab_viewed_state`
  - `documents_tab_viewed_state`
  - `documents_file_selected` (source=`fullpage`)
- **Erwartung:** Ab Deployment sofortiger Anstieg, etwa proportional zu `popup_opened`.
- **Wenn ein Event 0 zeigt → Bug in der Implementation.** Dev-Console-Test-Hinweis: Suche nach `📊 Tracked: <event_name>` und `📡 track.js loaded in:` Logs in den vier Surfaces.

---

**Ende der TODO-Liste.**

Wenn Du nach 1–2 Wochen Daten sammelst und Schlussfolgerungen ziehst, kann diese Datei als "abgehakt" markiert oder gelöscht werden. Idealerweise wandert ein Teil davon dann in eine `decisions.md` oder ein PostHog-Dashboard mit dauerhaften Insights.
