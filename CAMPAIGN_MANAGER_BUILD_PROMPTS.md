# Outreach — Build Prompts (paste-ready for Claude Code)

This is the full build plan for the cold "Outreach" feature, broken into 6 independently
shippable units. Each block below is a complete prompt — paste **one at a time** into Claude
Code in the DrivePilot project.

**Naming:** the feature is called **"Outreach"** in everything a rep sees (the "New Outreach"
button, page titles, the Queue tab). The UNDERLYING code keeps its existing names — the
`campaigns` / `campaign_steps` tables, `campaignResolver.ts`, `campaignQueries.ts`,
`CampaignSettingsPanel.tsx`, etc. — so we still reuse it cleanly. Do NOT rename the code/tables;
this is a product-copy name only. (One word, two places: you build an "Outreach," and its
touches appear in the "Outreach" tab of the Queue.)

---

## How to use this (you don't need to write any code)

1. Open Claude Code inside the DrivePilot project.
2. Copy **Unit A** below and paste it. Claude Code will reply with a *plan* in plain
   language — it will NOT start coding yet. Read the plan, then reply **"looks good, go
   ahead"** (or ask questions / request changes first).
3. Let it build. If it made a database change (it'll mention a "migration" file), go to
   Lovable's chat and say: **"Apply migration `<the filename it gives you>`."**
4. Before you treat it as done, come back here and say **"QA the Outreach changes"** — that
   runs it through the safety review (`drivepilot-qa`) before anything reaches a real
   customer.
5. Move to the next unit and repeat.

**Build order:** A → B → D → 0 → C, with **Unit E** (Queue tabs) alongside C.
Units A, B, and D are safe to build in any order after A. **Unit C is last and the
riskiest** (it's the part that sends real email). **Unit 0** (the safety floor) can be built
any time, but it MUST be live before Unit C's automatic email sending is switched on.
**Unit E** (the Queue tab change) can be built any time — its "Outreach" tab just shows an
empty state until Unit C lands.

Don't paste everything at once — this project ships one piece at a time.

---

## Reuse map — use these, don't rebuild (no duplicate code)

The prompts below already point at these, but here's the single list so nothing gets
recreated. Each unit's prompt tells Claude Code to investigate and reuse the canonical thing.

| Need | Reuse this (canonical) | Do NOT create |
|---|---|---|
| **Campaign data model** | EXISTS — reuse the `campaigns` table (incl. `global_instructions`, `motion`, `default_channel`, `include_meeting_cta`, `is_default`) and `campaign_steps` (`step_number`, `channel`, `delay_days`, `step_type`, `framework`, `objective`, `cta_type`, `max_word_count`, `hard_rules`, `generation_hints`, `custom_instructions`, `active`, `variant_group`) + `leads.campaign_id`. | A brand-new campaign / steps table |
| **Campaign + step instructions** | `campaigns.global_instructions` (campaign-level) + `campaign_steps.custom_instructions` (per-step). Edited today via `CampaignSettingsPanel.tsx`; previewed via `CampaignStepPreview.tsx`. | A new instructions store |
| **Instruction → prompt resolver** | `_shared/campaignResolver.ts` (`resolveCampaignInstruction`, `formatInstructionForPrompt`) + `_shared/campaignStepLoader.ts` + `DEFAULT_STEP_CONFIG`. **NOTE: built but NOT yet wired into `ai_task` — wiring it in is a REQUIRED task (Unit B).** | A second resolver |
| **Campaign queries** | `src/lib/campaignQueries.ts` (fetch / list / assign). Create + update mutations are MISSING — add them, don't duplicate the fetch side. | — |
| Per-user voice / tone | `user_style_directives`, `style_examples`, `synthesize-style-profile`, `outbound_tone` (already per-user) | A new per-user preferences store |
| Send email | provider path + `automation-executor` → `gmail-send` / `outlook-send` | A 4th send path (it's already duplicated 3×) |
| Send SMS | `sms-send` | — |
| Send WhatsApp | `whatsapp-send` + `_shared/whatsapp/service.ts` | — |
| Place a call | `twilio-voice-outbound` (+ `twilio-voice-webhook`) | — |
| AI drafting | `ai_task` + prompts in `_shared/prompts.ts` | Any new/external AI caller |
| KB upload + search | `process-knowledge-document` + RPC `match_knowledge_chunks_v2` | `match_knowledge_chunks_v1` / unnumbered (deprecated) |
| Cadence timing | `src/lib/cadenceSettingsTypes.ts` (`getNurtureCadenceDays`, `calculateEligibleAt`) + `eligible_at` | A separate scheduler |
| Queue cards | `src/components/queue/QueueCard.tsx` | A new card component |
| Snooze / dismiss | `timeline_followup_state` + `set_timeline_followup_state` | Merging it with lead-level dismiss |
| Consent / opt-out | `automation_mode` (consent gate) + `unsubscribed` + `_shared/oooDetection.ts` | A second consent column |
| **Send guardrails** (caps, bounce-stop, reply-stop, min-gap, send window) | **`_shared/executionSettings.ts`** — `loadExecutionSettings`, `checkSendWindow`, `checkStopConditions`, `checkMinGap`, `checkPerLeadCaps` — plus `_shared/bounceDetection.ts` (`detectBounce`) and `_shared/unsubscribeDetection.ts` (`isHumanUnsubscribeRequest`). All already shipped and wired into automation-executor. | ANY campaign-specific caps, bounce list, reply-stop, or new send limits |
| Lead industry (for Industry campaigns) | the existing industry field on a lead | A new industry field |
| Spam / quality check | the `quality_scorer` prompt via `ai_task` | A new AI caller |
| Lead import + dedupe | `LeadImportDialog.tsx` + `parseLeadFile.ts` (CSV/XLSX, field mapping, workspace-unique email) — add email validation here | A new importer |
| Recipient-timezone sending | the existing `timezone_mode: "lead"` scaffolding in `cadenceSettingsTypes.ts` (defined, not implemented) + lead location fields (city/state/country) | A new timezone system |
| Per-lead bounce stop (to build the circuit breaker on) | `_shared/bounceDetection.ts` (`detectBounce`) | A second bounce detector |
| Selecting many leads | inline multi-select like `BulkAutomationDialog.tsx` / `BulkMoveToNurtureDialog.tsx` (a shared hook is planned for Phase 2b) | A 5th copy of select-all logic if the Phase 2b hook has landed — check first |

---

## UNIT A — Campaign foundation (data + thin page + setup flow shell)

```
We're adding a "Campaigns" feature to DrivePilot: a multi-touch, multi-channel outbound
sequence (cold, V1). This is an ADDITIVE feature — it must NOT change behavior for any lead
that is not enrolled in a campaign.

First: read CLAUDE.md, then PROGRESS.md and README.md. A structured campaign system ALREADY
EXISTS — you MUST reuse it, not build a parallel one. Investigate and confirm the current
state of: the `campaigns` table (incl. `global_instructions`, `motion`, `default_channel`,
`include_meeting_cta`, `is_default`), the `campaign_steps` table (`step_number`, `channel`,
`delay_days`, `step_type`, `framework`, `objective`, `cta_type`, `max_word_count`,
`hard_rules`, `generation_hints`, `custom_instructions`, `active`, `variant_group`),
`leads.campaign_id`, the legacy `leads.action_instructions` text blob, the resolvers
(`_shared/campaignResolver.ts`, `_shared/campaignStepLoader.ts`, `DEFAULT_STEP_CONFIG`), the
UI (`CampaignSettingsPanel.tsx`, `CampaignStepPreview.tsx`), and queries
(`src/lib/campaignQueries.ts`). Also reuse the cadence timing helpers in
src/lib/cadenceSettingsTypes.ts (getNurtureCadenceDays, calculateEligibleAt).
This unit's NEW work is what's MISSING on top of that: create/update mutations for campaigns
(currently only fetch/assign exist), the thin Automations list + campaign page, the foolproof
3-step setup flow, the General/Industry choice, and a default editable instruction prompt
(below). Be careful with the legacy `action_instructions` text blob vs the structured model —
the resolver bridges both today; do not break the legacy path. In your plan, explicitly tell
me what already exists and what is genuinely new. Propose a plan — do NOT write code until I
approve it.

Goal: persist a campaign definition and give it a home, for both small-book and big-book reps.

Data model: REUSE the existing `campaigns` + `campaign_steps` tables. A touch = a
`campaign_steps` row (channel + `delay_days` + its instructions). Default to a 9-touch
sequence. A campaign is a LIVING object — saved as a draft, leads added now OR later (late
joiners start at step 1; reuse `leads.campaign_id` + `assignCampaignToLead`). Add the missing
campaign type (General vs Industry) and the campaign create/update mutations.
- CUSTOM INSTRUCTIONS (reuse, don't rebuild): campaign-level instructions live in
  `campaigns.global_instructions`; per-step instructions in `campaign_steps.custom_instructions`.
  Pre-fill `global_instructions` with the default editable prompt below so it works out of the
  box, and pre-fill sensible per-step instructions. The rep can edit either (reuse the
  `CampaignSettingsPanel` editing pattern).
- SUPPRESSION LIST (new): a workspace-level do-not-contact list of emails + domains, checked
  before enrolling or sending. Keep it minimal — a plain editable list, not a console. Separate
  from the per-lead `unsubscribed` flag (which stays as-is).
- END STATE: when a lead finishes all touches with no reply, mark it done ("completed — no
  response") rather than leaving it in limbo. Optionally wire the existing (currently unused)
  auto_switch_after_breakup setting to drop it into long-term nurture.
- GENERAL vs INDUSTRY templating: a General campaign uses ONE set of step content for everyone
  (with name/company personalization). An Industry campaign needs per-industry step content
  — in your plan, propose how this maps onto the existing model (e.g. reuse the
  `campaign_steps.variant_group` column for industry variants, or one campaign per industry)
  rather than inventing a new structure. Reuse the existing lead industry field; blank industry
  falls back to the General content.

Where it lives: keep the Automations page THIN — just a list of outreaches + a single
"New Outreach" button. Each campaign opens its own page: the script up top, a "People"
section below with an "Add leads" button (add anytime). The Automations page itself must
never become a configuration/rules panel.

Setup must be MAXIMALLY foolproof — every rep builds their own campaigns (non-technical,
often on a phone), so build EXACTLY three steps: (1) basics — name, General/Industry, channel
chips, a plain "what are you offering?" box, optional file attach, one "Build my outreach"
button; (2) a single review screen showing the FULL cadence top to bottom as a readable
script (later units fill the content); (3) pick recipients + a one-sentence plain summary +
confirm. Lead with finished defaults at every step — never a blank builder.

DEFAULT editable instruction prompt to pre-fill into `campaigns.global_instructions` (the rep
can edit it; tuck it behind an "Edit instructions" expander so it never clutters the basic
flow):
"""
- Emails: open with one line personalized to this lead's context, then 2–3 lines about the
  offer drawn from the campaign knowledge file. Keep it short and human.
- Use SMS only if the prospect hasn't answered earlier touches.
- On the 2nd and 3rd emails, offer to send a one-pager relevant to the prospect's industry and
  suggest a quick meeting.
- Stay grounded in the knowledge file, never over-promise, and always honor opt-outs.
"""
Also pre-fill sensible per-step instructions on each `campaign_steps.custom_instructions`.

Behavior (this unit = the shell + saving only): collect name + type + channels, show the
recommended 9-touch plan presented as FINISHED (rep can nudge days-between or remove a touch),
then a place to type instructions and attach a campaign knowledge file. Save as a draft
campaign. (AI message generation, enrollment, and sending are later units.)

Must handle: empty state (no campaigns yet), a channel the workspace can't use (e.g. no SMS
number connected — disable that channel with a plain-language note), workspace isolation.

Out of scope: AI message generation, enrollment, sending, collateral.
Guardrails to respect: workspace isolation via RLS (is_workspace_member). Any new edge
function needs its [functions.<name>] block in supabase/config.toml in the SAME PR (see
KNOWN_ISSUES.md). Do NOT touch the interactions→lead_timeline_items migration or the
automation_log / automation_logs tables. Confirm none are weakened.
Keep it minimal and clean — no animations, and only plain sales language on screen (no
"sequence step", "cadence object", or status codes).

When the plan's approved and built, I'll run it through the drivepilot-qa skill and apply
any migration via Lovable before moving on.
```

---

## UNIT B — AI content + per-user voice + full-cadence review

```
Build on Unit A. This is the part a young, non-technical SDR actually uses to set up the
messaging, so it must be dead simple to follow — like reading a script top to bottom.

First: read CLAUDE.md, then investigate ai_task (the central AI gateway), the knowledge-base
path (process-knowledge-document for ingest, RPC match_knowledge_chunks_v2 for search), and
_shared/prompts.ts. IMPORTANT — a per-rep voice/style system ALREADY EXISTS: investigate
user_style_directives, the style_examples table, synthesize-style-profile, and the per-lead
outbound_tone column, and REUSE these for the per-user campaign voice rather than building a
new preferences store. ALSO investigate the instruction resolver (_shared/campaignResolver.ts
`resolveCampaignInstruction` / `formatInstructionForPrompt`, _shared/campaignStepLoader.ts
`loadCampaignForLead`, and `DEFAULT_STEP_CONFIG`) — it exists but is NOT yet called by ai_task,
which today uses the legacy `leads.action_instructions` text blob. In your plan, tell me
exactly how you'll reuse the voice system AND wire the resolver into generation. Propose a plan
— do NOT write code until I approve it.

Goal: from the campaign instructions + the uploaded knowledge file + the rep's saved
preferences, generate ready-to-use content for the WHOLE cadence, and let the rep review it
in one easy scroll.

Behavior:
- WIRE THE INSTRUCTION RESOLVER INTO GENERATION (required — it's built but unused today):
  ai_task must load the campaign (loadCampaignForLead), resolve the campaign-level + per-step
  instructions (resolveCampaignInstruction with the structured campaign), and inject the
  formatInstructionForPrompt output into the draft prompt — so the rep's instructions actually
  drive every message (e.g. "SMS only if no answer", "emails 2 and 3 offer a one-pager + a
  meeting"). ai_task is large and load-bearing — modularize carefully and do NOT break existing
  non-campaign drafting or the legacy action_instructions path.
- Surface the campaign-level instructions (global_instructions, pre-filled with the default
  prompt) and per-step instructions (custom_instructions) for editing — reuse the
  CampaignSettingsPanel pattern, tucked behind an "Edit instructions" expander so the basic
  flow stays foolproof. Edits to instructions re-flow into generation; they are not a separate
  silent system.
- Generate a COUPLE of example options for the messaging (not just one), grounded in the
  instructions + knowledge file + the rep's saved preferences. The rep can pick the option
  they like, OR type refining instructions and regenerate new ones.
- EDITS ARE SACRED — never silently regenerate over the rep's work. Once the rep picks a
  version or makes an inline edit, that text is LOCKED as the source. Picking a version does
  NOT wipe edits. The ONLY thing that regenerates is the explicit "Rewrite" action, and it
  regenerates ONLY the touch(es) the rep asked for — never the whole set from scratch. Show a
  small "edited by you" mark on touches the rep has changed so they're left untouched.
- GENERAL vs INDUSTRY: for a General campaign, generate ONE template per touch (reused for
  everyone). For an Industry campaign, generate one template per touch PER industry present in
  the leads; the review screen shows ONE industry at a time with a simple switcher
  ("Showing: <industry>"), never all industries stacked. Blank-industry leads use the General
  template. Keep it to a handful of industries — warn if it would generate an unwieldy number.
- PERSONALIZATION: even a reused General template auto-inserts the lead's first name and
  the customer's company so cold email never reads as a blast. Use safe fallbacks when a field is
  missing (e.g. drop the name rather than print a blank).
- SPAM CHECK: after generating or when the rep edits an email, run a spam-likelihood check
  (reuse the quality_scorer prompt / ai_task — do not add a new AI caller) plus simple
  heuristics (excessive $/!/ALL-CAPS, over-promising subject, too many links). Show a gentle
  inline heads-up with a one-tap "soften this" fix. It is ADVISORY, never a blocker, and must
  not claim to guarantee inbox placement.
- Save the rep's style/voice preferences PER USER, NOT per workspace — two reps at the same
  company can sound different. REUSE the existing per-rep voice system
  (user_style_directives / style_examples / outbound_tone), don't build a new store. Scope
  per-user within the workspace via RLS. These preferences become the smart default for that
  rep's next campaign.
- Generate the RIGHT content for each touch by channel: emails (subject + body), phone-call
  talking points, a voicemail script to leave if no one answers, and SMS copy for the
  "no answer" follow-up.
- Let the rep scroll through the ENTIRE cadence top to bottom and read every piece — every
  email, the call talking points, the voicemail, the SMS — in order, like a script. Editing
  any piece is inline and obvious.
- Where a touch should include collateral (e.g. an email that carries a one-pager), OFFER to
  generate/attach it (this ties to Unit D). Don't force it.
- Ask at most 1–3 clarifying questions, and only when genuinely needed (e.g. missing offer
  deadline, missing target persona). Plain language, never a wall of questions.

Must handle: no knowledge file (generate from instructions alone), a very large file (use the
existing KB chunking), generation failure (clear retry, never a blank screen), a rep with no
saved preferences yet (sensible default voice).

Out of scope: enrollment, sending, the safety gate.
Guardrails to respect: route ALL generation through ai_task — do NOT add a new AI caller.
Honor the 72h / 7-day retention rules — store durable summaries/metadata, don't persist raw
uploaded content in a way that dodges purge (mirror the existing classify path). Per-user
preferences must respect workspace isolation. Any new edge function needs its config.toml
block in the same PR. Confirm none are weakened.
Keep it minimal and clean — plain sales words only on screen.

When approved and built, I'll run it through the drivepilot-qa skill and apply any migration
via Lovable.
```

---

## UNIT D — Collateral generator

```
We're adding a campaign collateral generator: AI builds industry one-pagers and technical
walkthroughs from a campaign's instructions + knowledge file, as reviewable drafts. This is
a documents feature — it produces drafts, it does NOT send.

First: read CLAUDE.md, then investigate ai_task and the knowledge-base path
(match_knowledge_chunks_v2, extract-profile-from-kb), and how documents/attachments are
currently stored. Propose a plan — do NOT write code until I approve it.

Goal: from the campaign's instructions + uploaded knowledge file, generate collateral (start
with an industry one-pager and a technical walkthrough) the rep can review, edit, and attach
to a touch.

Where it lives: a "Collateral" section inside the campaign setup flow. Saved collateral can
be offered when a touch is being written (ties to Unit B's "offer to attach").

Behavior: the rep picks a collateral type, the AI drafts it grounded in the knowledge file
via ai_task, the rep edits and saves. Plain, clean output.

Must handle: no knowledge file (generate from instructions only), generation failure (clear
retry), large files (existing KB chunking).

Out of scope: sending, scheduling, fancy branded templating, image generation.
Guardrails to respect: route generation through ai_task only. Honor retention rules for any
stored source content. Workspace isolation on stored collateral. Any new edge function needs
its config.toml block in the same PR. Confirm none are weakened.
Keep it minimal and clean.

When approved and built, I'll run it through the drivepilot-qa skill and apply any migration
via Lovable.
```

---

## UNIT 0 — Cold-safety prerequisites (must be live before auto-send turns on)

```
Before DrivePilot auto-sends email for cold campaigns, three already-planned safeguards need
to be live. Build these as one focused unit. NOTE: the broader guardrail engine is already
shipped (stop-on-bounce, stop-on-reply, per-mailbox daily cap, per-lead 7d/30d caps, min-gap,
send window, consent, unsubscribe, OOO — all in _shared/executionSettings.ts). These three are
the ONLY remaining gaps; do not rebuild the ones that exist.

First: read CLAUDE.md (production email guardrails) and PROGRESS.md (the "Email-send safety
hardening" section — all three are specced there). Investigate automation-executor's per-lead
loop and cron_run_log. Propose a plan — do NOT write code until I approve it.

Goal: make auto-send safe for batches of brand-new cold leads.
1. New-lead 24h cooldown: at the top of automation-executor's per-lead loop, if
   now() - lead.created_at < 24h, skip and push eligible_at forward. Catches cold-list
   imports dumping new leads into automation (the April 30 failure mode).
2. Volume tripwire: log a volume_alert row in cron_run_log when a workspace exceeds N sends
   per 15-minute window. Doesn't block — just a queryable signal.
3. Workspace timezone settings UI: the dropdown so workspaces other than Cliff's can set a
   timezone (today they fail-closed and cannot auto-send at all).

Must handle: the 24h cooldown must only affect AUTO-SEND — never block a manual rep-approved
send — and must not affect leads that aren't in automation.
Out of scope: the campaign feature itself — this is just the safety floor under it.
Guardrails to respect: don't weaken the consent gate or the send-window logic. Cron changes
go through cron-dispatcher and must update BOTH the live DB and the codify migration. Confirm
none are weakened.
Keep it minimal and clean.

When approved and built, I'll run it through the drivepilot-qa skill and apply any migration
via Lovable.
```

---

## UNIT C — Enrollment + sending (build LAST; highest scrutiny)

```
We're adding lead enrollment and execution to DrivePilot campaigns (Units A, B, D first).
This is COLD outbound with AUTO-SENT emails — the highest-risk path in the product. Treat as
maximum scrutiny. This is an ADDITIVE feature: it must NOT change behavior for any lead not
enrolled in a campaign.

First: read CLAUDE.md (production email guardrails + consent gate), PROGRESS.md (email-send
safety hardening), and KNOWN_ISSUES.md (the consent-gate race). Investigate
automation-executor, syncEngine, the automatic vs review send paths (nurture_mode), how
next_action / eligible_at schedules a touch, the Queue action cards,
gmail-send / outlook-send / sms-send / twilio-voice, AND the existing guardrail engine in
_shared/executionSettings.ts (plus bounceDetection.ts, unsubscribeDetection.ts, oooDetection.ts)
— the campaign must reuse these, not duplicate them. Propose a plan — do NOT write code until
I approve it.

Goal: enroll a set of cold leads into a campaign and run its cadence, where EMAIL touches
auto-send and CALL / SMS / WhatsApp / LinkedIn touches are manual Queue actions.

Behavior:
- Enrolling schedules touch 1. Each completed touch schedules the next by the cadence spacing.
- EMAIL touches AUTO-SEND on their scheduled day via the existing provider path + ALL existing
  guardrails (opt-out, OOO, dedup, send-window, consent gate). They take no rep action and do
  NOT appear as a Queue card. Reflect each auto-send quietly in the lead's history in plain
  words ("We sent the follow-up for you") — never nag in the Queue.

- SEPARATE THE TWO LISTS — do NOT mix cold campaign touches into the existing follow-up
  Queue. Keep ONE Queue page with TWO lists the rep moves between via a visible two-tab
  toggle (swipeable on mobile, but the tabs must be visible — never swipe-only). The Queue's
  tabs are "Replied", "Follow up", and "Outreach" (see Unit E). The reactive tabs (Replied /
  Follow up) stay the DEFAULT view; "Outreach" is the new tab holding cold campaign touches.
  Same card design across all (reuse QueueCard) — different pile, nothing new to learn. This
  is NOT a new top-level surface; it's the Queue page with tabs. When a cold lead replies,
  they LEAVE Outreach and appear under Follow up (the reply-bridge), so engagement always
  lands in the high-value list automatically.
- MANUAL touches appear in the OUTREACH list, ONE loud primary action per card, behavior by channel:
  - Call: a tel: deep-link, opens the dialer. Primary action "Call".
  - SMS: an sms: deep-link with the number + URL-encoded message pre-filled, so it opens the
    texting app ready to send. Primary action "Text".
  - WhatsApp (where the lead has WhatsApp): a wa.me/<number>?text=<encoded> link that opens
    the chat pre-filled. Primary action "WhatsApp". (Use the intent:// form for in-app Android,
    wa.me for browser/desktop.)
  - LinkedIn: LinkedIn does NOT allow pre-filling a message via a link. So "Open LinkedIn" must
    (a) copy the prepared message to the clipboard reliably and silently, then (b) open the
    profile/conversation. The rep pastes and sends.

- TRACKING CAVEAT: call / SMS / WhatsApp / LinkedIn touches go out through the rep's OWN phone
  and apps, NOT DrivePilot's pipeline — so the system cannot confirm the send or detect a reply
  on these. Do NOT auto-mark them as sent. After the deep-link opens, show ONE quiet "Sent it"
  tap that closes the touch and advances the cadence. For call touches, also offer two quiet
  outcome taps — "Got them" / "No answer" — used only to shape the next email/voicemail. Skip
  uses the Queue's existing skip control; do NOT add a third co-equal button.

- Outcome-aware: when an email or voicemail follows a call, pass the recorded call outcome into
  the draft (a "no answer" produces "just tried calling you, following up on my last email").
- Each manual touch has a max-age: if unactioned past the threshold, auto-skip forward and log
  it — never fire late, never let one stuck touch stall the campaign.
- A reply from the lead PULLS them out of the campaign's auto-cadence and back into the rep's
  normal daily Queue as a real reply to handle (reuse the existing pause-on-inbound) — the
  moment someone bites, they stop being "touch 4" and become "a person who replied."
- PAUSE/STOP the whole campaign: one control on the campaign page halts every touch for every
  enrolled lead (reuse the consent/automation_mode clear pattern, like bulk-move-to-nurture).
  Beyond the per-lead auto-pause on reply.
- Leads added to a campaign later start at touch 1 (the campaign is a living list).
- GRACEFULLY SKIP a touch a lead can't receive: no phone → skip call/SMS; no LinkedIn →
  skip that touch; advance the cadence rather than stalling. Warn at enrollment (e.g.
  "12 of these 40 have no phone — they'll skip the call touches").
- Tag each Queue card with just the campaign name (e.g. "EOY Discount") — no "touch 3 of 9".
- Big-book guard: cold touches live in the separate Outreach list (above), so they never
  flood the follow-up list. Within Outreach, still order by what's due and cap how many
  surface per day so even that list stays workable. Excess waits its turn.

THROUGHPUT & TIMING (this is critical — get it right):
The cadence is relative to EACH lead's own start day, never a shared calendar. The system must
pace sends within the existing per-mailbox daily cap so that timing stays correct:
- PRIORITY ORDER each day, within the cap: (1) due follow-ups for already-started leads first,
  (2) then start NEW leads with whatever capacity remains. A started lead must never be late;
  the only thing that waits is the START of not-yet-started leads.
- STAGGER / DRIP the starts at enrollment: do NOT set every enrolled lead's first touch to
  eligible_at = now. Compute staggered first-touch dates so that projected daily load
  (new starts + their future follow-ups) stays within the per-mailbox cap. Recompute as leads
  are added/removed or reply.
- Only AUTO-EMAILS consume the mailbox cap. Calls / LinkedIn / deep-link SMS are manual and do
  NOT — so compute pacing from the real email-touch count and channel mix, not a fixed number.
- BUSINESS-DAY / SEND-WINDOW aware: count business days (reuse isBusinessDay / send-window), so
  "day 2" never lands on a weekend or after-hours send.
- SHARED MAILBOX: the daily cap spans ALL automation for that mailbox (other outreaches +
  nurture). Pace fairly across them, oldest-due first.
- CAPACITY PREVIEW at enrollment (required): show the honest plan, e.g. "300 people, 3 emails
  each, ~40/day → about 13 begin per day, everyone started in ~23 business days." If the
  outreach is too big for the mailbox to keep follow-ups on time, WARN ("more than this mailbox
  can keep on schedule — fewer per day, a second sender, or a longer window") and tie the signal
  to the existing volume tripwire.
Edge cases to handle explicitly: two touches bunching on one lead in a day (1/day rule defers
the later one, logged); adding leads to a running outreach (queue as new starts at the same
drip rate); cron downtime/backlog (on recovery, drain oldest-due first within the cap — never
blast); replies/bounces/unsubscribes/OOO free capacity and speed things up.

REUSE THE EXISTING GUARDRAIL ENGINE — do NOT build campaign-specific caps, a bounce list, or
new send limits. These already exist and are wired into automation-executor; the campaign
sender MUST funnel through them:
- Load settings once per owner via loadExecutionSettings(ownerUserId, supabase).
- Send window / business hours: checkSendWindow().
- Stop-on-reply and other stop conditions: checkStopConditions().
- Minimum gap between sends: checkMinGap().
- Per-lead 7-day / 30-day caps and per-mailbox daily cap: checkPerLeadCaps() + the existing
  daily-cap logic in automation-executor.
- Stop-on-bounce / undeliverable: detectBounce() (sets unsubscribed=true, halts the lead).
- Unsubscribe requests: isHumanUnsubscribeRequest(); consent gate: automation_mode.
Confirm in your plan exactly which existing function each campaign send check calls.

COLD-SPECIFIC requirement (the one genuinely new piece):
- Every auto-sent COLD email needs a working unsubscribe mechanism + physical postal address
  in the footer (CAN-SPAM) — this is about what the OUTBOUND email CONTAINS, separate from the
  existing INBOUND unsubscribe detection. First check whether an outbound unsubscribe footer or
  List-Unsubscribe header already exists; reuse it if so, only add it if missing. It must tie
  into the existing `unsubscribed` flag so a removed lead is never emailed again.

ADDED v1 SAFETY / QUALITY FEATURES (confirmed missing — build these):
- BOUNCE-RATE CIRCUIT BREAKER: beyond the existing per-lead bounce-stop (detectBounce), track
  each outreach's AGGREGATE bounce rate; if it crosses a threshold, auto-PAUSE the whole
  outreach and warn the rep ("this list looks bad — too many addresses are bouncing"). Reuse
  the per-lead bounce detection + the volume tripwire signal. Protects the rep's real
  mailbox/domain reputation — the most important cold safeguard.
- EMAIL VALIDATION AT IMPORT: validate addresses when leads are imported (reuse
  LeadImportDialog / parseLeadFile) — catch malformed/syntactically invalid and obvious junk
  before they ever send; flag suspicious ones. Never auto-send to an invalid address.
- SUPPRESSION ENFORCEMENT: check the workspace do-not-contact list (Unit A) before enrolling
  AND immediately before each send; fail closed.
- RECIPIENT-TIMEZONE SENDING: send in the prospect's local morning, not the rep's. Reuse the
  existing timezone_mode:"lead" scaffolding; derive the lead's timezone from their location
  fields (city/state/country), falling back to the workspace timezone when unknown. Fold into
  the throughput / send-window logic above.
- DO NOT add open/click tracking — deliberately omitted (hurts deliverability, opens are
  unreliable, adds noise).

GATE: cold auto-send must sit behind a switch that is OFF by default and only enabled for a
workspace once Unit 0's safeguards (24h cooldown, volume tripwire, workspace timezone) are live
for that workspace. Building campaigns, enrolling, and all MANUAL touches work regardless of
the gate — only the automatic email sending is gated.

Must handle: opted-out/unsubscribed leads (never enroll/send — fail closed), a lead already in
another campaign or active sequence (don't double-schedule), brand-new leads vs the 24h
cooldown, big-book enrollment of hundreds (auto-emails respect caps; manual touches queue and
are capped per day), a rep replying off-platform, a timezone-null workspace (auto-send stays
disabled there).

Out of scope: branching/conditional flowcharts (keep the cadence linear), an analytics
dashboard, A/B variants, LinkedIn automation.
Guardrails to respect: funnel ALL sends through the existing provider path + automation-executor
guardrails — do NOT write a new sender or bypass the consent gate. Don't alter scheduling/Queue
behavior for non-campaign leads. Respect workspace isolation. Don't reintroduce writes to
interactions. Any new edge function needs its config.toml block in the same PR. Cron changes go
through cron-dispatcher's ALLOWED_TARGETS + a cron job, updating both the DB and the codify
migration. Confirm none are weakened.
Keep it minimal and clean — no animations except a card visibly leaving the Queue when a touch
is done. Plain sales language only — no "deep-link", "intent", or channel jargon on screen.

When approved and built, I'll run it through the drivepilot-qa skill before shipping — flag cold
auto-send, the unsubscribe/CAN-SPAM footer, and the consent gate as the riskiest things to check.
```

---

## UNIT E — Queue tabs (Replied / Follow up / Outreach)

```
We're simplifying the Queue's tabs. This touches the Queue (a sacred, near-zero-decision
surface) and the out-of-office handling — treat with care.

First: read CLAUDE.md, then investigate how the Queue tabs/filters currently work — today they
are "Replied", "Follow up Due", and "OOO" — in src/pages/Queue.tsx and the related filtering
logic, and how out-of-office leads are detected/paused (_shared/oooDetection.ts, applyOOOPause).
Propose a plan — do NOT write code until I approve it.

Goal: change the Queue to three tabs — "Replied", "Follow up", "Outreach".
- Rename "Follow up Due" to "Follow up".
- REMOVE the dedicated "OOO" tab. Leads that hit an out-of-office should instead appear under
  "Follow up" when they're next due, with a small plain reason note on the card (e.g. "was
  away — back now") so the rep isn't confused about why it resurfaced. Simplify the
  navigation, keep the breadcrumb — don't lose the information.
- "Outreach" is the cold campaign touches list (built in Unit C). If Unit C isn't built yet,
  add the tab with a friendly empty state ("No outreach yet").
- The reactive view (Replied / Follow up) stays the DEFAULT — never open on Outreach.

CRITICAL guardrail: this is a SCREEN change only. Do NOT touch the out-of-office DETECTION or
the out-of-office SEND-PAUSE logic (oooDetection.ts / applyOOOPause). Automation must still
pause sending when someone is away. We are changing how out-of-office leads are SHOWN in the
Queue, not whether automation respects out-of-office.

Out of scope: any change to send/pause behavior, any new tab beyond these three.
Keep it minimal and clean — plain sales words only, no animations.

When approved and built, I'll run it through the drivepilot-qa skill before shipping — flag
that the out-of-office send-pause behavior must be verified UNCHANGED.
```

---

## After you've built everything

- Every unit goes through the **drivepilot-qa** skill before it's considered shippable.
- Cold auto-send stays OFF until **Unit 0** is live for the workspace.
- Deferred on purpose (parked, not lost): a campaign analytics dashboard, A/B message
  testing, branching cadences, closing the tracking gap on phone-app sends, and these
  fast-follows from the design discussion — test-send-to-yourself before launch, a tiny
  campaign status line (sent/replied/finished), and clone-a-campaign for reuse next time.
