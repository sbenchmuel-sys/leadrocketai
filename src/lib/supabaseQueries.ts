// 07_SUPABASE_JS_QUERIES
// Database query functions for Deal Assistant

import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import { isDemoMode } from '@/lib/demoMode';
import { getDemoLeadDetail, getDemoInteractions, getDemoDrafts } from '@/lib/demoData';

type Profile = Database['public']['Tables']['profiles']['Row'];
type Lead = Database['public']['Tables']['leads']['Row'];
type Interaction = Database['public']['Tables']['interactions']['Row'];
type Draft = Database['public']['Tables']['drafts']['Row'];

// ============================================
// PROFILE QUERIES
// ============================================

export async function getCurrentProfile(): Promise<Pick<Profile, 'user_id' | 'role' | 'onboarding_step' | 'onboarding_done'>> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('user_id, role, onboarding_step, onboarding_done')
    .eq('user_id', user.id)
    .single();

  if (error) throw error;
  return profile;
}

export async function createProfileIfMissing(): Promise<{ user_id: string }> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const { data: existing, error: exErr } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (exErr) throw exErr;
  if (existing?.user_id) return existing;

  const { data, error } = await supabase
    .from('profiles')
    .insert({ user_id: user.id, role: 'sales', onboarding_step: 0, onboarding_done: false })
    .select('user_id')
    .single();

  if (error) throw error;
  return data;
}

export async function setOnboardingStep(step: number): Promise<{ user_id: string; onboarding_step: number }> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const { data, error } = await supabase
    .from('profiles')
    .update({ onboarding_step: step })
    .eq('user_id', user.id)
    .select('user_id, onboarding_step')
    .single();

  if (error) throw error;
  return data;
}

export async function finishOnboarding(): Promise<{ user_id: string; onboarding_done: boolean; onboarding_step: number }> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const { data, error } = await supabase
    .from('profiles')
    .update({ onboarding_done: true, onboarding_step: 999 })
    .eq('user_id', user.id)
    .select('user_id, onboarding_done, onboarding_step')
    .single();

  if (error) throw error;
  return data;
}

// ============================================
// LEADS QUERIES
// ============================================

export type LeadListItem = Pick<Lead, 
  'id' | 'company' | 'name' | 'email' | 'status' | 
  'owner_user_id' | 'created_at' | 'last_activity_at' | 'next_step' | 'deal_outlook' | 'country' | 'motion' | 'source_type'
>;

export async function getLeadsList(): Promise<LeadListItem[]> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (profErr) throw profErr;

  let query = supabase
    .from('leads')
    .select('id, company, name, email, status, owner_user_id, created_at, last_activity_at, next_step, deal_outlook, country, motion, source_type')
    .order('last_activity_at', { ascending: false })
    .limit(200);

  if (profile?.role !== 'admin') {
    query = query.eq('owner_user_id', user.id);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export type LeadDetail = Pick<Lead,
  'id' | 'company' | 'name' | 'email' | 'strategy' | 'status' | 'stage' | 'owner_user_id' |
  'created_at' | 'last_activity_at' | 'meeting_link' | 'personal_notes' |
  'pref_email_drafts' | 'pref_linkedin_drafts' | 'milestones_json' | 'risks_json' |
  'next_step' | 'next_step_reason' | 'deal_outlook' | 'deal_factors_json' | 'last_ai_run_at' |
  'job_title' | 'phone' | 'industry' | 'country' | 'initial_message' |
  'motion' | 'source_type' | 'needs_action' | 'next_action_key' | 'next_action_label' |
  'has_future_meeting' | 'last_inbound_at' | 'last_outbound_at' | 'eligible_at' |
  'nurture_cadence' | 'mode_changed_at' | 'nurture_status' | 'nurture_mode' | 'nurture_theme' |
  'wa_opted_in' | 'automation_mode' | 'action_instructions' |
  'website' | 'linkedin_url' | 'company_linkedin_url' | 'city' | 'state'
> & {
  // Phase 1 multi-contact thread support — populated by automation-executor when
  // a thread becomes multi-participant. Optional because Lovable will regenerate
  // types.ts on the next migration apply; this widens the type until then.
  manual_mode?: boolean;
  manual_mode_reason?: string | null;
  manual_mode_set_at?: string | null;
};

export async function getLeadDetail(leadId: string): Promise<LeadDetail> {
  if (!leadId) throw new Error('Missing leadId');

  if (isDemoMode()) {
    const demo = getDemoLeadDetail(leadId);
    if (!demo) throw new Error('Lead not found');
    return demo as unknown as LeadDetail;
  }
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (profErr) throw profErr;

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, company, name, email, strategy, status, stage, owner_user_id, created_at, last_activity_at, meeting_link, personal_notes, pref_email_drafts, pref_linkedin_drafts, milestones_json, risks_json, next_step, next_step_reason, deal_outlook, deal_factors_json, last_ai_run_at, job_title, phone, industry, country, initial_message, motion, source_type, needs_action, next_action_key, next_action_label, has_future_meeting, last_inbound_at, last_outbound_at, eligible_at, nurture_cadence, mode_changed_at, nurture_status, nurture_mode, nurture_theme, wa_opted_in, automation_mode, action_instructions, website, linkedin_url, company_linkedin_url, city, state, manual_mode, manual_mode_reason, manual_mode_set_at')
    .eq('id', leadId)
    .single();
  if (leadErr) throw leadErr;

  if (profile?.role !== 'admin' && lead.owner_user_id !== user.id) {
    throw new Error('Not authorized to view this lead.');
  }

  return lead;
}

export interface CreateLeadInput {
  name: string;
  company: string;
  email: string;
  source_type?: 'outbound_prospecting' | 'contact_form' | 'gmail_inbound' | 'event_lead' | 'referral' | 'csv_import' | 'manual_entry' | 'whatsapp_inbound';
  motion?: string;
  workspace_id?: string;
}

/**
 * Resolves workspace_id deterministically:
 * - If provided, use it
 * - If user has exactly 1 workspace, use it
 * - If user has 0 or 2+ workspaces and none provided, throw
 */
async function resolveWorkspaceId(userId: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;

  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId);

  if (!memberships || memberships.length === 0) {
    throw new Error('No workspace found for user');
  }
  if (memberships.length > 1) {
    throw new Error('Multiple workspaces found — please select a workspace before creating leads');
  }
  return memberships[0].workspace_id;
}

export async function createLead(form: CreateLeadInput): Promise<{ id: string }> {
  if (isDemoMode()) return { id: 'demo-blocked' };
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const workspaceId = await resolveWorkspaceId(user.id, form.workspace_id);

  const payload = {
    name: form.name?.trim(),
    company: form.company?.trim(),
    email: form.email?.trim().toLowerCase(),
    strategy: 'fast' as const,
    motion: form.motion || 'outbound_prospecting',
    source_type: form.source_type || 'manual_entry',
    owner_user_id: user.id,
    workspace_id: workspaceId,
    last_activity_at: new Date().toISOString(),
  };

  if (!payload.name || !payload.company || !payload.email) {
    throw new Error('Missing required lead fields');
  }

  const { data, error } = await supabase
    .from('leads')
    .insert(payload)
    .select('id')
    .single();

  if (error) throw error;
  return data;
}

export interface UpdateLeadPrefsInput {
  pref_email_drafts?: boolean;
  pref_linkedin_drafts?: boolean;
  meeting_link?: string;
  personal_notes?: string;
}

export async function updateLeadPrefs(leadId: string, form: UpdateLeadPrefsInput): Promise<{ id: string }> {
  if (!leadId) throw new Error('Missing leadId');

  const { data, error } = await supabase
    .from('leads')
    .update({
      pref_email_drafts: !!form.pref_email_drafts,
      pref_linkedin_drafts: !!form.pref_linkedin_drafts,
      meeting_link: form.meeting_link?.trim() || null,
      personal_notes: form.personal_notes?.trim() || null,
      last_activity_at: new Date().toISOString(),
    })
    .eq('id', leadId)
    .select('id')
    .single();

  if (error) throw error;
  return data;
}

export async function deleteLead(leadId: string): Promise<void> {
  if (isDemoMode()) return;
  if (!leadId) throw new Error('Missing leadId');

  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', leadId);

  if (error) throw error;
}

// ============================================
// INTERACTIONS QUERIES
// ============================================

export type InteractionItem = Pick<Interaction,
  'id' | 'lead_id' | 'type' | 'source' | 'occurred_at' | 'subject' |
  'from_email' | 'to_email' | 'to_emails' | 'cc_emails' | 'body_text' | 'ai_summary' | 'ai_intent' | 'ai_reply_worthy' | 'gmail_message_id' | 'gmail_thread_id' | 'hidden'
>;

export async function getLeadInteractions(leadId: string, includeHidden = false): Promise<InteractionItem[]> {
  if (!leadId) throw new Error('Missing leadId');

  if (isDemoMode()) {
    return getDemoInteractions(leadId) as unknown as InteractionItem[];
  }

  let query = supabase
    .from('interactions')
    .select('id, lead_id, type, source, occurred_at, subject, from_email, to_email, to_emails, cc_emails, body_text, ai_summary, ai_intent, ai_reply_worthy, gmail_message_id, gmail_thread_id, hidden')
    .eq('lead_id', leadId)
    .order('occurred_at', { ascending: false })
    .limit(100);

  if (!includeHidden) {
    query = query.eq('hidden', false);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// ============================================
// UNIFIED TIMELINE QUERIES (lead_timeline_items)
// ============================================

export interface TimelineItem {
  id: string;
  lead_id: string;
  channel: string;
  provider: string | null;
  direction: string | null;
  event_type: string;
  occurred_at: string;
  source_table: string;
  source_id: string;
  snippet_text: string | null;
  subject: string | null;
  status_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
  dedupe_key: string;
  contact_id: string | null;
  conversation_id: string | null;
  hidden: boolean;
  // PR 2.4 — only populated by getGroupTimelineItems. Null/undefined for the
  // single-lead path. lead_ids is the set of leads this row was projected to
  // (for emails CC'd to multiple stakeholders, the row dedupes on
  // gmail_message_id but lead_ids carries every lead it touched).
  lead_ids?: string[];
  lead_name?: string | null;
  // PR 2.4 — per-row follow-up state for outbound rows (LEFT JOIN of
  // timeline_followup_state). Both null when the row has never been
  // snoozed/dismissed.
  followup_snoozed_until?: string | null;
  followup_dismissed_at?: string | null;
}

export async function getLeadTimeline(
  leadId: string,
  options?: { includeHidden?: boolean; channel?: string; limit?: number }
): Promise<TimelineItem[]> {
  if (!leadId) throw new Error('Missing leadId');

  if (isDemoMode()) {
    const demoInteractions = getDemoInteractions(leadId) as unknown as InteractionItem[];
    return demoInteractions.map(i => ({
      id: i.id,
      lead_id: i.lead_id,
      channel: i.type.includes('email') ? 'email' : i.type.includes('whatsapp') ? 'whatsapp' : 'system',
      provider: i.source || null,
      direction: i.type.includes('inbound') ? 'inbound' : i.type.includes('outbound') ? 'outbound' : null,
      event_type: i.type,
      occurred_at: i.occurred_at,
      source_table: 'interactions',
      source_id: i.id,
      snippet_text: i.body_text,
      subject: i.subject || null,
      status_json: { ai_reply_worthy: i.ai_reply_worthy, ai_intent: i.ai_intent },
      metadata_json: { gmail_message_id: i.gmail_message_id, from_email: i.from_email, to_email: i.to_email, ai_summary: i.ai_summary },
      dedupe_key: i.id,
      contact_id: null,
      conversation_id: null,
      hidden: i.hidden ?? false,
    }));
  }

  let query = supabase
    .from('lead_timeline_items')
    .select('id, lead_id, channel, provider, direction, event_type, occurred_at, source_table, source_id, snippet_text, subject, status_json, metadata_json, dedupe_key, contact_id, conversation_id, hidden')
    .eq('lead_id', leadId)
    .order('occurred_at', { ascending: false })
    .limit(options?.limit ?? 200);

  if (!options?.includeHidden) {
    query = query.eq('hidden', false);
  }

  if (options?.channel) {
    query = query.eq('channel', options.channel);
  }

  const { data, error } = await query;
  if (error) throw error;
  const timeline = (data ?? []) as TimelineItem[];

  // Legacy fallback: merge orphaned `interactions` rows that were never
  // projected into `lead_timeline_items` (e.g. older Gmail sync writes,
  // recently-approved candidate leads where the bridge hasn't run yet).
  // Mirrors the dedupe + channel-filter strategy in `leadActivity.ts`.
  try {
    const legacy = await getLeadInteractions(leadId, options?.includeHidden ?? false);
    if (legacy.length === 0) return hydrateFollowupState(timeline);

    const seen = new Set<string>();
    for (const t of timeline) {
      if (t.source_id) seen.add(`sid:${t.source_id}`);
      const gmId = (t.metadata_json as { gmail_message_id?: string } | null)?.gmail_message_id;
      if (gmId) seen.add(`gmail:${gmId}`);
      if (t.dedupe_key) seen.add(`dk:${t.dedupe_key}`);
    }

    const fallbackItems: TimelineItem[] = [];
    for (const i of legacy) {
      const keys: string[] = [`sid:${i.id}`];
      if (i.gmail_message_id) keys.push(`gmail:${i.gmail_message_id}`);
      if (keys.some(k => seen.has(k))) continue;

      const channel = i.type?.includes('email')
        ? 'email'
        : i.type?.includes('whatsapp')
        ? 'whatsapp'
        : i.type?.includes('sms')
        ? 'sms'
        : i.type?.includes('call') || i.type?.includes('voice')
        ? 'voice'
        : 'system';

      if (options?.channel && channel !== options.channel) continue;

      const direction = i.type?.includes('inbound')
        ? 'inbound'
        : i.type?.includes('outbound')
        ? 'outbound'
        : null;

      fallbackItems.push({
        id: i.id,
        lead_id: i.lead_id,
        channel,
        provider: i.source ?? null,
        direction,
        event_type: i.type,
        occurred_at: i.occurred_at,
        source_table: 'interactions',
        source_id: i.id,
        snippet_text: i.body_text ?? null,
        subject: i.subject ?? null,
        status_json: { ai_reply_worthy: i.ai_reply_worthy, ai_intent: i.ai_intent },
        metadata_json: {
          gmail_message_id: i.gmail_message_id,
          gmail_thread_id: (i as { gmail_thread_id?: string | null }).gmail_thread_id ?? null,
          from_email: i.from_email,
          to_email: i.to_email,
          to_emails: Array.isArray((i as { to_emails?: string[] }).to_emails) ? (i as { to_emails?: string[] }).to_emails : [],
          cc_emails: Array.isArray((i as { cc_emails?: string[] }).cc_emails) ? (i as { cc_emails?: string[] }).cc_emails : [],
          ai_summary: i.ai_summary,
        },
        dedupe_key: i.gmail_message_id ?? i.id,
        contact_id: null,
        conversation_id: null,
        hidden: i.hidden ?? false,
      });

      for (const k of keys) seen.add(k);
    }

    if (fallbackItems.length === 0) return hydrateFollowupState(timeline);

    const merged = [...timeline, ...fallbackItems].sort(
      (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
    );
    return hydrateFollowupState(merged.slice(0, options?.limit ?? 200));
  } catch (err) {
    console.warn('[getLeadTimeline] legacy interactions fallback failed', err);
    return hydrateFollowupState(timeline);
  }
}

// ============================================
// PR 2.4 — Per-row follow-up state helpers
// ============================================

/** Hydrate timeline rows with follow-up snooze/dismiss state. Outbound email
 *  rows are the only ones that surface this in the UI today, but we hydrate
 *  uniformly to avoid branching the reader path. Demo mode skips the fetch. */
async function hydrateFollowupState(rows: TimelineItem[]): Promise<TimelineItem[]> {
  if (rows.length === 0 || isDemoMode()) return rows;
  const ids = rows.map(r => r.id).filter(Boolean);
  if (ids.length === 0) return rows;

  try {
    const { data, error } = await supabase
      .from('timeline_followup_state')
      .select('timeline_item_id, snoozed_until, dismissed_at')
      .in('timeline_item_id', ids);
    if (error) throw error;
    const byId = new Map<string, { snoozed_until: string | null; dismissed_at: string | null }>();
    for (const r of (data ?? []) as Array<{ timeline_item_id: string; snoozed_until: string | null; dismissed_at: string | null }>) {
      byId.set(r.timeline_item_id, { snoozed_until: r.snoozed_until, dismissed_at: r.dismissed_at });
    }
    return rows.map(r => {
      const s = byId.get(r.id);
      return s
        ? { ...r, followup_snoozed_until: s.snoozed_until, followup_dismissed_at: s.dismissed_at }
        : r;
    });
  } catch (err) {
    console.warn('[hydrateFollowupState] Failed to load follow-up state, continuing without:', err);
    return rows;
  }
}

/** Set or clear snooze/dismiss state on a timeline row.
 *  Pass `clearDismissed: true` to undo a Dismiss; the 5-second toast undo uses this.
 *
 *  Bug-fix v2: cold-tab first-clicks were occasionally hitting RLS denial
 *  ("Not authenticated") because the auth header hadn't fully attached to
 *  the supabase-js client yet. We now (a) force a session read up front
 *  to warm the JWT, and (b) retry once on transient errors only. */
export async function setTimelineFollowupState(
  timelineItemId: string,
  opts: {
    snoozedUntil?: string | null;
    dismissedAt?: string | null;
    clearSnoozed?: boolean;
    clearDismissed?: boolean;
  },
): Promise<void> {
  // (a) Auth warmup — ensures the JWT is loaded before the RPC fires.
  await supabase.auth.getSession();

  const args = {
    p_timeline_item_id: timelineItemId,
    p_snoozed_until: opts.snoozedUntil ?? null,
    p_dismissed_at: opts.dismissedAt ?? null,
    p_clear_snoozed: opts.clearSnoozed ?? false,
    p_clear_dismissed: opts.clearDismissed ?? false,
  };

  // 42501 = insufficient_privilege (RLS denial). "Not authenticated" can
  // come back as either an error.message or a thrown TypeError on network
  // failures (fetch/CORS). Anything else is a genuine error and bubbles up.
  const isTransient = (e: unknown): boolean => {
    if (!e) return false;
    const err = e as { code?: string; message?: string; name?: string };
    if (err.code === '42501') return true;
    if (typeof err.message === 'string' && /Not authenticated|Failed to fetch|NetworkError|fetch/i.test(err.message)) return true;
    if (err.name === 'TypeError') return true;
    return false;
  };

  let firstResult: { error: unknown } | null = null;
  try {
    firstResult = await supabase.rpc('set_timeline_followup_state', args);
  } catch (thrown) {
    if (!isTransient(thrown)) throw thrown;
    console.warn('[setTimelineFollowupState] transient throw — retrying after 400ms', thrown);
    firstResult = { error: thrown };
  }
  if (!firstResult.error) return;
  if (!isTransient(firstResult.error)) throw firstResult.error;
  console.warn('[setTimelineFollowupState] transient error — retrying after 400ms', firstResult.error);

  // (b) Retry once. Anything that fails the second time is a real failure.
  await new Promise(r => setTimeout(r, 400));
  const { error: retryError } = await supabase.rpc('set_timeline_followup_state', args);
  if (retryError) throw retryError;
}

// ============================================
// PR 2.4 — Group-aware timeline reader
// ============================================

/** Fetch the union timeline for every lead in a stakeholder group.
 *
 *  Dedupes by `gmail_message_id` / `provider_message_id` / `dedupe_key` so
 *  a multi-recipient email projected into multiple leads' timelines shows
 *  once, with `lead_ids` carrying every lead it touched. The primary
 *  `lead_id` resolves to the row whose lead_name renders in the chip.
 *
 *  Legacy `interactions` rows that were never bridged into
 *  `lead_timeline_items` are merged in per-lead, mirroring the dedupe
 *  strategy in `getLeadTimeline`.
 */
export async function getGroupTimelineItems(
  groupId: string,
  options?: { includeHidden?: boolean; channel?: string; limit?: number },
): Promise<TimelineItem[]> {
  if (!groupId) throw new Error('Missing groupId');
  if (isDemoMode()) return [];

  const limit = options?.limit ?? 200;
  const fetchWindow = Math.max(limit * 2, 60);

  // 1) Resolve member leads (id + name) for chip annotation.
  const { data: members, error: memErr } = await supabase
    .from('leads')
    .select('id, name')
    .eq('group_id', groupId);
  if (memErr) throw memErr;
  const memberIds = (members ?? []).map(m => m.id);
  if (memberIds.length === 0) return [];
  const nameById = new Map<string, string | null>();
  for (const m of members ?? []) nameById.set(m.id, m.name as string | null);

  // 2) Fetch canonical timeline rows across all member leads.
  let query = supabase
    .from('lead_timeline_items')
    .select('id, lead_id, channel, provider, direction, event_type, occurred_at, source_table, source_id, snippet_text, subject, status_json, metadata_json, dedupe_key, contact_id, conversation_id, hidden')
    .in('lead_id', memberIds)
    .order('occurred_at', { ascending: false })
    .limit(fetchWindow);
  if (!options?.includeHidden) query = query.eq('hidden', false);
  if (options?.channel) query = query.eq('channel', options.channel);

  const { data: timelineRows, error: tErr } = await query;
  if (tErr) throw tErr;
  const rawTimeline = (timelineRows ?? []) as TimelineItem[];

  // 3) Legacy interactions fallback — pull rows the projector never touched.
  let fallbackEmails: TimelineItem[] = [];
  try {
    let lq = supabase
      .from('interactions')
      .select('id, lead_id, type, source, from_email, to_email, to_emails, cc_emails, subject, body_text, occurred_at, direction, gmail_thread_id, gmail_message_id, hidden, ai_summary, ai_intent, ai_reply_worthy')
      .in('lead_id', memberIds)
      .order('occurred_at', { ascending: false })
      .limit(fetchWindow);
    if (!options?.includeHidden) lq = lq.eq('hidden', false);
    const { data: legacyRows, error: lErr } = await lq;
    if (lErr) throw lErr;

    // Build dedupe key set from the canonical timeline so we only merge orphans.
    const seen = new Set<string>();
    for (const t of rawTimeline) {
      if (t.source_id) seen.add(`sid:${t.source_id}`);
      const gid = (t.metadata_json as { gmail_message_id?: string } | null)?.gmail_message_id;
      if (gid) seen.add(`gmail:${gid}`);
    }

    for (const i of (legacyRows as any[]) ?? []) {
      const keys: string[] = [`sid:${i.id}`];
      if (i.gmail_message_id) keys.push(`gmail:${i.gmail_message_id}`);
      if (keys.some(k => seen.has(k))) continue;
      const channel = i.type?.includes('email') ? 'email'
        : i.type?.includes('whatsapp') ? 'whatsapp'
        : i.type?.includes('sms') ? 'sms'
        : i.type?.includes('call') || i.type?.includes('voice') ? 'voice'
        : 'system';
      if (options?.channel && channel !== options.channel) continue;
      const direction = i.type?.includes('inbound') ? 'inbound'
        : i.type?.includes('outbound') ? 'outbound'
        : null;
      fallbackEmails.push({
        id: i.id,
        lead_id: i.lead_id,
        channel,
        provider: i.source ?? null,
        direction,
        event_type: i.type,
        occurred_at: i.occurred_at,
        source_table: 'interactions',
        source_id: i.id,
        snippet_text: i.body_text ?? null,
        subject: i.subject ?? null,
        status_json: { ai_reply_worthy: i.ai_reply_worthy, ai_intent: i.ai_intent },
        metadata_json: {
          gmail_message_id: i.gmail_message_id,
          gmail_thread_id: i.gmail_thread_id,
          from_email: i.from_email,
          to_email: i.to_email,
          to_emails: Array.isArray(i.to_emails) ? i.to_emails : [],
          cc_emails: Array.isArray(i.cc_emails) ? i.cc_emails : [],
          ai_summary: i.ai_summary,
        },
        dedupe_key: i.gmail_message_id ?? i.id,
        contact_id: null,
        conversation_id: null,
        hidden: i.hidden ?? false,
      });
      for (const k of keys) seen.add(k);
    }
  } catch (err) {
    console.warn('[getGroupTimelineItems] legacy interactions fallback failed', err);
  }

  // 4) Cross-lead dedupe — same email projected into multiple leads' timelines
  //    (e.g. an inbound from Liza CC'd to Stuart). Collapse on the strongest
  //    available identity: gmail_message_id > provider_message_id > dedupe_key.
  const merged = [...rawTimeline, ...fallbackEmails];
  const dedupeMap = new Map<string, TimelineItem>();
  for (const row of merged) {
    const meta = (row.metadata_json as Record<string, unknown> | null) ?? {};
    const dedupeKey =
      (meta.gmail_message_id as string | undefined)
      || (meta.provider_message_id as string | undefined)
      || row.dedupe_key
      || row.id;
    const existing = dedupeMap.get(dedupeKey);
    if (existing) {
      const ids = new Set([...(existing.lead_ids ?? [existing.lead_id]), row.lead_id]);
      existing.lead_ids = Array.from(ids);
    } else {
      dedupeMap.set(dedupeKey, { ...row, lead_ids: [row.lead_id] });
    }
  }

  // 5) Sort + slice + annotate lead_name (primary lead_id wins).
  const out = Array.from(dedupeMap.values())
    .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
    .slice(0, limit)
    .map(r => ({ ...r, lead_name: nameById.get(r.lead_id) ?? null }));

  // 6) Hydrate per-row follow-up state.
  return hydrateFollowupState(out);
}

export async function hideTimelineItem(itemId: string): Promise<void> {
  if (isDemoMode()) return;
  const { data: item } = await supabase
    .from('lead_timeline_items')
    .select('source_table, source_id')
    .eq('id', itemId)
    .single();

  if (item) {
    await supabase.from('lead_timeline_items').update({ hidden: true }).eq('id', itemId);
    if (item.source_table === 'interactions' && item.source_id) {
      await syncInteractionHidden(item.source_id, true);
    }
  }
}

export async function unhideTimelineItem(itemId: string): Promise<void> {
  if (isDemoMode()) return;
  const { data: item } = await supabase
    .from('lead_timeline_items')
    .select('source_table, source_id')
    .eq('id', itemId)
    .single();

  if (item) {
    await supabase.from('lead_timeline_items').update({ hidden: false }).eq('id', itemId);
    if (item.source_table === 'interactions' && item.source_id) {
      await syncInteractionHidden(item.source_id, false);
    }
  }
}

/**
 * Sync the hidden flag to the interactions table.
 * Handles both new rows (source_id = interaction UUID) and
 * historical rows (source_id = provider message ID like gmail msg id).
 *
 * Strategy: try UUID match first; if no rows updated, try gmail_message_id fallback.
 */
async function syncInteractionHidden(sourceId: string, hidden: boolean): Promise<void> {
  try {
    // Try direct UUID match (new canonical rows)
    const { data: updated } = await supabase
      .from('interactions')
      .update({ hidden })
      .eq('id', sourceId)
      .select('id');

    if (updated && updated.length > 0) return;

    // Fallback: historical rows may have provider message ID as source_id
    // Try matching by gmail_message_id (covers Gmail historical data)
    await supabase
      .from('interactions')
      .update({ hidden })
      .eq('gmail_message_id', sourceId);
  } catch {
    // Non-blocking — timeline item is already updated
  }
}

export async function hideInteraction(interactionId: string): Promise<void> {
  if (isDemoMode()) return;
  const { error } = await supabase
    .from('interactions')
    .update({ hidden: true })
    .eq('id', interactionId);
  if (error) throw error;
}

export async function unhideInteraction(interactionId: string): Promise<void> {
  const { error } = await supabase
    .from('interactions')
    .update({ hidden: false })
    .eq('id', interactionId);
  if (error) throw error;
}

export interface InsertInteractionInput {
  lead_id?: string;
  type: string;
  source?: string;
  occurred_at?: string;
  subject?: string;
  from_email?: string;
  to_email?: string;
  body_text: string;
  /** Optional override; auto-derived from `type` when omitted (inbound/outbound/null). */
  direction?: 'inbound' | 'outbound' | null;
  /** Optional channel override; auto-derived from `type` when omitted. */
  channel?: string;
  /** When false, skip the canonical `lead_timeline_items` projection (rare; default true). */
  projectToTimeline?: boolean;
}

// ------------------------------------------------------------
// Channel/direction inference + timeline projection now live in
// `src/lib/timelineProjection.ts` (single source of truth shared
// with the drift-audit/repair path). Local re-exports keep prior
// callers compiling without churn.
// ------------------------------------------------------------
import {
  inferChannelFromInteractionType as inferChannelFromType,
  inferDirectionFromInteractionType as inferDirectionFromType,
  buildTimelineProjectionFromInteraction,
} from './timelineProjection';

/**
 * Canonical lead-activity write helper — TIMELINE-FIRST.
 *
 * Write ordering (canonical-first):
 *   1. Mint a stable interaction id client-side (crypto.randomUUID).
 *      Safe because `interactions.id` defaults to `gen_random_uuid()` and
 *      `lead_timeline_items.source_id` is `text` with no FK to interactions.
 *   2. Upsert into `lead_timeline_items` — the canonical ledger. This is
 *      the PRIMARY write. If it fails, the whole call fails.
 *   3. Insert into legacy `interactions` using the same explicit id, so
 *      `dedupe_key = 'interaction:<id>'` keeps pointing to a real row.
 *      This is now a MIRROR — failures are logged but non-fatal so legacy
 *      readers degrade gracefully while the canonical record exists.
 *
 * Why this matters: canonical write success no longer depends on the legacy
 * table. Drift audit/repair semantics are unchanged (same dedupe_key shape,
 * same source_id, same `(lead_id, dedupe_key)` upsert key).
 *
 * Caller contract is preserved: returns `{ id, lead_id }` exactly as before.
 *
 * Edge cases:
 *   - `projectToTimeline: false` falls back to legacy-only writes (kept for
 *     rare callers that want to bypass the canonical path; currently unused).
 *   - Missing `workspace_id` (orphan lead) falls back to legacy-only with
 *     a warning — we never silently drop the write.
 */
export async function insertInteraction(leadId: string, form: InsertInteractionInput): Promise<{ id: string; lead_id: string }> {
  if (isDemoMode()) return { id: 'demo-blocked', lead_id: leadId };
  if (!leadId) throw new Error('Missing leadId');

  const occurredAt = form.occurred_at || new Date().toISOString();
  const direction = form.direction ?? inferDirectionFromType(form.type);
  const bodyText = form.body_text?.trim() || '';
  if (!bodyText) throw new Error('Missing body_text');

  // Stable identity minted up front — shared by both writes.
  const interactionId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : // Fallback for ancient environments: defer to DB default by
        // letting legacy insert generate; in that branch we cannot
        // pre-write the timeline, so we degrade to legacy-first.
        '';

  const legacyPayload = {
    ...(interactionId ? { id: interactionId } : {}),
    lead_id: leadId,
    type: form.type,
    source: form.source || 'manual',
    occurred_at: occurredAt,
    subject: form.subject || null,
    from_email: form.from_email || null,
    to_email: form.to_email || null,
    body_text: bodyText,
    direction,
  };

  // ---- Resolve workspace_id (needed for the canonical write) ----------
  let workspaceId: string | null = null;
  if (form.projectToTimeline !== false && interactionId) {
    const { data: leadRow } = await supabase
      .from('leads')
      .select('workspace_id')
      .eq('id', leadId)
      .single();
    workspaceId = leadRow?.workspace_id ?? null;
  }

  // ---- Step 1: CANONICAL write (lead_timeline_items) ------------------
  // Throws on failure — this is the new source of truth.
  if (workspaceId) {
    const { payload: tlPayload } = buildTimelineProjectionFromInteraction(
      {
        id: interactionId,
        lead_id: leadId,
        type: form.type,
        source: legacyPayload.source,
        occurred_at: occurredAt,
        subject: legacyPayload.subject,
        body_text: bodyText,
        direction,
      },
      workspaceId,
      { channel: form.channel },
    );
    const { error: tlErr } = await supabase
      .from('lead_timeline_items')
      .upsert(tlPayload, { onConflict: 'lead_id,dedupe_key' });
    if (tlErr) {
      console.error('[insertInteraction] CANONICAL timeline write failed', tlErr);
      throw tlErr;
    }
  } else if (form.projectToTimeline !== false) {
    // No workspace resolvable — fall back to legacy-only with a loud warning.
    console.warn(
      '[insertInteraction] missing workspace_id for lead — falling back to legacy-only write',
      { leadId },
    );
  }

  // ---- Step 2: LEGACY MIRROR write (interactions) ---------------------
  // Non-fatal when the canonical write succeeded above. Using the same
  // explicit id keeps `dedupe_key='interaction:<id>'` pointing at a real
  // row and keeps the drift audit happy.
  const { data: legacyRow, error: legacyErr } = await supabase
    .from('interactions')
    .insert(legacyPayload)
    .select('id, lead_id')
    .single();

  if (legacyErr) {
    if (workspaceId) {
      // Canonical record exists; mirror failed. Log but don't break the UI.
      console.warn(
        '[insertInteraction] legacy mirror write failed (canonical timeline row exists)',
        { interactionId, leadId, error: legacyErr },
      );
    } else {
      // No canonical write happened either — this is a hard failure.
      throw legacyErr;
    }
  }

  // Update lead's last_activity_at (best-effort).
  await supabase
    .from('leads')
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', leadId);

  // Preserve caller contract. Prefer the legacy id when present (covers the
  // no-crypto fallback); otherwise return the id we minted.
  return legacyRow ?? { id: interactionId, lead_id: leadId };
}

/**
 * Canonical writer for non-communication audit events (motion overrides,
 * sequence overrides, manual notes). Projects to `lead_timeline_items` as
 * `channel='system'` and mirrors into legacy `interactions` for back-compat.
 */
export async function insertSystemNote(
  leadId: string,
  body: string,
  source: string = 'system'
): Promise<{ id: string } | null> {
  if (isDemoMode()) return null;
  if (!leadId || !body?.trim()) return null;
  return insertInteraction(leadId, {
    type: 'system_note',
    source,
    body_text: body.trim(),
    direction: null,
    channel: 'system',
  });
}

// ------------------------------------------------------------
// AI annotation patch (intent / summary / reply_worthy)
// ------------------------------------------------------------
//
// Canonical-first: writes the AI annotation onto the projected
// `lead_timeline_items` row using exact identity
// (`lead_id` + `dedupe_key='interaction:<id>'`). This is the row
// `insertInteraction` just upserted, so no fuzzy "latest by
// occurred_at" lookup is needed.
//
// Mirrors to legacy `interactions.ai_*` columns as a non-fatal
// back-compat write — `getLeadTimeline` and `mapInteractionToActivity`
// still read those for any rows that haven't been bridged yet, and
// we don't want to break legacy readers mid-migration.
//
// Reader alignment (already in place — no UI changes needed):
//   • TimelineTab reads `metadata_json.ai_intent`,
//     `metadata_json.ai_summary`, `status_json.ai_reply_worthy`.
//   • `getLeadTimeline` projects legacy `ai_*` into the same
//     status_json/metadata_json shape for un-bridged rows.
//
// TODO(cleanup): once legacy `interactions.ai_*` has no remaining
// readers (audit + admin panels confirm), drop the mirror branch.
export interface AIAnnotationInput {
  intent?: string | null;
  summary?: string | null;
  reply_worthy?: boolean | null;
}

export async function annotateInteractionAI(
  leadId: string,
  interactionId: string,
  annotation: AIAnnotationInput,
): Promise<void> {
  if (isDemoMode()) return;
  if (!leadId || !interactionId) return;

  const { intent = null, summary = null, reply_worthy = null } = annotation;

  // ---- PRIMARY: canonical timeline row patch (exact identity) ----------
  // Read existing metadata_json/status_json so we merge instead of clobber.
  const dedupeKey = `interaction:${interactionId}`;
  const { data: tlRow, error: tlReadErr } = await supabase
    .from('lead_timeline_items')
    .select('id, metadata_json, status_json')
    .eq('lead_id', leadId)
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();

  if (tlReadErr) {
    console.warn('[annotateInteractionAI] timeline read failed', tlReadErr);
  }

  if (tlRow?.id) {
    const prevMeta = (tlRow.metadata_json as Record<string, unknown> | null) ?? {};
    const prevStatus = (tlRow.status_json as Record<string, unknown> | null) ?? {};
    const nextMeta = { ...prevMeta, ai_intent: intent, ai_summary: summary };
    const nextStatus = { ...prevStatus, ai_reply_worthy: reply_worthy, ai_intent: intent };

    const { error: tlUpdErr } = await supabase
      .from('lead_timeline_items')
      .update({ metadata_json: nextMeta, status_json: nextStatus })
      .eq('id', tlRow.id);

    if (tlUpdErr) {
      console.error('[annotateInteractionAI] CANONICAL timeline annotation failed', tlUpdErr);
      // Don't throw — caller flow (UploadTab) shouldn't break on annotation.
      // Surfaced via console for dev visibility; a later cleanup can decide
      // whether to escalate.
    }
  } else if (import.meta.env.DEV) {
    console.warn(
      '[annotateInteractionAI] no canonical timeline row found for interaction',
      { leadId, interactionId, dedupeKey },
    );
  }

  // ---- MIRROR: legacy interactions.ai_* (back-compat, non-fatal) -------
  const { error: legacyErr } = await supabase
    .from('interactions')
    .update({
      ai_intent: intent,
      ai_summary: summary,
      ai_reply_worthy: reply_worthy,
    })
    .eq('id', interactionId);

  if (legacyErr) {
    console.warn(
      '[annotateInteractionAI] legacy mirror annotation failed (canonical write may have succeeded)',
      { interactionId, error: legacyErr },
    );
  }
}

// ============================================
// DRAFTS QUERIES
// ============================================

export interface SaveDraftInput {
  lead_id?: string;
  channel: 'email' | 'linkedin' | 'whatsapp' | 'sms';
  draft_type: string;
  to_recipient?: string;
  subject?: string;
  body_text: string;
  step_key?: string;
  nurture_theme?: string;
  nurture_cadence?: string;
  status?: 'pending' | 'approved' | 'saved' | 'sent' | 'skipped' | 'discarded';
}

export async function saveDraft(leadId: string, form: SaveDraftInput): Promise<{ id: string }> {
  if (isDemoMode()) return { id: 'demo-blocked' };
  const { data: { user } } = await supabase.auth.getUser();

  const payload = {
    lead_id: leadId,
    channel: form.channel,
    draft_type: form.draft_type,
    to_recipient: form.to_recipient || null,
    subject: form.subject || null,
    body_text: form.body_text,
    created_by: user?.id || null,
    step_key: form.step_key || null,
    nurture_theme: form.nurture_theme || null,
    nurture_cadence: form.nurture_cadence || null,
    status: form.status || 'pending',
  };

  if (!payload.lead_id || !payload.channel || !payload.draft_type || !payload.body_text) {
    throw new Error('Missing required draft fields');
  }

  const { data, error } = await supabase
    .from('drafts')
    .insert(payload as Database['public']['Tables']['drafts']['Insert'])
    .select('id')
    .single();

  if (error) throw error;
  return data;
}

export async function saveNurtureSequenceDrafts(
  leadId: string, 
  emails: { email_number: number; subject: string; body: string }[],
  theme: string,
  cadence: string
): Promise<{ id: string }[]> {
  const { data: { user } } = await supabase.auth.getUser();

  const payloads = emails.map((email) => ({
    lead_id: leadId,
    channel: 'email',
    draft_type: 'nurture',
    step_key: `nurture_${email.email_number}`,
    subject: email.subject,
    body_text: email.body,
    created_by: user?.id || null,
    nurture_theme: theme,
    nurture_cadence: cadence,
    status: 'saved',
  }));

  const { data, error } = await supabase
    .from('drafts')
    .insert(payloads as Database['public']['Tables']['drafts']['Insert'][])
    .select('id');

  if (error) throw error;
  return data ?? [];
}

export async function updateDraftStatus(draftId: string, status: 'pending' | 'saved' | 'sent' | 'skipped'): Promise<void> {
  const { error } = await supabase
    .from('drafts')
    .update({ status })
    .eq('id', draftId);

  if (error) throw error;
}

export async function getLeadDrafts(leadId: string): Promise<Draft[]> {
  if (!leadId) throw new Error('Missing leadId');

  if (isDemoMode()) {
    return getDemoDrafts(leadId) as unknown as Draft[];
  }

  const { data, error } = await supabase
    .from('drafts')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

// ============================================
// KNOWLEDGE BASE QUERIES
// ============================================

export async function getKnowledgeChunks(customerFacingOnly = true): Promise<{ id: string; content: string; title: string | null }[]> {
  let query = supabase
    .from('kb_chunks')
    .select('id, content, title');

  if (customerFacingOnly) {
    query = query.eq('allowed_customer_facing', true);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function searchKnowledgeBase(searchTerm: string, customerFacingOnly = true): Promise<{ id: string; content: string; title: string | null }[]> {
  let query = supabase
    .from('kb_chunks')
    .select('id, content, title')
    .ilike('content', `%${searchTerm}%`);

  if (customerFacingOnly) {
    query = query.eq('allowed_customer_facing', true);
  }

  const { data, error } = await query.limit(10);
  if (error) throw error;
  return data ?? [];
}

// ============================================
// LEAD MILESTONES HELPER
// ============================================

export interface MilestoneItem {
  description: string;
  status: 'completed' | 'pending';
  date: string | null;
  evidence?: string;
  completedAt?: string;
}

export async function appendLeadMilestones(leadId: string, newMilestones: MilestoneItem[]): Promise<void> {
  if (!leadId) throw new Error('Missing leadId');
  if (!newMilestones.length) return;

  // Fetch current milestones
  const { data: lead, error: fetchErr } = await supabase
    .from('leads')
    .select('milestones_json')
    .eq('id', leadId)
    .single();

  if (fetchErr) throw fetchErr;

  const existing = (lead?.milestones_json as unknown as MilestoneItem[] | null) ?? [];
  
  // Merge avoiding duplicates by description
  const existingDescriptions = new Set(existing.map(m => m.description.toLowerCase().trim()));
  const toAdd = newMilestones.filter(m => !existingDescriptions.has(m.description.toLowerCase().trim()));
  
  const merged = [...existing, ...toAdd];

  const { error: updateErr } = await supabase
    .from('leads')
    .update({ 
      milestones_json: merged as unknown as Database['public']['Tables']['leads']['Update']['milestones_json'],
      last_activity_at: new Date().toISOString()
    })
    .eq('id', leadId);

  if (updateErr) throw updateErr;
}

// ============================================
// GMAIL QUERIES
// ============================================

export interface GmailConnectionRow {
  id: string;
  user_id: string;
  gmail_email: string;
  token_expires_at: string;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function getGmailConnection(): Promise<GmailConnectionRow | null> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const { data, error } = await supabase
    .from('gmail_connections')
    .select('id, user_id, gmail_email, token_expires_at, last_sync_at, created_at, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// ============================================
// MEETING PACKS QUERIES
// ============================================

export interface MeetingPackItem {
  id: string;
  lead_id: string;
  owner_user_id: string;
  created_at: string;
  meeting_date: string | null;
  title: string | null;
  raw_notes: string | null;
  internal_recap_bullets: string[];
  open_questions: string[];
  milestones: MilestoneItem[];
  follow_up_email_subject: string | null;
  follow_up_email_body: string | null;
  milestones_saved_to_lead: boolean;
  email_saved_as_draft: boolean;
  source_meeting_summary_id: string | null;
}

export async function getLeadMeetingPacks(leadId: string): Promise<MeetingPackItem[]> {
  if (!leadId) throw new Error('Missing leadId');

  const { data, error } = await supabase
    .from('meeting_packs')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  
  return (data ?? []).map(row => ({
    id: row.id,
    lead_id: row.lead_id,
    owner_user_id: row.owner_user_id,
    created_at: row.created_at,
    meeting_date: row.meeting_date,
    title: row.title,
    raw_notes: row.raw_notes,
    internal_recap_bullets: (row.internal_recap_bullets as unknown as string[]) || [],
    open_questions: (row.open_questions as unknown as string[]) || [],
    milestones: (row.milestones as unknown as MilestoneItem[]) || [],
    follow_up_email_subject: row.follow_up_email_subject,
    follow_up_email_body: row.follow_up_email_body,
    milestones_saved_to_lead: row.milestones_saved_to_lead,
    email_saved_as_draft: row.email_saved_as_draft,
    source_meeting_summary_id: (row as Record<string, unknown>).source_meeting_summary_id as string | null,
  }));
}

export interface CreateMeetingPackInput {
  lead_id: string;
  meeting_date?: string;
  title?: string;
  raw_notes?: string;
  internal_recap_bullets?: string[];
  open_questions?: string[];
  milestones?: MilestoneItem[];
  follow_up_email_subject?: string;
  follow_up_email_body?: string;
  source_meeting_summary_id?: string;
}

export async function createMeetingPack(input: CreateMeetingPackInput): Promise<{ id: string }> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const insertData: Record<string, unknown> = {
    lead_id: input.lead_id,
    owner_user_id: user.id,
    meeting_date: input.meeting_date || new Date().toISOString().split('T')[0],
    title: input.title || null,
    raw_notes: input.raw_notes || null,
    internal_recap_bullets: input.internal_recap_bullets || [],
    open_questions: input.open_questions || [],
    milestones: input.milestones || [],
    follow_up_email_subject: input.follow_up_email_subject || null,
    follow_up_email_body: input.follow_up_email_body || null,
  };
  
  if (input.source_meeting_summary_id) {
    insertData.source_meeting_summary_id = input.source_meeting_summary_id;
  }

  const { data, error } = await supabase
    .from('meeting_packs')
    .insert(insertData as Database['public']['Tables']['meeting_packs']['Insert'])
    .select('id')
    .single();

  if (error) throw error;
  return data;
}

export interface UpdateMeetingPackInput {
  meeting_date?: string;
  title?: string;
  raw_notes?: string;
  internal_recap_bullets?: string[];
  open_questions?: string[];
  milestones?: MilestoneItem[];
  follow_up_email_subject?: string;
  follow_up_email_body?: string;
  milestones_saved_to_lead?: boolean;
  email_saved_as_draft?: boolean;
}

export async function updateMeetingPack(id: string, input: UpdateMeetingPackInput): Promise<void> {
  if (!id) throw new Error('Missing meeting pack id');

  const updateData: Record<string, unknown> = {};
  
  if (input.meeting_date !== undefined) updateData.meeting_date = input.meeting_date;
  if (input.title !== undefined) updateData.title = input.title;
  if (input.raw_notes !== undefined) updateData.raw_notes = input.raw_notes;
  if (input.internal_recap_bullets !== undefined) updateData.internal_recap_bullets = input.internal_recap_bullets;
  if (input.open_questions !== undefined) updateData.open_questions = input.open_questions;
  if (input.milestones !== undefined) updateData.milestones = input.milestones;
  if (input.follow_up_email_subject !== undefined) updateData.follow_up_email_subject = input.follow_up_email_subject;
  if (input.follow_up_email_body !== undefined) updateData.follow_up_email_body = input.follow_up_email_body;
  if (input.milestones_saved_to_lead !== undefined) updateData.milestones_saved_to_lead = input.milestones_saved_to_lead;
  if (input.email_saved_as_draft !== undefined) updateData.email_saved_as_draft = input.email_saved_as_draft;

  const { error } = await supabase
    .from('meeting_packs')
    .update(updateData)
    .eq('id', id);

  if (error) throw error;
}

export async function deleteMeetingPack(id: string): Promise<void> {
  if (!id) throw new Error('Missing meeting pack id');

  const { error } = await supabase
    .from('meeting_packs')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

// ============================================
// MILESTONE STATUS UPDATES
// ============================================

export async function updateLeadMilestoneStatus(
  leadId: string, 
  milestoneIndex: number, 
  completed: boolean
): Promise<void> {
  if (!leadId) throw new Error('Missing leadId');

  const now = new Date().toISOString();

  // Update canonical lead_intelligence milestones (primary source)
  const { data: intel, error: intelFetchErr } = await supabase
    .from('lead_intelligence')
    .select('milestones_json')
    .eq('lead_id', leadId)
    .maybeSingle();

  if (!intelFetchErr && intel) {
    const intelMilestones = (intel.milestones_json as unknown as MilestoneItem[] | null) ?? [];
    if (milestoneIndex >= 0 && milestoneIndex < intelMilestones.length) {
      const updatedIntel = intelMilestones.map((m, i) => {
        if (i === milestoneIndex) {
          return {
            ...m,
            status: completed ? 'completed' as const : 'pending' as const,
            date: completed ? now.split('T')[0] : (m as any).date || null,
            completedAt: completed ? now : undefined,
          };
        }
        return m;
      });
      await supabase
        .from('lead_intelligence')
        .update({ milestones_json: updatedIntel as unknown as Database['public']['Tables']['lead_intelligence']['Update']['milestones_json'] })
        .eq('lead_id', leadId);
    }
  }

  // Also update legacy leads.milestones_json for backwards compatibility
  const { data: lead, error: fetchErr } = await supabase
    .from('leads')
    .select('milestones_json')
    .eq('id', leadId)
    .single();

  if (fetchErr) throw fetchErr;

  const milestones = (lead?.milestones_json as unknown as MilestoneItem[] | null) ?? [];
  
  if (milestoneIndex >= 0 && milestoneIndex < milestones.length) {
    const updatedMilestones = milestones.map((m, i) => {
      if (i === milestoneIndex) {
        return {
          ...m,
          status: completed ? 'completed' as const : 'pending' as const,
          date: completed ? now.split('T')[0] : null,
          completedAt: completed ? now : undefined,
        };
      }
      return m;
    });

    const { error: updateErr } = await supabase
      .from('leads')
      .update({ 
        milestones_json: updatedMilestones as unknown as Database['public']['Tables']['leads']['Update']['milestones_json'],
        last_activity_at: now
      })
      .eq('id', leadId);

    if (updateErr) throw updateErr;
  }
}

export async function updateMeetingPackMilestoneStatus(
  packId: string, 
  milestoneIndex: number, 
  completed: boolean
): Promise<void> {
  if (!packId) throw new Error('Missing pack id');

  // Fetch current milestones
  const { data: pack, error: fetchErr } = await supabase
    .from('meeting_packs')
    .select('milestones')
    .eq('id', packId)
    .single();

  if (fetchErr) throw fetchErr;

  const milestones = (pack?.milestones as unknown as MilestoneItem[] | null) ?? [];
  
  if (milestoneIndex < 0 || milestoneIndex >= milestones.length) {
    throw new Error('Invalid milestone index');
  }

  const now = new Date().toISOString();
  const updatedMilestones = milestones.map((m, i) => {
    if (i === milestoneIndex) {
      return {
        ...m,
        status: completed ? 'completed' as const : 'pending' as const,
        date: completed ? now.split('T')[0] : null,
        completedAt: completed ? now : undefined,
      };
    }
    return m;
  });

  const { error: updateErr } = await supabase
    .from('meeting_packs')
    .update({ 
      milestones: updatedMilestones as unknown as Database['public']['Tables']['meeting_packs']['Update']['milestones']
    })
    .eq('id', packId);

  if (updateErr) throw updateErr;
}

// ============================================
// MEETING SUMMARIES QUERIES (Zoom)
// ============================================

export interface MeetingSummaryItem {
  id: string;
  lead_id: string | null;
  user_id: string;
  meeting_title: string | null;
  summary_text: string | null;
  participants_emails: string[];
  sent_at: string;
  created_at: string;
  source: string;
  followup_generated: boolean;
}

export async function getLeadMeetingSummaries(leadId: string): Promise<MeetingSummaryItem[]> {
  if (!leadId) throw new Error('Missing leadId');

  const { data, error } = await supabase
    .from('meeting_summaries')
    .select('*')
    .eq('lead_id', leadId)
    .order('sent_at', { ascending: false });

  if (error) throw error;

  return (data ?? []).map(row => ({
    id: row.id,
    lead_id: row.lead_id,
    user_id: row.user_id,
    meeting_title: row.meeting_title,
    summary_text: row.summary_text,
    participants_emails: row.participants_emails || [],
    sent_at: row.sent_at,
    created_at: row.created_at,
    source: row.source,
    followup_generated: row.followup_generated,
  }));
}

// ============================================
// EMAIL THREAD QUERIES
// ============================================

export interface EmailThreadItem {
  id: string;
  direction: 'inbound' | 'outbound';
  from_email: string | null;
  to_email: string | null;
  /** Full To header recipients (lowercase). Includes the primary to_email. */
  to_emails: string[];
  /** Full Cc header recipients (lowercase). */
  cc_emails: string[];
  subject: string | null;
  body_text: string;
  occurred_at: string;
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
}

/**
 * Canonical email thread for a lead — timeline-first.
 *
 * Reads `lead_timeline_items` (channel='email') as the source of truth, then
 * merges any orphaned legacy `interactions` rows that were never bridged.
 * Mirrors the dedupe strategy used in `getLeadActivityFeed` (see
 * src/lib/leadActivity.ts) so AI drafting and lead UI see one coherent
 * communication history.
 *
 * Output shape preserved for caller compatibility (contextResolver, etc.).
 *
 * TODO(cleanup): Once `interactions` is fully back-filled into
 * `lead_timeline_items`, drop the legacy fallback branch below.
 */
export async function getLeadEmailThread(
  leadId: string,
  limit = 10
): Promise<{ emails: EmailThreadItem[]; threadSummary: string }> {
  if (!leadId) throw new Error('Missing leadId');

  // Fetch a wider window than `limit` so we can dedupe across sources before slicing.
  const fetchWindow = Math.max(limit * 3, 30);

  // 1) Canonical: timeline (channel='email')
  const timelineRows = await getLeadTimeline(leadId, {
    channel: 'email',
    limit: fetchWindow,
  });

  const timelineEmails: EmailThreadItem[] = timelineRows
    .filter(t => t.direction === 'inbound' || t.direction === 'outbound')
    .map(t => {
      const meta = (t.metadata_json as Record<string, unknown>) || {};
      return {
        id: t.id,
        direction: t.direction as 'inbound' | 'outbound',
        from_email: (meta.from_email as string | null) ?? null,
        to_email: (meta.to_email as string | null) ?? null,
        to_emails: Array.isArray(meta.to_emails) ? (meta.to_emails as string[]) : [],
        cc_emails: Array.isArray(meta.cc_emails) ? (meta.cc_emails as string[]) : [],
        subject: t.subject,
        body_text: t.snippet_text ?? '',
        occurred_at: t.occurred_at,
        gmail_thread_id: (meta.gmail_thread_id as string | null) ?? null,
        gmail_message_id: (meta.gmail_message_id as string | null) ?? null,
      };
    });

  // Dedupe key set built from timeline (mirrors leadActivity adapter strategy).
  const seen = new Set<string>();
  for (const t of timelineRows) {
    if (t.source_id) seen.add(`sid:${t.source_id}`);
    const gid = (t.metadata_json as Record<string, unknown> | null)?.gmail_message_id;
    if (gid) seen.add(`gmail:${gid}`);
    if (t.snippet_text) {
      const ts = new Date(t.occurred_at).toISOString().slice(0, 19);
      seen.add(`soft:email:${ts}:${t.snippet_text.slice(0, 80)}`);
    }
  }

  // 2) Fallback: orphaned legacy interactions (no timeline mirror).
  let fallbackUsed = 0;
  let fallbackEmails: EmailThreadItem[] = [];
  try {
    const { data: legacy, error: legacyErr } = await supabase
      .from('interactions')
      .select('id, type, from_email, to_email, to_emails, cc_emails, subject, body_text, occurred_at, direction, gmail_thread_id, gmail_message_id')
      .eq('lead_id', leadId)
      .in('type', ['email_inbound', 'email_outbound'])
      .order('occurred_at', { ascending: false })
      .limit(fetchWindow);

    if (legacyErr) throw legacyErr;

    for (const row of (legacy as any[]) ?? []) {
      const keys: string[] = [`sid:${row.id}`];
      if (row.gmail_message_id) keys.push(`gmail:${row.gmail_message_id}`);
      if (row.body_text) {
        const ts = new Date(row.occurred_at).toISOString().slice(0, 19);
        keys.push(`soft:email:${ts}:${row.body_text.slice(0, 80)}`);
      }
      if (keys.some(k => seen.has(k))) continue;

      fallbackEmails.push({
        id: row.id,
        direction: row.type === 'email_inbound' ? 'inbound' : 'outbound',
        from_email: row.from_email,
        to_email: row.to_email,
        to_emails: Array.isArray(row.to_emails) ? row.to_emails : [],
        cc_emails: Array.isArray(row.cc_emails) ? row.cc_emails : [],
        subject: row.subject,
        body_text: row.body_text,
        occurred_at: row.occurred_at,
        gmail_thread_id: row.gmail_thread_id,
        gmail_message_id: row.gmail_message_id,
      });
      for (const k of keys) seen.add(k);
      fallbackUsed += 1;
    }
  } catch (err) {
    // Non-fatal — timeline is canonical, legacy is best-effort.
    console.warn('[getLeadEmailThread] legacy interactions fallback failed', err);
  }

  if (fallbackUsed > 0 && import.meta.env.DEV) {
    console.info(
      `[getLeadEmailThread] lead=${leadId} timeline=${timelineEmails.length} ` +
        `legacy_fallback=${fallbackUsed} (orphaned email interactions merged)`
    );
  }

  // Merge + sort newest-first + apply caller-requested limit.
  const merged = [...timelineEmails, ...fallbackEmails].sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
  );
  const emails = merged.slice(0, limit);

  // Build thread summary for AI context (unchanged format).
  const threadSummary = emails
    .map(e => `[${e.direction.toUpperCase()}] ${e.from_email} → ${e.to_email}\nSubject: ${e.subject || 'No subject'}\n${e.body_text?.slice(0, 500) || ''}`)
    .join('\n\n---\n\n');

  return { emails, threadSummary };
}

// ============================================
// LEAD ACTION MANAGEMENT
// ============================================

export async function dismissLeadAction(leadId: string, snoozeDays: number = 1): Promise<void> {
  if (!leadId) throw new Error('Missing leadId');

  // Repurpose action_dismissed_at as "snoozed until" timestamp
  const snoozeUntil = new Date();
  snoozeUntil.setDate(snoozeUntil.getDate() + snoozeDays);

  const { error } = await supabase
    .from('leads')
    .update({
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
      action_reason_code: null,
      action_dismissed_at: snoozeUntil.toISOString(),
      last_activity_at: new Date().toISOString(),
    })
    .eq('id', leadId);

  if (error) throw error;
}

/** PR 2.4 — true permanent dismiss of an action_required reminder. Cleared
 *  by syncEngine on a fresh inbound. The 5-second Undo toast calls this
 *  with `dismissed=false` and the snapshot returned by the dismiss call so
 *  the action fields are restored, not just `action_permanently_dismissed`. */
export interface LeadActionSnapshot {
  needs_action: boolean;
  next_action_key: string | null;
  next_action_label: string | null;
  action_reason_code: string | null;
}

/** PR C — extended snapshot returned by `mark_action_handled` RPC. Includes
 *  the dismissal columns so the undo path can fully restore prior state
 *  (and not just the visible action_* fields). Compatible with
 *  `LeadActionSnapshot` for the legacy `setLeadPermanentDismiss` callers. */
export interface LeadActionSnapshotFull extends LeadActionSnapshot {
  action_dismissed_at: string | null;
  action_permanently_dismissed: boolean;
}

export async function setLeadPermanentDismiss(
  leadId: string,
  dismissed: boolean,
  restore?: LeadActionSnapshot,
): Promise<LeadActionSnapshot | null> {
  if (!leadId) throw new Error('Missing leadId');

  let captured: LeadActionSnapshot | null = null;
  if (dismissed) {
    const { data, error: selErr } = await supabase
      .from('leads')
      .select('needs_action, next_action_key, next_action_label, action_reason_code')
      .eq('id', leadId)
      .single();
    if (selErr) throw selErr;
    captured = data as LeadActionSnapshot;
  }

  const updates: Record<string, unknown> = {
    action_permanently_dismissed: dismissed,
    last_activity_at: new Date().toISOString(),
  };
  if (dismissed) {
    updates.needs_action = false;
    updates.next_action_key = null;
    updates.next_action_label = null;
    updates.action_reason_code = null;
  } else if (restore) {
    updates.needs_action = restore.needs_action;
    updates.next_action_key = restore.next_action_key;
    updates.next_action_label = restore.next_action_label;
    updates.action_reason_code = restore.action_reason_code;
  }

  const { error } = await supabase
    .from('leads')
    .update(updates as any)
    .eq('id', leadId);
  if (error) throw error;
  return captured;
}

/** PR C — atomic Queue UI "mark handled" / "undo" via the
 *  `mark_action_handled` SECURITY DEFINER RPC.
 *
 *  Why a new function instead of extending `setLeadPermanentDismiss`:
 *   - Single server-side transaction (snapshot + write) so concurrent
 *     syncs can't land a torn snapshot between the SELECT and UPDATE.
 *   - Always sets `action_dismissed_at = now()` even when permanent —
 *     fixes the re-arm trap for permanent-dismissed leads tracked in
 *     KNOWN_ISSUES.md.
 *   - Returns the full prior state (including `action_dismissed_at` and
 *     `action_permanently_dismissed`) so the Undo toast can restore
 *     EVERYTHING, not just the visible action_* fields.
 *
 *  Existing `dismissLeadAction` and `setLeadPermanentDismiss` callers
 *  stay on the old client-side paths for now; PR D will migrate them
 *  to this RPC when it lands the Queue UI. */
export async function markActionHandled(
  leadId: string,
  opts: { permanent?: boolean } = {},
): Promise<LeadActionSnapshotFull> {
  if (!leadId) throw new Error('Missing leadId');

  // Auth warmup — mirrors `setTimelineFollowupState`. Cold-tab first
  // clicks were occasionally hitting RLS denial because the auth header
  // hadn't fully attached to the supabase-js client yet.
  await supabase.auth.getSession();

  const args = {
    p_lead_id: leadId,
    p_permanent: opts.permanent ?? false,
    p_restore: null,
  };

  const isTransient = (e: unknown): boolean => {
    if (!e) return false;
    const err = e as { code?: string; message?: string; name?: string };
    if (err.code === '42501') return true;
    if (typeof err.message === 'string' && /Not authenticated|Failed to fetch|NetworkError|fetch/i.test(err.message)) return true;
    if (err.name === 'TypeError') return true;
    return false;
  };

  let first: { data: unknown; error: unknown } | null = null;
  try {
    first = await supabase.rpc('mark_action_handled', args);
  } catch (thrown) {
    if (!isTransient(thrown)) throw thrown;
    console.warn('[markActionHandled] transient throw — retrying after 400ms', thrown);
    first = { data: null, error: thrown };
  }
  if (!first.error) return first.data as LeadActionSnapshotFull;
  if (!isTransient(first.error)) throw first.error;

  console.warn('[markActionHandled] transient error — retrying after 400ms', first.error);
  await new Promise((r) => setTimeout(r, 400));
  const { data: retryData, error: retryError } = await supabase.rpc('mark_action_handled', args);
  if (retryError) throw retryError;
  return retryData as LeadActionSnapshotFull;
}

/** PR C — Undo companion for `markActionHandled`. Pass the snapshot
 *  returned by `markActionHandled` to restore the lead's prior state
 *  atomically. */
export async function undoMarkActionHandled(
  leadId: string,
  snapshot: LeadActionSnapshotFull,
): Promise<void> {
  if (!leadId) throw new Error('Missing leadId');

  await supabase.auth.getSession();

  const args = {
    p_lead_id: leadId,
    p_permanent: false,
    p_restore: snapshot as unknown as Record<string, unknown>,
  };

  const { error } = await supabase.rpc('mark_action_handled', args);
  if (error) throw error;
}

// ============================================
// INLINE EMAIL PREVIEW
// ============================================

export interface EmailPreviewSnippet {
  body_text: string;
  from_email: string | null;
  occurred_at: string;
  subject: string | null;
}

/**
 * Latest inbound email snippet — timeline-first.
 * Falls back to legacy interactions only if timeline has no inbound email yet.
 *
 * TODO(cleanup): Remove fallback once interactions back-fill is verified.
 */
export async function getLatestInboundEmail(leadId: string): Promise<EmailPreviewSnippet | null> {
  if (!leadId) throw new Error('Missing leadId');

  // 1) Canonical: timeline (channel='email', inbound)
  const timelineRows = await getLeadTimeline(leadId, { channel: 'email', limit: 25 });
  const inbound = timelineRows.find(t => t.direction === 'inbound');
  if (inbound) {
    const meta = (inbound.metadata_json as Record<string, unknown>) || {};
    return {
      body_text: inbound.snippet_text ?? '',
      from_email: (meta.from_email as string | null) ?? null,
      occurred_at: inbound.occurred_at,
      subject: inbound.subject,
    };
  }

  // 2) Legacy fallback
  const { data, error } = await supabase
    .from('interactions')
    .select('body_text, from_email, occurred_at, subject')
    .eq('lead_id', leadId)
    .eq('type', 'email_inbound')
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (data && import.meta.env.DEV) {
    console.info(`[getLatestInboundEmail] lead=${leadId} legacy_fallback=1 (no timeline inbound)`);
  }
  return data;
}

// ============================================
// STAGE UPDATES
// ============================================

export async function updateLeadStage(leadId: string, stage: string): Promise<void> {
  if (!leadId) throw new Error('Missing leadId');

  const { error } = await supabase
    .from('leads')
    .update({
      stage,
      last_activity_at: new Date().toISOString(),
    })
    .eq('id', leadId);

  if (error) throw error;
}

export async function bulkUpdateLeadStage(leadIds: string[], stage: string): Promise<void> {
  if (!leadIds.length) throw new Error('No leads to update');

  const { error } = await supabase
    .from('leads')
    .update({
      stage,
      last_activity_at: new Date().toISOString(),
    })
    .in('id', leadIds);

  if (error) throw error;
}

// ============================================
// LEAD INTELLIGENCE QUERIES
// ============================================

// ── Normalized evidence-linked types ──

export interface EvidenceRef {
  id: string;
  source_type: string;
  source_id: string;
  snippet: string;
  channel?: string;
  occurred_at?: string;
}

export interface NormalizedRisk {
  issue: string;
  level: "low" | "medium" | "high";
  evidence_ids: string[];
  source_types: string[];
}

export interface NormalizedMilestone {
  description: string;
  status: "completed" | "pending";
  date: string | null;
  evidence_ids: string[];
  source_types: string[];
}

export interface NormalizedObjection {
  text: string;
  evidence_ids: string[];
  source_types: string[];
}

export interface NormalizedBuyingSignal {
  text: string;
  evidence_ids: string[];
  source_types: string[];
}

export interface EngagementSignals {
  engagement_score: number;
  total_timeline_events: number;
  inbound_count: number;
  outbound_count: number;
  response_rate_pct: number;
  channel_activity: Record<string, number>;
  sentiment_score: number;
  sentiment_breakdown: { positive: number; negative: number; neutral: number };
  urgency_breakdown: { high: number; medium: number };
}

export interface ChannelRecommendations {
  recommended_channel: string | null;
  vote_counts: Record<string, number>;
  total_analyses: number;
}

export interface LeadIntelligence {
  id: string;
  lead_id: string;
  workspace_id: string;
  summary_text: string | null;
  recommended_next_step: string | null;
  next_step_reason: string | null;
  milestones_json: NormalizedMilestone[];
  risks_json: NormalizedRisk[];
  objections_json: NormalizedObjection[];
  buying_signals_json: NormalizedBuyingSignal[];
  engagement_signals_json: EngagementSignals;
  channel_recommendations_json: ChannelRecommendations;
  evidence_json: EvidenceRef[];
  deal_factors_json: Record<string, any>;
  last_computed_at: string;
  version: number;
  model_used: string | null;
  source_counts_json: Record<string, number>;
}

export async function getLeadIntelligence(leadId: string): Promise<LeadIntelligence | null> {
  const { data, error } = await supabase
    .from('lead_intelligence')
    .select('*')
    .eq('lead_id', leadId)
    .maybeSingle();

  if (error) {
    console.error('[getLeadIntelligence] Error:', error);
    return null;
  }
  return data as unknown as LeadIntelligence | null;
}

export async function triggerIntelligenceRecompute(leadId: string): Promise<{ ok: boolean; error?: string }> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) return { ok: false, error: 'Not authenticated' };

  const res = await fetch(`${supabaseUrl}/functions/v1/recompute-lead-intelligence`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify({ lead_id: leadId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, error: err.error || `Recompute failed (${res.status})` };
  }
  return { ok: true };
}
