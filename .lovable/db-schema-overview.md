# Database Schema Overview

_Generated 2026-04-16 · 106 migrations · 57 tables_

---

## 1. Major Tables by Domain

### Core Revenue Object

| Table | Role | Size | Source of Truth For |
|-------|------|------|---------------------|
| **leads** | Primary business entity — merged Lead + Opportunity. Stores contact info, stage, motion, scoring fields, action scheduling (`needs_action`, `next_action_key`, `eligible_at`), nurture state, and automation counters. | ~2 MB | Lead lifecycle, pipeline stage, automation eligibility |
| **lead_intelligence** | AI-computed insights per lead (1:1). Buying signals, objections, risks, milestones, engagement signals, recommended next steps. Invalidated by trigger when `lead_context_items` change. | ~287 KB | Deal health, AI recommendations |
| **lead_context_items** | Structured context extracted from imports and manual notes. Categorized by type (historical_fact, known_objection, etc). | ~786 KB | AI grounding context |
| **lead_context_cache** | Precomputed AI context bundles. Auto-invalidated by triggers on timeline and context item changes. | ~344 KB | Cached AI input (ephemeral) |
| **lead_signals** | Real-time intelligence signals (hiring, funding, product launches). | ~131 KB | External buying signals |
| **lead_ai_corrections** | User corrections to AI drafts for feedback loop. | ~33 KB | AI learning |
| **deal_memory** | Stateful deal continuity: objections, offers, CTA patterns, momentum. 1:1 with lead. | ~238 KB | Last-mile sales orchestration |

### Communication Ledger

| Table | Role | Size | Source of Truth For |
|-------|------|------|---------------------|
| **lead_timeline_items** | **Canonical cross-channel communication ledger.** Unified read-side view of all lead interactions (email, WhatsApp, voice, meetings, notes). Deduplicated by `(lead_id, dedupe_key)`. | ~2.9 MB | Lead activity history, inbox sourcing |
| **interactions** | **Legacy** communication log. Still written to by sync paths via `canonicalInteraction.ts` (dual-write). Being superseded by timeline. | ~4.9 MB | ⚠️ Legacy — larger than timeline due to historical data |
| **messages** | Encrypted message bodies for inbox conversations. Has retention policy (`expires_at` + `body_ciphertext` nullification). | ~197 KB | Message content (inbox channel) |
| **conversations** | Cross-channel conversation threads grouped by contact. | ~98 KB | Thread grouping for inbox |
| **conversation_analysis** | NLP analysis of conversation threads (sentiment, topics, urgency). | ~57 KB | Conversation-level AI insights |

### Contacts & Identity

| Table | Role | Size |
|-------|------|------|
| **contacts** | Unified contact registry. Links to `lead_id` for lead context in inbox. | ~90 KB |
| **contact_identities** | Phone numbers and emails per contact, unique per workspace. | ~90 KB |

### Campaigns & Automation

| Table | Role | Size | Source of Truth For |
|-------|------|------|---------------------|
| **campaigns** | Campaign definitions per workspace. Has `motion` enum and `is_default` flag. | ~25 KB | Campaign configuration |
| **campaign_steps** | Ordered steps within a campaign: channel, delay, framework, CTA type, hard rules. | ~33 KB | Sequence step definitions |
| **automation_log** | Execution lifecycle tracking for automated sends. Tracks claim/complete/error states. Owner-scoped. | **~8.8 MB** (largest table) | Automation execution history |
| **automation_logs** | Decision audit log (workspace-scoped). Records why automation was triggered/skipped. | ~66 KB | Automation decision audit |
| **drafts** | AI-generated draft queue. Linked to lead + step_key. | ~82 KB | Pending outreach content |
| **orchestration_log** | Last-mile orchestration decisions: objective alignment, CTA strategy, violations. | ~90 KB | AI orchestration audit |
| **message_generation_log** | Draft generation metadata (diversity tracking, angles used). | ~139 KB | Draft diversity control |

### Knowledge Base

| Table | Role | Size |
|-------|------|------|
| **kb_chunks** | Vectorized knowledge base content with `embedding vector(768)`. Owner-scoped. Used by `match_knowledge_chunks_v2`. | ~3 MB |

### Phone Calls

| Table | Role | Size |
|-------|------|------|
| **call_sessions** | WebRTC call lifecycle (Twilio). Links to workspace, lead, contact. | ~131 KB |
| **call_recordings** | Recording metadata + storage paths. 90-day retention. | ~82 KB |
| **call_transcripts** | Transcription output (raw, clean, LLM-formatted, segments). | ~82 KB |
| **call_analyses** | Structured AI analysis (signals, action items, next steps). 1:1 with session. | ~115 KB |
| **call_settings** | Per-workspace call configuration. | ~49 KB |
| **call_webhook_log** | Raw Twilio webhook payloads for debugging. | ~131 KB |

### Meetings

| Table | Role | Size |
|-------|------|------|
| **meeting_packs** | Structured meeting summaries with follow-up drafts. Triggers `meeting_summary_count` on leads. | ~262 KB |
| **meeting_summaries** | Zoom/external meeting transcripts and summaries. | ~401 KB |
| **unmatched_meeting_summaries** | Meeting summaries not yet linked to a lead. | ~344 KB |

### Mail & Integrations

| Table | Role | Size |
|-------|------|------|
| **gmail_connections** | Gmail OAuth tokens (encrypted). 1:1 with user. | ~98 KB |
| **integrations** | WhatsApp/Outlook integration records. Workspace-scoped. | ~49 KB |
| **mail_accounts** | Unified mail account registry (Gmail + Outlook). | ~156 KB |
| **mail_event_log** | Mail send/receive event tracking. | ~41 KB |
| **outlook_subscriptions** | Microsoft Graph webhook subscriptions. | ~49 KB |
| **oauth_states** | CSRF tokens for OAuth flows. | ~98 KB |

### Multi-Tenancy & Auth

| Table | Role | Size |
|-------|------|------|
| **workspaces** | Workspace definitions. | ~33 KB |
| **workspace_members** | User-workspace membership with role (`admin`, `manager`, `sales`). | ~74 KB |
| **workspace_invitations** | Pending workspace invites. | ~49 KB |
| **workspace_automation_settings** | Per-workspace cadence and automation config. | ~49 KB |
| **workspace_profiles** | Workspace branding, booking links, meeting URLs. | ~156 KB |
| **profiles** | User profiles. Created via trigger on `auth.users` insert. | ~90 KB |
| **rep_profiles** | Sales rep metadata (bio, persona, tone). | ~49 KB |
| **rep_signatures** | Email signatures per rep. | ~33 KB |

### Style Learning

| Table | Role | Size |
|-------|------|------|
| **style_examples** | Sent/liked/disliked messages for style learning. | ~25 KB |
| **user_style_profiles** | Synthesized writing style profiles. | ~25 KB |
| **user_style_directives** | User-defined style rules. | ~25 KB |
| **winning_interactions** | Interactions that led to positive outcomes (meeting booked, etc). | ~41 KB |

### Operational

| Table | Role | Size |
|-------|------|------|
| **cron_run_log** | Scheduled job execution history. | ~2 MB |
| **channel_events** | WhatsApp/provider webhook event queue (idempotent). | ~41 KB |
| **whatsapp_event_queue** | WhatsApp-specific event processing queue. | ~33 KB |
| **offer_registry** | Structured commercial offers (financing, pricing paths). | ~25 KB |
| **onboarding_config** | User onboarding state/configuration. | ~66 KB |
| **org_settings** | Legacy org-level settings (Zoom sync, internal domains). | ~49 KB |
| **manager_views** | Pre-computed manager dashboard metrics. | ~123 KB |
| **manager_conversation_metrics** | View (not table) — aggregated conversation metrics. | 0 |

---

## 2. Key Relationships

```
auth.users ──1:1──▶ profiles (via trigger on signup)
profiles ──1:N──▶ workspace_members ──N:1──▶ workspaces
workspaces ──1:N──▶ leads
workspaces ──1:N──▶ campaigns ──1:N──▶ campaign_steps
workspaces ──1:N──▶ contacts ──1:N──▶ contact_identities
contacts ──0:1──▶ leads (lead_id FK for inbox linkage)
leads ──1:N──▶ lead_timeline_items (canonical ledger)
leads ──1:N──▶ interactions (legacy)
leads ──1:1──▶ lead_intelligence
leads ──1:1──▶ deal_memory
leads ──1:N──▶ lead_context_items
leads ──1:N──▶ drafts
leads ──1:N──▶ automation_log
contacts ──1:N──▶ conversations ──1:N──▶ messages
call_sessions ──1:N──▶ call_recordings
call_sessions ──1:1──▶ call_transcripts
call_sessions ──1:1──▶ call_analyses
```

### Trigger Chains (Cache Invalidation)
```
lead_context_items INSERT/UPDATE/DELETE
  → invalidate_lead_intelligence_on_context()
    → DELETE lead_intelligence + lead_context_cache

lead_timeline_items INSERT
  → invalidate_lead_context_on_timeline()
    → DELETE lead_context_cache

meeting_packs INSERT/DELETE
  → update_lead_meeting_count()
    → UPDATE leads.meeting_summary_count + stage
```

---

## 3. Source of Truth by Product Area

| Area | Source of Truth | Notes |
|------|----------------|-------|
| Lead lifecycle | `leads` table | Stage, motion, action scheduling, counters |
| Communication history | `lead_timeline_items` | Canonical; `interactions` is legacy dual-write |
| AI insights | `lead_intelligence` | Computed; invalidated on context changes |
| Deal continuity | `deal_memory` | Objections, offers, momentum |
| Campaign config | `campaigns` + `campaign_steps` | Mirrored resolver in client + server |
| Automation execution | `automation_log` | Claim-based execution tracking |
| Automation decisions | `automation_logs` | Why automation ran/skipped |
| Inbox threads | `conversations` + `messages` | Grouped by contact |
| Contact identity | `contacts` + `contact_identities` | Unique per workspace |
| Knowledge base | `kb_chunks` | Vector-indexed, owner-scoped |
| Call pipeline | `call_sessions` → recordings → transcripts → analyses | Linear pipeline |
| Writing style | `style_examples` → `user_style_profiles` | Capture → synthesis |

---

## 4. Suspicious Overlaps & Duplications

### ⚠️ `automation_log` vs `automation_logs`
Two tables with confusingly similar names serving different purposes:
- `automation_log` (8.8 MB): Execution lifecycle — tracks claim/send/complete/error per lead. Owner-scoped RLS.
- `automation_logs` (66 KB): Decision audit — records why automation was triggered/skipped. Workspace-scoped RLS.
Both have `service_role` INSERT policies. The naming collision is a known documentation gap.

### ⚠️ `interactions` vs `lead_timeline_items`
Active dual-write via `canonicalInteraction.ts`. The `interactions` table (4.9 MB) is larger than `lead_timeline_items` (2.9 MB), indicating historical data predating the timeline. Timeline is the canonical read source; interactions is kept for backward compatibility in components not yet migrated.

### ⚠️ `meeting_packs` vs `meeting_summaries` vs `unmatched_meeting_summaries`
Three meeting-related tables:
- `meeting_packs`: Structured recaps with follow-up drafts (lead-linked)
- `meeting_summaries`: Raw Zoom/external transcripts (lead-linked)
- `unmatched_meeting_summaries`: Summaries not yet linked to a lead
Likely reflects iterative feature evolution rather than intentional design.

### ⚠️ `org_settings` vs `workspace_automation_settings` vs `workspace_profiles`
Legacy `org_settings` (per-user) coexists with workspace-scoped settings tables. The workspace tables are the current pattern.

### ⚠️ Three `match_knowledge_chunks` function signatures
- v1 (no owner filter) — legacy
- v1 with `p_owner_user_id` — added later
- `match_knowledge_chunks_v2` — current, with content type filtering
All three remain in the database.

### ⚠️ `gmail_connections` vs `mail_accounts` vs `integrations`
Three tables tracking external service connections:
- `gmail_connections`: Gmail-specific OAuth (encrypted tokens)
- `mail_accounts`: Unified mail account registry
- `integrations`: WhatsApp/Outlook integration records
The distinction between `gmail_connections` and `mail_accounts` suggests a pre-unification pattern.

---

## 5. Migration Patterns

**106 total migrations** spanning Jan 5 – Apr 16, 2026.

### Architectural Phases (from migration analysis)

| Phase | Period | Key Changes |
|-------|--------|-------------|
| **Foundation** | Jan 5-6 | `profiles`, `leads`, `kb_chunks`, `gmail_connections`, `interactions`, `drafts`. Gmail OAuth, vector embeddings, cron jobs. |
| **Lead Enrichment** | Jan 6-7 | Lead metadata columns, meeting packs, stage/action fields, `match_knowledge_chunks`. |
| **Multi-tenancy** | Jan 25 – Feb 11 | `workspaces`, `workspace_members`, workspace-scoped RLS migration. Contacts + conversations + messages tables. |
| **Mail Unification** | Feb 11-18 | `mail_accounts`, Outlook integration, encrypted token storage, unified sync engine. |
| **WhatsApp + Channels** | Feb 20-23 | `channel_events`, WhatsApp integration, provider-agnostic event processing. |
| **Campaign Engine** | Feb 26-27 | `campaigns`, `campaign_steps`, structured step types, framework/CTA config. |
| **Phone Calls** | Mar 2-10 | Full call pipeline: `call_sessions`, `call_recordings`, `call_transcripts`, `call_analyses`, `call_settings`. |
| **Unified Timeline** | Mar 24 | `lead_timeline_items` — canonical cross-channel ledger with dedupe. |
| **Last-Mile AI** | Mar 24-29 | `deal_memory`, `orchestration_log`, `lead_context_items`, `offer_registry`. |
| **SMS + Cache Invalidation** | Apr 12-13 | SMS columns on leads/workspaces, timeline→cache invalidation trigger. |
| **Style Learning** | Apr 16 | `style_examples`, `user_style_profiles`, `user_style_directives`, `winning_interactions`. |

### Notable Recent Migrations

| Date | Migration | Significance |
|------|-----------|-------------|
| Mar 24 | `5c08870b` | **Created `lead_timeline_items`** — the canonical communication ledger |
| Mar 24 | `228ca8c5` | Added `hidden` column + lead owner UPDATE policy on timeline |
| Mar 29 | `993b2dec` | **Created `deal_memory`** — stateful deal continuity tracking |
| Mar 29 | `cb36783c` | **Created `lead_context_items`** + `raw_import_json` on leads |
| Apr 5 | `953aa7fc` | Data fix: Recovered 30 stuck nurture leads |
| Apr 12 | `18a9cc20` | Added SMS opt-in to leads, SMS enabled to workspaces |
| Apr 13 | `c13da8b2` | Timeline→cache invalidation trigger |
| Apr 14 | `e360bfb9` | Added `re_engagement` motion to leads constraint |
| Apr 15 | `18b6164f` | Context→intelligence invalidation trigger |
| Apr 16 | `d90141f5` | **Created style learning tables** (style_examples, user_style_profiles, winning_interactions) |

### Migration Anti-Patterns Observed
- **Data fixes in migrations**: Several migrations (Apr 5, Apr 13) contain `UPDATE`/`DELETE` statements fixing stuck data — these should ideally be one-off scripts, not schema migrations.
- **Rapid-fire sequential migrations**: Some dates have 3-4 migrations within minutes (e.g., Mar 10 had 7 migrations), suggesting iterative debugging rather than planned changes.
- **Foreign key inconsistency**: Some tables reference `workspaces(id)` with FK constraints, others just store `workspace_id` without FK. The schema info shows "No foreign keys" for many workspace-scoped tables despite having workspace_id columns.
