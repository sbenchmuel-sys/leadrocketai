/**
 * Enterprise Demo Dataset — 40 curated leads for strategic meetings.
 * Revenue State distribution: 16 Active, 8 Action Required, 8 Heating Up, 8 Long Cycle
 */

import type { EnrichedLead, DealStage, Motion, SourceType, RevenueState } from "@/lib/dashboardUtils";

function daysAgo(d: number): string {
  const dt = new Date();
  dt.setDate(dt.getDate() - d);
  return dt.toISOString();
}

const now = new Date().toISOString();
const yesterday = daysAgo(1);
const threeDaysAgo = daysAgo(3);
const tenDaysAgo = daysAgo(10);
const twentyDaysAgo = daysAgo(20);
const thirtyDaysAgo = daysAgo(30);
const sixtyDaysAgo = daysAgo(60);
const ninetyDaysAgo = daysAgo(90);

interface DemoLeadInput {
  id: string;
  name: string;
  company: string;
  email: string;
  stage: DealStage;
  motion: Motion;
  source_type: SourceType;
  needs_action: boolean;
  next_action_key: string | null;
  next_action_label: string | null;
  action_reason_code: string | null;
  last_activity_at: string;
  created_at: string;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  first_outbound_at: string | null;
  meeting_summary_count: number;
  nurture_mode: string;
  nurture_status: string;
  nurture_cadence: string | null;
  eligible_at: string | null;
  deal_outlook: string | null;
  country: string | null;
  next_step: string | null;
  revenueState: RevenueState;
}

function buildLead(input: DemoLeadInput): EnrichedLead {
  return {
    id: input.id,
    name: input.name,
    company: input.company,
    email: input.email,
    status: "active",
    owner_user_id: "demo-user",
    created_at: input.created_at,
    last_activity_at: input.last_activity_at,
    stage: input.stage,
    needs_action: input.needs_action,
    next_action_key: input.next_action_key,
    next_action_label: input.next_action_label,
    action_reason_code: input.action_reason_code,
    hasMeeting: input.meeting_summary_count > 0,
    last_outbound_at: input.last_outbound_at,
    last_inbound_at: input.last_inbound_at,
    first_outbound_at: input.first_outbound_at,
    source_type: input.source_type,
    motion: input.motion,
    displayPhase: input.motion === "nurture" ? "Nurture" : input.stage === "closing" ? "Closing" : input.stage === "post_meeting" ? "Post-Meeting" : input.stage === "engaged" ? "Engaged" : "Prospecting",
    origin_category: ["contact_form", "gmail_inbound", "referral"].includes(input.source_type) ? "inbound" : "outbound",
    nurture_mode: input.nurture_mode,
    nurture_status: input.nurture_status,
    eligible_at: input.eligible_at,
    revenueState: input.revenueState,
    meeting_summary_count: input.meeting_summary_count,
    deal_outlook: input.deal_outlook,
    country: input.country,
    next_step: input.next_step,
    nurture_cadence: input.nurture_cadence,
  } as EnrichedLead;
}

// =============================================
// ACTION REQUIRED (8 leads)
// =============================================
const actionRequired: DemoLeadInput[] = [
  {
    id: "demo-ar-1", name: "Marcus Holt", company: "SecureTech Solutions", email: "m.holt@securetech.io",
    stage: "engaged", motion: "inbound_response", source_type: "gmail_inbound",
    needs_action: true, next_action_key: "reply_now", next_action_label: "Reply to pricing inquiry",
    action_reason_code: "unreplied_inbound",
    last_activity_at: now, created_at: thirtyDaysAgo,
    last_outbound_at: threeDaysAgo, last_inbound_at: now, first_outbound_at: twentyDaysAgo,
    meeting_summary_count: 1, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Interested in enterprise tier pricing", country: "US",
    next_step: "Send pricing breakdown", revenueState: "action_required",
  },
  {
    id: "demo-ar-2", name: "Sarah Chen", company: "Global Compliance Group", email: "s.chen@gcg.com",
    stage: "post_meeting", motion: "post_meeting", source_type: "outbound_prospecting",
    needs_action: true, next_action_key: "post_meeting_followup", next_action_label: "Send meeting follow-up",
    action_reason_code: "missing_recap",
    last_activity_at: yesterday, created_at: sixtyDaysAgo,
    last_outbound_at: tenDaysAgo, last_inbound_at: yesterday, first_outbound_at: sixtyDaysAgo,
    meeting_summary_count: 2, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Budget approved, waiting on legal", country: "UK",
    next_step: "Legal review response", revenueState: "action_required",
  },
  {
    id: "demo-ar-3", name: "David Reeves", company: "Nordic Risk Advisory", email: "d.reeves@nordicrisk.no",
    stage: "closing", motion: "closing", source_type: "referral",
    needs_action: true, next_action_key: "send_proposal", next_action_label: "Send revised proposal",
    action_reason_code: "pending_proposal",
    last_activity_at: yesterday, created_at: ninetyDaysAgo,
    last_outbound_at: daysAgo(4), last_inbound_at: yesterday, first_outbound_at: ninetyDaysAgo,
    meeting_summary_count: 3, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Budget objection — needs discount justification", country: "NO",
    next_step: "Revised pricing with volume discount", revenueState: "action_required",
  },
  {
    id: "demo-ar-4", name: "Lisa Park", company: "Apex Insurance Brokers", email: "l.park@apexins.com",
    stage: "engaged", motion: "inbound_response", source_type: "contact_form",
    needs_action: true, next_action_key: "reply_now", next_action_label: "Reply to demo request",
    action_reason_code: "unreplied_inbound",
    last_activity_at: now, created_at: tenDaysAgo,
    last_outbound_at: threeDaysAgo, last_inbound_at: now, first_outbound_at: tenDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Requesting product demo for Q3 evaluation", country: "US",
    next_step: "Schedule demo call", revenueState: "action_required",
  },
  {
    id: "demo-ar-5", name: "Tom Eriksson", company: "Prime Property Capital", email: "t.eriksson@primeprop.se",
    stage: "post_meeting", motion: "post_meeting", source_type: "event_lead",
    needs_action: true, next_action_key: "generate_post_meeting_recap", next_action_label: "Generate meeting recap",
    action_reason_code: "missing_recap",
    last_activity_at: yesterday, created_at: thirtyDaysAgo,
    last_outbound_at: threeDaysAgo, last_inbound_at: yesterday, first_outbound_at: twentyDaysAgo,
    meeting_summary_count: 1, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Exploring multi-site deployment", country: "SE",
    next_step: "Recap + ROI projection", revenueState: "action_required",
  },
  {
    id: "demo-ar-6", name: "Nina Volkov", company: "IronGate Cybersecurity", email: "n.volkov@irongate.io",
    stage: "closing", motion: "closing", source_type: "outbound_prospecting",
    needs_action: true, next_action_key: "closing_followup", next_action_label: "Follow up on contract review",
    action_reason_code: "pending_proposal",
    last_activity_at: threeDaysAgo, created_at: sixtyDaysAgo,
    last_outbound_at: daysAgo(5), last_inbound_at: threeDaysAgo, first_outbound_at: sixtyDaysAgo,
    meeting_summary_count: 2, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Waiting on legal review of MSA", country: "US",
    next_step: "Follow up with legal team", revenueState: "action_required",
  },
  {
    id: "demo-ar-7", name: "James O'Brien", company: "BluePeak Managed Services", email: "j.obrien@bluepeak.ie",
    stage: "engaged", motion: "inbound_response", source_type: "gmail_inbound",
    needs_action: true, next_action_key: "reply_now", next_action_label: "Reply to technical question",
    action_reason_code: "unreplied_inbound",
    last_activity_at: now, created_at: twentyDaysAgo,
    last_outbound_at: threeDaysAgo, last_inbound_at: now, first_outbound_at: twentyDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Integration compatibility questions", country: "IE",
    next_step: "Answer API integration questions", revenueState: "action_required",
  },
  {
    id: "demo-ar-8", name: "Elena Martinez", company: "Sentinel Data Systems", email: "e.martinez@sentinel.mx",
    stage: "engaged", motion: "inbound_response", source_type: "referral",
    needs_action: true, next_action_key: "reply_now", next_action_label: "Reply to stakeholder introduction",
    action_reason_code: "unreplied_inbound",
    last_activity_at: yesterday, created_at: thirtyDaysAgo,
    last_outbound_at: daysAgo(4), last_inbound_at: yesterday, first_outbound_at: thirtyDaysAgo,
    meeting_summary_count: 1, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "VP Engineering looped in — stakeholder expansion", country: "MX",
    next_step: "Respond to VP introduction", revenueState: "action_required",
  },
];

// =============================================
// HEATING UP (8 leads)
// =============================================
const heatingUp: DemoLeadInput[] = [
  {
    id: "demo-hu-1", name: "Robert Kim", company: "Atlas Governance Consulting", email: "r.kim@atlasgov.com",
    stage: "closing", motion: "closing", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: now, created_at: thirtyDaysAgo,
    last_outbound_at: now, last_inbound_at: yesterday, first_outbound_at: thirtyDaysAgo,
    meeting_summary_count: 2, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Pricing discussion underway — requesting volume discount", country: "US",
    next_step: "Await pricing approval", revenueState: "heating_up",
  },
  {
    id: "demo-hu-2", name: "Priya Sharma", company: "Vertex Legal Advisory", email: "p.sharma@vertexlaw.in",
    stage: "post_meeting", motion: "post_meeting", source_type: "gmail_inbound",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: now, created_at: twentyDaysAgo,
    last_outbound_at: now, last_inbound_at: yesterday, first_outbound_at: twentyDaysAgo,
    meeting_summary_count: 1, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Multi-stakeholder expansion — COO joining next call", country: "IN",
    next_step: "Prepare executive presentation", revenueState: "heating_up",
  },
  {
    id: "demo-hu-3", name: "Anders Lindqvist", company: "Summit Real Estate Holdings", email: "a.lindqvist@summitholdings.se",
    stage: "engaged", motion: "inbound_response", source_type: "event_lead",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: tenDaysAgo,
    last_outbound_at: yesterday, last_inbound_at: daysAgo(2), first_outbound_at: tenDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Meeting scheduled — technical deep dive", country: "SE",
    next_step: "Prepare demo environment", revenueState: "heating_up",
  },
  {
    id: "demo-hu-4", name: "Catherine Dubois", company: "Titan Infrastructure Partners", email: "c.dubois@titaninfra.fr",
    stage: "closing", motion: "closing", source_type: "referral",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: now, created_at: sixtyDaysAgo,
    last_outbound_at: yesterday, last_inbound_at: now, first_outbound_at: sixtyDaysAgo,
    meeting_summary_count: 3, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Timeline discussion — Q2 deployment target", country: "FR",
    next_step: "Finalize deployment timeline", revenueState: "heating_up",
  },
  {
    id: "demo-hu-5", name: "Michael Torres", company: "Quantum Cloud Services", email: "m.torres@quantumcloud.com",
    stage: "post_meeting", motion: "post_meeting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: thirtyDaysAgo,
    last_outbound_at: yesterday, last_inbound_at: daysAgo(2), first_outbound_at: thirtyDaysAgo,
    meeting_summary_count: 2, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "CTO requested security whitepaper", country: "US",
    next_step: "Send security documentation", revenueState: "heating_up",
  },
  {
    id: "demo-hu-6", name: "Yuki Tanaka", company: "Horizon Financial Group", email: "y.tanaka@horizonfg.jp",
    stage: "engaged", motion: "inbound_response", source_type: "contact_form",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: now, created_at: tenDaysAgo,
    last_outbound_at: now, last_inbound_at: yesterday, first_outbound_at: tenDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Fast reply latency — evaluating competitors", country: "JP",
    next_step: "Send competitive positioning deck", revenueState: "heating_up",
  },
  {
    id: "demo-hu-7", name: "Anna Kowalski", company: "Fortress IT Security", email: "a.kowalski@fortressit.pl",
    stage: "post_meeting", motion: "post_meeting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: twentyDaysAgo,
    last_outbound_at: yesterday, last_inbound_at: daysAgo(2), first_outbound_at: twentyDaysAgo,
    meeting_summary_count: 1, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Procurement stage — vendor form requested", country: "PL",
    next_step: "Complete vendor assessment", revenueState: "heating_up",
  },
  {
    id: "demo-hu-8", name: "Lucas Weber", company: "RedStone Enterprise Systems", email: "l.weber@redstone.de",
    stage: "engaged", motion: "inbound_response", source_type: "gmail_inbound",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: now, created_at: tenDaysAgo,
    last_outbound_at: now, last_inbound_at: yesterday, first_outbound_at: tenDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Demo completed — requesting pilot program details", country: "DE",
    next_step: "Send pilot proposal", revenueState: "heating_up",
  },
];

// =============================================
// LONG CYCLE (8 leads)
// =============================================
const longCycle: DemoLeadInput[] = [
  {
    id: "demo-lc-1", name: "George Hamilton", company: "Meridian Healthcare Systems", email: "g.hamilton@meridianhc.com",
    stage: "engaged", motion: "outbound_prospecting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: twentyDaysAgo, created_at: ninetyDaysAgo,
    last_outbound_at: twentyDaysAgo, last_inbound_at: thirtyDaysAgo, first_outbound_at: ninetyDaysAgo,
    meeting_summary_count: 1, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Budget delayed to Q3 — still interested", country: "US",
    next_step: "Q3 budget reactivation check-in", revenueState: "long_cycle",
  },
  {
    id: "demo-lc-2", name: "Diana Rossi", company: "Pinnacle Manufacturing Group", email: "d.rossi@pinnaclemfg.it",
    stage: "post_meeting", motion: "post_meeting", source_type: "event_lead",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: twentyDaysAgo, created_at: ninetyDaysAgo,
    last_outbound_at: twentyDaysAgo, last_inbound_at: daysAgo(25), first_outbound_at: ninetyDaysAgo,
    meeting_summary_count: 2, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Procurement phase — enterprise compliance review", country: "IT",
    next_step: "Follow up on procurement timeline", revenueState: "long_cycle",
  },
  {
    id: "demo-lc-3", name: "Henry Watanabe", company: "Pacific Logistics Corp", email: "h.watanabe@pacificlog.jp",
    stage: "engaged", motion: "outbound_prospecting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: daysAgo(18), created_at: ninetyDaysAgo,
    last_outbound_at: daysAgo(18), last_inbound_at: daysAgo(22), first_outbound_at: ninetyDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Internal restructuring — decision postponed", country: "JP",
    next_step: "Re-engage after restructuring", revenueState: "long_cycle",
  },
  {
    id: "demo-lc-4", name: "Sophie Laurent", company: "Continental Energy Partners", email: "s.laurent@continentalep.fr",
    stage: "closing", motion: "closing", source_type: "referral",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: twentyDaysAgo, created_at: ninetyDaysAgo,
    last_outbound_at: twentyDaysAgo, last_inbound_at: daysAgo(25), first_outbound_at: ninetyDaysAgo,
    meeting_summary_count: 3, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Board approval required — Q3 target", country: "FR",
    next_step: "Await board decision", revenueState: "long_cycle",
  },
  {
    id: "demo-lc-5", name: "Ahmed Al-Rashid", company: "Gulf Infrastructure Holdings", email: "a.alrashid@gulfinfra.ae",
    stage: "post_meeting", motion: "post_meeting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: daysAgo(16), created_at: ninetyDaysAgo,
    last_outbound_at: daysAgo(16), last_inbound_at: daysAgo(20), first_outbound_at: ninetyDaysAgo,
    meeting_summary_count: 1, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Regulatory approval pending", country: "AE",
    next_step: "Monitor regulatory timeline", revenueState: "long_cycle",
  },
  {
    id: "demo-lc-6", name: "Clara Müller", company: "Alpine Wealth Management", email: "c.muller@alpinewealth.ch",
    stage: "engaged", motion: "outbound_prospecting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: twentyDaysAgo, created_at: ninetyDaysAgo,
    last_outbound_at: twentyDaysAgo, last_inbound_at: thirtyDaysAgo, first_outbound_at: ninetyDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Compliance audit taking priority", country: "CH",
    next_step: "Re-engage post audit cycle", revenueState: "long_cycle",
  },
  {
    id: "demo-lc-7", name: "Patrick Brennan", company: "Celtic Data Analytics", email: "p.brennan@celticdata.ie",
    stage: "engaged", motion: "outbound_prospecting", source_type: "gmail_inbound",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: daysAgo(22), created_at: ninetyDaysAgo,
    last_outbound_at: daysAgo(22), last_inbound_at: daysAgo(28), first_outbound_at: ninetyDaysAgo,
    meeting_summary_count: 1, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Team expansion in progress — revisit after hiring", country: "IE",
    next_step: "Q3 reactivation outreach", revenueState: "long_cycle",
  },
  {
    id: "demo-lc-8", name: "Maria Santos", company: "Iberian Transport Group", email: "m.santos@iberiantg.pt",
    stage: "post_meeting", motion: "post_meeting", source_type: "event_lead",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: twentyDaysAgo, created_at: ninetyDaysAgo,
    last_outbound_at: twentyDaysAgo, last_inbound_at: daysAgo(26), first_outbound_at: ninetyDaysAgo,
    meeting_summary_count: 2, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Government tender dependency", country: "PT",
    next_step: "Await tender outcome", revenueState: "long_cycle",
  },
];

// =============================================
// ACTIVE (16 leads)
// =============================================
const active: DemoLeadInput[] = [
  {
    id: "demo-ac-1", name: "William Chen", company: "Cascade Software Solutions", email: "w.chen@cascadesoft.com",
    stage: "contacted", motion: "outbound_prospecting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: tenDaysAgo,
    last_outbound_at: yesterday, last_inbound_at: null, first_outbound_at: tenDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Ongoing dialogue — evaluating options", country: "US",
    next_step: "Await response to outreach", revenueState: "active",
  },
  {
    id: "demo-ac-2", name: "Rachel Moore", company: "Sterling Investment Group", email: "r.moore@sterlinginv.com",
    stage: "engaged", motion: "inbound_response", source_type: "contact_form",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: twentyDaysAgo,
    last_outbound_at: yesterday, last_inbound_at: threeDaysAgo, first_outbound_at: twentyDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Technical validation in progress", country: "US",
    next_step: "Send technical documentation", revenueState: "active",
  },
  {
    id: "demo-ac-3", name: "Daniel Kofi", company: "Sahara Fintech", email: "d.kofi@saharafin.gh",
    stage: "contacted", motion: "outbound_prospecting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: threeDaysAgo, created_at: tenDaysAgo,
    last_outbound_at: threeDaysAgo, last_inbound_at: null, first_outbound_at: tenDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Initial outreach — awaiting response", country: "GH",
    next_step: "Follow up in 3 days", revenueState: "active",
  },
  {
    id: "demo-ac-4", name: "Jessica Andersen", company: "Nordic Cloud Infrastructure", email: "j.andersen@nordiccloud.dk",
    stage: "engaged", motion: "inbound_response", source_type: "gmail_inbound",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: thirtyDaysAgo,
    last_outbound_at: yesterday, last_inbound_at: threeDaysAgo, first_outbound_at: thirtyDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Demo completed — awaiting feedback", country: "DK",
    next_step: "Follow up on demo feedback", revenueState: "active",
  },
  {
    id: "demo-ac-5", name: "Kevin Patel", company: "Crossroads Consulting", email: "k.patel@crossroadsconsult.co.uk",
    stage: "contacted", motion: "outbound_prospecting", source_type: "csv_import",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: threeDaysAgo, created_at: tenDaysAgo,
    last_outbound_at: threeDaysAgo, last_inbound_at: null, first_outbound_at: tenDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Cold outreach — sequence in progress", country: "UK",
    next_step: "Send follow-up #2", revenueState: "active",
  },
  {
    id: "demo-ac-6", name: "Laura Bergström", company: "Boreal Tech Ventures", email: "l.bergstrom@borealtech.fi",
    stage: "engaged", motion: "inbound_response", source_type: "event_lead",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: twentyDaysAgo,
    last_outbound_at: yesterday, last_inbound_at: threeDaysAgo, first_outbound_at: twentyDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Engaged post-event — requesting case studies", country: "FI",
    next_step: "Send case study deck", revenueState: "active",
  },
  {
    id: "demo-ac-7", name: "Oscar Mendes", company: "Andean Mining Corp", email: "o.mendes@andeanmining.cl",
    stage: "new", motion: "outbound_prospecting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: daysAgo(5),
    last_outbound_at: yesterday, last_inbound_at: null, first_outbound_at: daysAgo(5),
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "New prospect — initial outreach sent", country: "CL",
    next_step: "Await initial response", revenueState: "active",
  },
  {
    id: "demo-ac-8", name: "Hannah Liu", company: "Jade Capital Partners", email: "h.liu@jadecap.sg",
    stage: "engaged", motion: "inbound_response", source_type: "referral",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: threeDaysAgo, created_at: twentyDaysAgo,
    last_outbound_at: threeDaysAgo, last_inbound_at: daysAgo(5), first_outbound_at: twentyDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Referral introduction — building rapport", country: "SG",
    next_step: "Schedule introductory call", revenueState: "active",
  },
  {
    id: "demo-ac-9", name: "Viktor Johansson", company: "Arctic Shipping Lines", email: "v.johansson@arcticship.no",
    stage: "contacted", motion: "outbound_prospecting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: threeDaysAgo, created_at: tenDaysAgo,
    last_outbound_at: threeDaysAgo, last_inbound_at: null, first_outbound_at: tenDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Sequence in progress — email 2 sent", country: "NO",
    next_step: "Monitor for response", revenueState: "active",
  },
  {
    id: "demo-ac-10", name: "Emily Sato", company: "Keystone Digital Agency", email: "e.sato@keystonedigital.ca",
    stage: "engaged", motion: "inbound_response", source_type: "contact_form",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: tenDaysAgo,
    last_outbound_at: yesterday, last_inbound_at: threeDaysAgo, first_outbound_at: tenDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Inbound lead — exploring use cases", country: "CA",
    next_step: "Share relevant use cases", revenueState: "active",
  },
  {
    id: "demo-ac-11", name: "Bruno Costa", company: "Rio Agritech", email: "b.costa@rioagritech.br",
    stage: "contacted", motion: "outbound_prospecting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: threeDaysAgo, created_at: daysAgo(8),
    last_outbound_at: threeDaysAgo, last_inbound_at: null, first_outbound_at: daysAgo(8),
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Cold outreach — targeted account", country: "BR",
    next_step: "Send follow-up email", revenueState: "active",
  },
  {
    id: "demo-ac-12", name: "Aisha Khan", company: "Crescent Pharma Group", email: "a.khan@crescentpharma.pk",
    stage: "new", motion: "outbound_prospecting", source_type: "csv_import",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: daysAgo(3),
    last_outbound_at: yesterday, last_inbound_at: null, first_outbound_at: daysAgo(3),
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "New import — first touch sent", country: "PK",
    next_step: "Monitor engagement", revenueState: "active",
  },
  {
    id: "demo-ac-13", name: "Tobias Richter", company: "Autobahn Logistics GmbH", email: "t.richter@autobahnlog.de",
    stage: "contacted", motion: "outbound_prospecting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: threeDaysAgo, created_at: tenDaysAgo,
    last_outbound_at: threeDaysAgo, last_inbound_at: null, first_outbound_at: tenDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Outreach sequence — email 3 pending", country: "DE",
    next_step: "Send follow-up #3", revenueState: "active",
  },
  {
    id: "demo-ac-14", name: "Nadia Popescu", company: "Carpathian Energy Solutions", email: "n.popescu@carpathianenergy.ro",
    stage: "engaged", motion: "inbound_response", source_type: "gmail_inbound",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: twentyDaysAgo,
    last_outbound_at: yesterday, last_inbound_at: threeDaysAgo, first_outbound_at: twentyDaysAgo,
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Requested product comparison matrix", country: "RO",
    next_step: "Prepare comparison document", revenueState: "active",
  },
  {
    id: "demo-ac-15", name: "Chris Walker", company: "Ironclad Defense Tech", email: "c.walker@ironcladdef.com",
    stage: "new", motion: "outbound_prospecting", source_type: "manual_entry",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: daysAgo(2), created_at: daysAgo(4),
    last_outbound_at: daysAgo(2), last_inbound_at: null, first_outbound_at: daysAgo(4),
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Warm intro via board connection", country: "US",
    next_step: "Follow up on intro", revenueState: "active",
  },
  {
    id: "demo-ac-16", name: "Ingrid Haugen", company: "Fjord Maritime AS", email: "i.haugen@fjordmaritime.no",
    stage: "contacted", motion: "outbound_prospecting", source_type: "outbound_prospecting",
    needs_action: false, next_action_key: null, next_action_label: null, action_reason_code: null,
    last_activity_at: yesterday, created_at: daysAgo(7),
    last_outbound_at: yesterday, last_inbound_at: null, first_outbound_at: daysAgo(7),
    meeting_summary_count: 0, nurture_mode: "manual", nurture_status: "inactive", nurture_cadence: null,
    eligible_at: null, deal_outlook: "Sequence running — monitoring open rates", country: "NO",
    next_step: "Track engagement signals", revenueState: "active",
  },
];

export const demoLeads: EnrichedLead[] = [
  ...actionRequired,
  ...heatingUp,
  ...longCycle,
  ...active,
].map(buildLead);
