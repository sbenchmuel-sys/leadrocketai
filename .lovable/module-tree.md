# Module Tree

```
.
├── index.html
├── vite.config.ts / tailwind.config.ts / tsconfig*.json
├── .env                              # Auto-managed by Lovable Cloud — DO NOT EDIT
├── .lovable/
│   ├── plan.md                       # Product plan
│   ├── architecture-map.md           # System architecture reference
│   └── module-tree.md                # ← this file
│
├── src/
│   ├── main.tsx                      # App entry point
│   ├── App.tsx                       # Router, providers, layout
│   ├── index.css                     # Design tokens, Tailwind base
│   │
│   ├── pages/                        # Route-level views
│   │   ├── Dashboard.tsx             # Pipeline overview, priority actions        ⟵ LEADS
│   │   ├── Leads.tsx                 # Lead list, import, bulk actions            ⟵ LEADS
│   │   ├── LeadDetail.tsx            # Single-lead SoR: timeline, drafts, recs    ⟵ LEADS / TIMELINE / DRAFTS / AI
│   │   ├── Inbox.tsx                 # Unified cross-channel inbox                ⟵ TIMELINE
│   │   ├── Knowledge.tsx             # KB management                              ⟵ KB/RETRIEVAL
│   │   ├── Settings.tsx              # Workspace config, integrations             ⟵ PERMISSIONS
│   │   ├── CallDetail.tsx            # Single call: transcript, analysis
│   │   ├── ManagerAnalytics.tsx      # Team-level analytics
│   │   ├── Onboarding.tsx            # Setup wizard
│   │   ├── Auth.tsx / ResetPassword.tsx  # Auth flows                             ⟵ PERMISSIONS
│   │   ├── Landing.tsx               # Public landing page
│   │   └── DevSmokeTests.tsx         # Internal test page (flag-gated)
│   │
│   ├── components/
│   │   ├── dashboard/                # SummaryCards, LeadTable, PriorityActions,   ⟵ LEADS / AI
│   │   │                               StageFilterBar, TopMovers, AIInsightPanel
│   │   ├── lead/                     # LeadDetailHeader, TimelineTab, DraftsTab,   ⟵ TIMELINE / DRAFTS / AI
│   │   │                               RecommendationsTab, UploadTab,
│   │   │                               AutomationPreviewCard, CampaignStepPreview  ⟵ CAMPAIGNS / AUTOMATIONS
│   │   ├── leads/                    # LeadCard, LeadImportDialog                  ⟵ LEADS
│   │   ├── inbox/                    # ConversationList, ConversationThread,        ⟵ TIMELINE / DRAFTS
│   │   │                               ReplyComposer, IntelligencePanel,
│   │   │                               UnifiedInsightsPanel, EvidenceDrawer         ⟵ AI
│   │   ├── call/                     # ActiveCallBar, BrowserCallProvider,
│   │   │                               ClickToCallButton, CallTimelineCard
│   │   ├── gmail/                    # GmailConnectionCard, GmailSyncButton,        ⟵ SEND FLOWS
│   │   │                               SendEmailButton
│   │   ├── settings/                 # CadenceSettingsCard, CallSettingsCard,        ⟵ CAMPAIGNS / PERMISSIONS
│   │   │                               RepProfileCard, WorkspaceMembersCard,
│   │   │                               WhatsAppConnectionCard, OutlookConnectionCard
│   │   ├── onboarding/              # WelcomeStep, ConnectInboxStep, AddKnowledgeStep
│   │   ├── admin/                   # LastMileReasoningPanel                        ⟵ AI (debug)
│   │   ├── auth/                    # AccountMergeDialog                            ⟵ PERMISSIONS
│   │   ├── manager/                 # ManagerDashboard
│   │   ├── ui/                      # shadcn/ui primitives (button, dialog, table…)
│   │   ├── DashboardLayout.tsx      # Shell: sidebar, nav, workspace switcher
│   │   ├── ProtectedRoute.tsx       # Auth gate                                    ⟵ PERMISSIONS
│   │   └── ErrorBoundary.tsx
│   │
│   ├── contexts/
│   │   ├── AuthContext.tsx           # Session, user, profile                       ⟵ PERMISSIONS
│   │   └── WorkspaceContext.tsx      # Active workspace, multi-tenant isolation     ⟵ PERMISSIONS
│   │
│   ├── hooks/
│   │   ├── useAITask.ts             # Client wrapper for ai_task edge fn            ⟵ AI
│   │   ├── useMailSync.ts           # Unified Gmail/Outlook sync                    ⟵ SEND FLOWS
│   │   ├── useGmailConnection.ts    # Gmail OAuth state
│   │   ├── useGmailSync.ts          # Gmail-specific sync
│   │   ├── useGmailAutoSync.ts      # Auto-trigger sync on mount
│   │   ├── useAutomationPoller.ts   # Polls automation status                      ⟵ AUTOMATIONS
│   │   └── useProfileSync.ts        # Profile data sync
│   │
│   ├── lib/                          # Business logic & data access
│   │   ├── campaignResolver.ts       # Resolve campaign step → instruction          ⟵ CAMPAIGNS
│   │   ├── campaignQueries.ts        # Campaign CRUD queries                        ⟵ CAMPAIGNS
│   │   ├── campaignTypes.ts          # Campaign type definitions                    ⟵ CAMPAIGNS
│   │   ├── contextResolver.ts        # Assemble lead context for AI                 ⟵ AI / KB
│   │   ├── generateDraft.ts          # Draft generation orchestration               ⟵ DRAFTS
│   │   ├── actionRouter.ts           # Map action keys → UI handlers                ⟵ AUTOMATIONS
│   │   ├── motionUpdater.ts          # Lead motion/stage transitions                ⟵ LEADS
│   │   ├── sequenceUpdater.ts        # Advance sequence position                    ⟵ AUTOMATIONS
│   │   ├── playbookResolver.ts       # Select playbook for lead                     ⟵ AI
│   │   ├── closingPowerUtils.ts      # Deal health score calculation                ⟵ AI
│   │   ├── complexityScorer.ts       # Lead complexity scoring                      ⟵ AI
│   │   ├── styleCapture.ts           # Writing style example capture                ⟵ AI
│   │   ├── parseLeadFile.ts          # CSV/file import parsing                      ⟵ LEADS
│   │   ├── supabaseQueries.ts        # Core lead CRUD                               ⟵ LEADS
│   │   ├── inboxQueries.ts           # Inbox data queries                           ⟵ TIMELINE
│   │   ├── callQueries.ts            # Call session queries
│   │   ├── dashboardMetricsService.ts # Dashboard aggregations
│   │   ├── featureFlags.ts           # Runtime feature flags
│   │   ├── demoData.ts / demoMode.ts # Demo mode support
│   │   ├── ai/
│   │   │   └── emailQualityScore.ts  # Draft quality scoring                        ⟵ AI
│   │   ├── mailProviders/            # Gmail/Outlook provider abstraction            ⟵ SEND FLOWS
│   │   │   ├── GmailProvider.ts
│   │   │   ├── OutlookProvider.ts
│   │   │   ├── MailProviderRouter.ts
│   │   │   └── types.ts
│   │   └── playbooks/
│   │       └── registry.ts           # Playbook definitions (code, not DB)           ⟵ AI
│   │
│   ├── prompts/                      # LLM prompt templates
│   │   ├── intentRouter.ts           # Intent classification prompts                ⟵ AI
│   │   ├── analyticsPrompts.ts       # Analytics generation prompts                 ⟵ AI
│   │   └── linkedinPrompts.ts        # LinkedIn message prompts                     ⟵ AI
│   │
│   ├── schemas/
│   │   └── llmOutputSchemas.ts       # Zod schemas for LLM structured output        ⟵ AI
│   │
│   ├── data/
│   │   └── emailTemplates.ts         # Static email template library                ⟵ DRAFTS
│   │
│   └── integrations/
│       ├── supabase/
│       │   ├── client.ts             # Supabase client — AUTO-GENERATED, DO NOT EDIT
│       │   └── types.ts              # DB types — AUTO-GENERATED, DO NOT EDIT
│       └── lovable/
│           └── index.ts              # Lovable AI Gateway client                    ⟵ AI
│
├── supabase/
│   ├── config.toml                   # Supabase project config — DO NOT EDIT project-level settings
│   │
│   ├── migrations/                   # SQL migration files — READ-ONLY              ⟵ DATABASE/MIGRATIONS
│   │                                   (all schema, RLS policies, triggers, functions)
│   │
│   └── functions/                    # Edge Functions (Deno runtime)
│       ├── _shared/                  # Shared backend logic
│       │   ├── authz.ts              # Workspace-scoped authorization               ⟵ PERMISSIONS
│       │   ├── scheduledAuth.ts      # Cron/internal auth gate                      ⟵ PERMISSIONS
│       │   ├── encryption.ts         # OAuth token encryption                       ⟵ PERMISSIONS
│       │   ├── campaignResolver.ts   # Server-side campaign resolution              ⟵ CAMPAIGNS
│       │   ├── campaignTypes.ts      # Shared campaign type defs                    ⟵ CAMPAIGNS
│       │   ├── campaignStepLoader.ts # Load steps from DB                           ⟵ CAMPAIGNS
│       │   ├── executionSettings.ts  # Automation timing/cadence rules              ⟵ AUTOMATIONS
│       │   ├── dealMemory.ts         # Deal continuity state                        ⟵ AI
│       │   ├── intentClassifier.ts   # Inbound intent classification                ⟵ AI
│       │   ├── replyEvaluator.ts     # Reply quality evaluation                     ⟵ AI
│       │   ├── replyObjective.ts     # Reply objective selection                    ⟵ AI
│       │   ├── continuityScoring.ts  # Conversation continuity scoring              ⟵ AI
│       │   ├── stagePolicy.ts        # Stage-aware CTA policy                       ⟵ CAMPAIGNS / AI
│       │   ├── frameworks.ts         # Email framework definitions                  ⟵ AI
│       │   ├── prompts.ts            # Core LLM prompts                             ⟵ AI
│       │   ├── timelineProjector.ts  # Timeline state projection                    ⟵ TIMELINE
│       │   ├── canonicalInteraction.ts # Normalize interactions                     ⟵ TIMELINE
│       │   ├── signalIngestion.ts    # Signal capture pipeline                      ⟵ AI
│       │   ├── winningInteractions.ts # Style learning from wins                    ⟵ AI
│       │   ├── syncEngine.ts         # Shared mail sync logic                       ⟵ SEND FLOWS
│       │   ├── oooDetection.ts       # Out-of-office detection                      ⟵ AUTOMATIONS
│       │   ├── unsubscribeDetection.ts # Opt-out detection                          ⟵ AUTOMATIONS
│       │   ├── meetingConfirmation.ts # Meeting confirmation detection              ⟵ AUTOMATIONS
│       │   ├── phoneMapping.ts       # Phone number → lead resolution
│       │   ├── outlookGraphClient.ts # Microsoft Graph API client                   ⟵ SEND FLOWS
│       │   ├── outlookTokens.ts      # Outlook token management                    ⟵ SEND FLOWS
│       │   ├── outlookSubscription.ts # Outlook webhook subscription               ⟵ SEND FLOWS
│       │   ├── twilioSignature.ts    # Twilio webhook auth                          ⟵ SEND FLOWS
│       │   ├── asrProvider.ts        # Speech-to-text provider
│       │   ├── callConfig.ts         # Call settings loader
│       │   ├── logger.ts             # Structured logging
│       │   └── whatsapp/             # WhatsApp provider abstraction                ⟵ SEND FLOWS
│       │       ├── provider.ts / service.ts / routing.ts
│       │       ├── providers/meta.ts / providers/twilio.ts
│       │       ├── normalize.ts / normalizeTwilio.ts
│       │       └── types.ts
│       │
│       ├── ai_task/                  # ★ Central AI gateway                         ⟵ AI / DRAFTS
│       ├── automation-check/         # Evaluate eligible leads                      ⟵ AUTOMATIONS
│       ├── automation-executor/      # Execute scheduled sends                      ⟵ AUTOMATIONS / SEND FLOWS
│       ├── cron-dispatcher/          # Job scheduler relay                          ⟵ AUTOMATIONS
│       │
│       ├── gmail-auth/ gmail-callback/ gmail-sync/ gmail-bulk-sync/ gmail-send/     ⟵ SEND FLOWS
│       ├── outlook-auth/ outlook-callback/ outlook-sync/ outlook-send/              ⟵ SEND FLOWS
│       │   outlook-webhook/ outlook-subscription-check/ outlook-health/
│       ├── sms-send/ sms-webhook/                                                   ⟵ SEND FLOWS
│       ├── whatsapp-connect/ whatsapp-connect-twilio/ whatsapp-send/                ⟵ SEND FLOWS
│       │   whatsapp-webhook/ whatsapp-webhook-twilio/
│       │   whatsapp-events-processor/ whatsapp-health/
│       │
│       ├── call-api/ call-transcribe/ call-analyze/ call-ingest-recording/
│       ├── twilio-voice-inbound/ twilio-voice-outbound/
│       │   twilio-voice-token/ twilio-voice-webhook/
│       │
│       ├── build-lead-context/       # Precompute AI context                        ⟵ AI / KB
│       ├── recompute-lead-intelligence/ # Aggregate lead signals                    ⟵ AI
│       ├── conversation-analyze/     # Thread NLP analysis                          ⟵ AI
│       ├── generate-reply-suggestions/ # Reply suggestion generation                ⟵ AI
│       ├── generate-personalized-suggestions/ # Personalized suggestions            ⟵ AI
│       ├── nurture-pre-generate/     # Pre-generate nurture drafts                  ⟵ DRAFTS / AUTOMATIONS
│       ├── promote-winning-interactions/ # Style learning promotion                 ⟵ AI
│       ├── synthesize-style-profile/ # Build writing style profile                  ⟵ AI
│       │
│       ├── parse-document/           # Document parsing                             ⟵ KB/RETRIEVAL
│       ├── process-knowledge-document/ # KB document processing                     ⟵ KB/RETRIEVAL
│       ├── generate-embedding/       # Vector embedding generation                  ⟵ KB/RETRIEVAL
│       ├── extract-profile-from-kb/  # Profile extraction from KB                   ⟵ KB/RETRIEVAL
│       │
│       ├── enrich-company-search/    # Company enrichment                           ⟵ LEADS
│       ├── ingest-crm-signals/       # CRM signal ingestion                         ⟵ LEADS
│       ├── ingest-website-signals/   # Website signal ingestion                     ⟵ LEADS
│       │
│       ├── compute-manager-analytics/ # Team analytics
│       ├── decrypt-messages/         # Message decryption                           ⟵ PERMISSIONS
│       ├── message-cleanup/          # Retention policy enforcement                 ⟵ PERMISSIONS
│       ├── accept-workspace-invite/  # Workspace membership                        ⟵ PERMISSIONS
│       ├── process-zoom-summary/     # Zoom meeting summary ingestion
│       └── reset-demo/              # Demo data reset
│
└── public/
    ├── placeholder.svg
    └── robots.txt
```

## Subsystem Location Index

| Subsystem | Primary locations |
|-----------|-------------------|
| **Leads** | `pages/Dashboard`, `pages/Leads`, `pages/LeadDetail`, `components/lead/`, `components/leads/`, `lib/supabaseQueries`, `lib/parseLeadFile`, `lib/motionUpdater` |
| **Timeline / Activity** | `components/lead/TimelineTab`, `components/inbox/`, `lib/inboxQueries`, `_shared/timelineProjector`, `_shared/canonicalInteraction` · DB: `lead_timeline_items` |
| **Campaigns** | `lib/campaignResolver` ↔ `_shared/campaignResolver`, `lib/campaignQueries`, `lib/campaignTypes` ↔ `_shared/campaignTypes`, `_shared/campaignStepLoader`, `components/lead/CampaignStepPreview`, `components/settings/CadenceSettingsCard` · DB: `campaigns`, `campaign_steps` |
| **Automations** | `functions/automation-check`, `functions/automation-executor`, `functions/cron-dispatcher`, `_shared/executionSettings`, `_shared/oooDetection`, `_shared/unsubscribeDetection`, `hooks/useAutomationPoller`, `lib/actionRouter`, `lib/sequenceUpdater` · DB: `automation_log` |
| **AI / Recommendations** | `functions/ai_task` (★ gateway), `functions/recompute-lead-intelligence`, `functions/generate-reply-suggestions`, `_shared/intentClassifier`, `_shared/replyEvaluator`, `_shared/dealMemory`, `_shared/frameworks`, `_shared/prompts`, `hooks/useAITask`, `lib/contextResolver`, `lib/playbookResolver`, `lib/closingPowerUtils`, `prompts/`, `schemas/` · DB: `lead_intelligence`, `deal_memory` |
| **Drafts / Send Flows** | `functions/ai_task` (generation), `functions/gmail-send`, `functions/outlook-send`, `functions/sms-send`, `functions/whatsapp-send`, `functions/automation-executor` (auto-send), `lib/generateDraft`, `lib/mailProviders/`, `components/lead/DraftsTab`, `components/inbox/ReplyComposer` · DB: `drafts` |
| **KB / Retrieval** | `functions/parse-document`, `functions/process-knowledge-document`, `functions/generate-embedding`, `functions/extract-profile-from-kb`, `functions/build-lead-context`, `pages/Knowledge` · DB: `kb_chunks`, `lead_context_cache` |
| **Database / Migrations** | `supabase/migrations/` (read-only SQL files), `src/integrations/supabase/types.ts` (auto-generated) |
| **Permissions / Access** | `contexts/AuthContext`, `contexts/WorkspaceContext`, `components/ProtectedRoute`, `_shared/authz`, `_shared/scheduledAuth`, `_shared/encryption`, `functions/accept-workspace-invite`, `functions/decrypt-messages` · Enforced via RLS on all tables |
