# DrivePilot (LeadRocket AI)

Multi-tenant B2B sales automation platform that combines AI-generated outreach, multi-channel communication, and deal intelligence into a single workspace.

## What It Does

- **AI-Powered Outreach**: Generates personalized email, SMS, WhatsApp, and LinkedIn drafts using lead context, knowledge base, and learned writing style
- **Multi-Step Campaigns**: Configurable campaign sequences with per-step objectives, frameworks, CTAs, and delay scheduling
- **Unified Inbox**: Cross-channel conversation view (Email, WhatsApp, SMS) grouped by lead with AI reply suggestions
- **Deal Intelligence**: Automated lead scoring ("Closing Power"), milestone tracking, buying signal detection, and objection analysis
- **Automation Engine**: Scheduled outbound execution with cadence controls, deduplication guards, and opt-out/OOO detection
- **Phone Calls**: Browser-based WebRTC calling via Twilio with recording, transcription (Google Speech-to-Text), and AI analysis
- **Knowledge Base**: Document ingestion with vector embeddings for grounding AI drafts in product/company facts
- **Style Learning**: Passive capture of sent messages to synthesize per-workspace writing style profiles

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript 5, Vite 5, Tailwind CSS 3, shadcn/ui |
| State | TanStack React Query, React Context (Auth, Workspace) |
| Backend | Supabase (Postgres + RLS), Edge Functions (Deno) |
| AI | Lovable AI Gateway (Gemini, GPT models) via `ai_task` edge function |
| Integrations | Gmail API, Microsoft Graph (Outlook), Twilio (Voice/SMS/WhatsApp), Meta WhatsApp Cloud API |
| Auth | Supabase Auth (email/password, Google OAuth) |

## Key Modules

### Frontend (`src/`)

| Path | Purpose |
|------|---------|
| `pages/Dashboard.tsx` | Pipeline overview with priority actions, lead table, AI insights |
| `pages/Inbox.tsx` | Unified cross-channel conversation inbox |
| `pages/LeadDetail.tsx` | Single-lead system of record: timeline, drafts, recommendations, uploads |
| `pages/Leads.tsx` | Lead list with import, filtering, bulk actions |
| `pages/Settings.tsx` | Workspace config: mail connections, cadence, signatures, call settings |
| `pages/Knowledge.tsx` | Knowledge base management |
| `pages/Onboarding.tsx` | Multi-step setup wizard |
| `contexts/AuthContext.tsx` | Auth state, session management, profile loading |
| `contexts/WorkspaceContext.tsx` | Active workspace resolution, multi-tenant isolation |
| `hooks/useAITask.ts` | Client-side wrapper for `ai_task` edge function calls |
| `hooks/useMailSync.ts` | Unified Gmail/Outlook sync orchestration |
| `lib/campaignResolver.ts` | Client-side campaign step resolution (mirrored server-side) |
| `lib/contextResolver.ts` | Assembles lead context for AI generation |
| `lib/styleCapture.ts` | Passive writing style example capture |
| `lib/actionRouter.ts` | Maps action keys to UI handlers |
| `lib/dashboardMetricsService.ts` | Dashboard metric aggregation |

### Edge Functions (`supabase/functions/`)

| Function | Role |
|----------|------|
| `ai_task` | **Central AI gateway** — all draft generation, analysis, classification |
| `automation-check` | Evaluates which leads are eligible for next automation step |
| `automation-executor` | Executes scheduled sends with dedup and safety guards |
| `cron-dispatcher` | Dispatches scheduled jobs (automation, sync, cleanup) |
| `gmail-sync` / `outlook-sync` | Inbound mail synchronization |
| `gmail-send` / `outlook-send` / `sms-send` / `whatsapp-send` | Channel-specific send handlers |
| `recompute-lead-intelligence` | Aggregates cross-channel signals into lead intelligence |
| `build-lead-context` | Precomputes structured context for AI consumption |
| `conversation-analyze` | NLP analysis of conversation threads |
| `call-transcribe` / `call-analyze` | Call recording transcription and AI analysis |
| `generate-embedding` | Vector embedding generation for KB chunks |
| `synthesize-style-profile` | Builds writing style profile from captured examples |
| `enrich-company-search` | Company data enrichment pipeline |
| `nurture-pre-generate` | Pre-generates nurture drafts 24-48h ahead |

### Shared Backend Logic (`supabase/functions/_shared/`)

| File | Purpose |
|------|---------|
| `campaignResolver.ts` | Server-side campaign step resolution |
| `dealMemory.ts` | Stateful deal continuity tracking |
| `intentClassifier.ts` | Inbound message intent classification |
| `replyEvaluator.ts` | Reply quality scoring and regeneration decisions |
| `stagePolicy.ts` | Stage-aware CTA and offer policy enforcement |
| `syncEngine.ts` | Shared mail sync logic (Gmail/Outlook) |
| `encryption.ts` | Token encryption/decryption for OAuth credentials |
| `scheduledAuth.ts` | Auth gate for cron-triggered functions |
| `authz.ts` | Workspace-scoped authorization helpers |

## Database (Key Tables)

| Table | Role |
|-------|------|
| `leads` | Primary revenue object (lead + opportunity merged) |
| `lead_timeline_items` | **Canonical cross-channel communication ledger** |
| `interactions` | Legacy communication log (being replaced by timeline items) |
| `lead_intelligence` | Computed lead insights, signals, scores |
| `lead_context_items` | Structured context extracted from imports and enrichment |
| `lead_context_cache` | Precomputed AI context bundles |
| `deal_memory` | Stateful deal continuity (objections, offers, CTAs) |
| `campaigns` / `campaign_steps` | Campaign definitions and step configurations |
| `drafts` | AI-generated draft queue |
| `automation_log` | Automation execution lifecycle tracking |
| `kb_chunks` | Vectorized knowledge base content |
| `contacts` / `contact_identities` | Unified contact registry for inbox |
| `conversations` / `messages` | Cross-channel conversation threads |
| `mail_accounts` | Connected mail provider accounts |
| `gmail_connections` | Gmail OAuth connection state |
| `integrations` | WhatsApp/Outlook integration records |
| `call_sessions` / `call_recordings` / `call_transcripts` / `call_analyses` | Phone call pipeline |
| `workspaces` / `workspace_members` | Multi-tenant workspace management |
| `profiles` | User profile data |
| `lead_signals` | Real-time intelligence signals |
| `entity_enrichment` | Cached company enrichment results |
| `style_examples` / `style_profiles` | Writing style learning data |

## Running Locally

```bash
npm install
npm run dev        # starts Vite dev server on :8080
npm run build      # production build
```

## Environment Variables

Set automatically by Lovable Cloud — do not edit `.env` manually:

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Backend API endpoint |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Anon/public API key |
| `VITE_SUPABASE_PROJECT_ID` | Project identifier |

### Feature Flags (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_DEMO_MODE` | `false` | Load curated demo data instead of live DB |
| `VITE_DEV_SMOKE` | `0` | Enable `/app/dev-smoke` test page |
| `VITE_ADMIN_TUNING` | `0` | Show last-mile reasoning debug panel |
| `VITE_EVIDENCE_DEBUG` | `0` | Show evidence debug UI |

### Edge Function Secrets (configured in Lovable Cloud)

Required for full functionality:
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Gmail OAuth
- `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` — Outlook OAuth
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` — SMS, Voice, WhatsApp (Twilio)
- `META_WHATSAPP_TOKEN` — WhatsApp Cloud API (Meta direct)
- `GOOGLE_SPEECH_API_KEY` — Call transcription
- `ENCRYPTION_KEY` — Token encryption at rest

## Known Documentation Gaps

1. **No API reference** — Edge function contracts (request/response shapes) are undocumented outside of code
2. **No migration changelog** — Database evolution is tracked only via migration files
3. **Duplicated tables** — `automation_log` (execution) and `automation_logs` (decisions) coexist with different schemas; naming is confusing
4. **Legacy `interactions` table** — Still referenced in several components but being superseded by `lead_timeline_items`
5. **Client/server mirroring** — `campaignResolver.ts` exists in both `src/lib/` and `_shared/`; no automated sync mechanism
6. **Three `match_knowledge_chunks` function signatures** — v2 is current; v1 and unnumbered remain
7. **No test suite** — No unit or integration tests in the repo
8. **Playbook definitions** — Stored in code (`playbooks/registry.ts`) rather than database; not user-editable
9. **Style learning** — Capture is implemented but profile synthesis trigger cadence is undocumented