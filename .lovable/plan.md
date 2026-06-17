# Binah.ai — CEO Briefing DOCX

A one-off, polished Word document for the new CEO. Re-runnable on demand. No new app surface.

## Scope

- Workspace: **Binah.ai Workspace** (20 leads with at least one meeting summary).
- Per lead, pull together:
  - Company + what they do (from `leads.industry`, `leads.website`, `lead_context_items` of category `company_info`, and inference from meeting summaries).
  - Use case for Binah (extracted from meeting summaries + emails).
  - Opportunity size (AI-extracted $ range with confidence + source quote; "TBD" when no signal).
  - Milestones (merge `meeting_ai_summaries.milestones` + `lead_intelligence.milestones_json`).
  - Open topics (merge `meeting_ai_summaries.open_questions` + `lead_intelligence.objections_json` + `deal_memory.unresolved_objections` + `unanswered_questions`).

## Approach

1. **Data pull** (single SQL): for each of the 20 leads, fetch lead row, every `meeting_ai_summaries` row, latest `lead_intelligence`, `deal_memory`, and key `lead_context_items` (company_info, use_case, pain_point, decision_criteria). Compact into one JSON blob per lead.
2. **AI pass 1 — per-lead enrichment** (Lovable AI, Gemini Flash, parallel, ~20 calls): for each lead emit structured JSON `{ company, what_they_do, use_case_for_binah, segment_candidate, opportunity: {amount_usd, range, confidence, evidence_quote}, milestones[], open_topics[] }`. Strict schema, citations required, "Unknown" allowed.
3. **AI pass 2 — segment clustering** (1 call): feed all 20 `segment_candidate` strings + use-case summaries, get back 4–7 named market segments with a 1-line thesis each and lead → segment mapping. Reviewable in the doc so the team can debate naming.
4. **DOCX generation** via the `docx` skill (docx-js). Re-uses Binah brand cues if found in `public/`; otherwise clean editorial styling (Arial, navy accent, US Letter).
5. **QA**: render every page to image, scan for clipping/overflow, fix, re-emit.

## Document structure

```text
Cover
  Binah.ai — Pipeline Briefing for the CEO
  As of <date> · 20 accounts in active dialogue

Executive Summary (1 page)
  - Pipeline at a glance: # accounts, # post-meeting, # closing, est. TAM of named opps
  - 4–7 market segments with one-line thesis + account count + summed opportunity
  - Top 5 accounts by opportunity size

Segment Sections (one per segment, repeated)
  ## <Segment Name>
  Thesis: <one line>
  Accounts: N · Estimated opportunity: $X
  Per account, a compact card:
     Company · what they do · use case for Binah
     Opportunity: $ range (confidence) — "quoted evidence"
     Milestones: bullets
     Open topics: bullets

Appendix
  - Methodology + data sources + freshness
  - Accounts excluded (engaged-only, no meeting summary yet) for transparency
```

## Visual treatment (CEO-friendly, not generic)

- Cover: full-bleed navy block, large serif-free title, small metadata strip.
- Segment headers: colored sidebar + segment number, content count chip.
- Account cards: 2-column table — left = identity + opportunity badge, right = milestones / open topics.
- Opportunity badge: pill with $ range and confidence (High / Medium / Low / TBD).
- No clipart, no purple gradients. Black + one accent color sampled from any Binah brand asset in the repo (fallback: deep teal `#0F766E`).
- Page footer: "Confidential · Binah.ai · generated <date>".

## Deliverable

- `/mnt/documents/binah_ceo_briefing.docx` — surfaced inline via `presentation-artifact`.
- Also drop `/mnt/documents/binah_ceo_briefing_data.json` so the team can re-style or re-export without re-running AI.

## Out of scope (for this pass)

- No in-app report page, no schema change for deal value, no editable opportunity in UI. Each is a follow-up if useful.
- No re-write of `lead_intelligence`; AI output stays in the doc only.

## Open question I'll proceed with a default on unless you say otherwise

- **Segments count**: I'll let the AI choose between 4 and 7 segments. If you already have a Binah taxonomy in mind (e.g. Telehealth, RPM, Insurance, Fitness/Wearables, Clinical Trials, Workforce Wellness), reply with the list and I'll pin to it.
