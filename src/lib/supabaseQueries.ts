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
>;

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
    .select('id, company, name, email, strategy, status, stage, owner_user_id, created_at, last_activity_at, meeting_link, personal_notes, pref_email_drafts, pref_linkedin_drafts, milestones_json, risks_json, next_step, next_step_reason, deal_outlook, deal_factors_json, last_ai_run_at, job_title, phone, industry, country, initial_message, motion, source_type, needs_action, next_action_key, next_action_label, has_future_meeting, last_inbound_at, last_outbound_at, eligible_at, nurture_cadence, mode_changed_at, nurture_status, nurture_mode, nurture_theme, wa_opted_in, automation_mode, action_instructions, website, linkedin_url, company_linkedin_url, city, state')
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
  'from_email' | 'to_email' | 'body_text' | 'ai_summary' | 'ai_intent' | 'ai_reply_worthy' | 'gmail_message_id' | 'hidden'
>;

export async function getLeadInteractions(leadId: string, includeHidden = false): Promise<InteractionItem[]> {
  if (!leadId) throw new Error('Missing leadId');

  if (isDemoMode()) {
    return getDemoInteractions(leadId) as unknown as InteractionItem[];
  }

  let query = supabase
    .from('interactions')
    .select('id, lead_id, type, source, occurred_at, subject, from_email, to_email, body_text, ai_summary, ai_intent, ai_reply_worthy, gmail_message_id, hidden')
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
  return (data ?? []) as TimelineItem[];
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
 * Canonical lead-activity write helper.
 *
 * Writes to legacy `interactions` (preserved for backward compatibility) AND
 * projects the same event into `lead_timeline_items` so reads are immediately
 * coherent with the canonical adapter (`getLeadActivityFeed`).
 *
 * The timeline projection is best-effort and never fails the primary write.
 *
 * TODO(cleanup): once all readers move off `interactions`, flip the order so
 * the timeline write becomes primary and the legacy mirror becomes optional.
 */
export async function insertInteraction(leadId: string, form: InsertInteractionInput): Promise<{ id: string; lead_id: string }> {
  if (isDemoMode()) return { id: 'demo-blocked', lead_id: leadId };
  if (!leadId) throw new Error('Missing leadId');

  const occurredAt = form.occurred_at || new Date().toISOString();
  const payload = {
    lead_id: leadId,
    type: form.type,
    source: form.source || 'manual',
    occurred_at: occurredAt,
    subject: form.subject || null,
    from_email: form.from_email || null,
    to_email: form.to_email || null,
    body_text: form.body_text?.trim() || '',
    direction: form.direction ?? inferDirectionFromType(form.type),
  };

  if (!payload.body_text) throw new Error('Missing body_text');

  const { data, error } = await supabase
    .from('interactions')
    .insert(payload)
    .select('id, lead_id')
    .single();

  if (error) throw error;

  // --- Canonical timeline projection (best-effort) ---------------------
  if (form.projectToTimeline !== false) {
    try {
      const { data: leadRow } = await supabase
        .from('leads')
        .select('workspace_id')
        .eq('id', leadId)
        .single();

      if (leadRow?.workspace_id) {
        const channel = form.channel || inferChannelFromType(form.type);
        const direction = payload.direction;
        const dedupeKey = `interaction:${data.id}`;
        await supabase.from('lead_timeline_items').upsert(
          {
            workspace_id: leadRow.workspace_id,
            lead_id: leadId,
            channel,
            provider: payload.source,
            direction,
            event_type: form.type,
            occurred_at: occurredAt,
            source_table: 'interactions',
            source_id: data.id,
            subject: payload.subject,
            snippet_text: payload.body_text.slice(0, 500),
            dedupe_key: dedupeKey,
          },
          { onConflict: 'lead_id,dedupe_key' }
        );
      }
    } catch (projErr) {
      console.warn('[insertInteraction] timeline projection failed (non-fatal)', projErr);
    }
  }

  // Update lead's last_activity_at
  await supabase
    .from('leads')
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', leadId);

  return data;
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
      .select('id, type, from_email, to_email, subject, body_text, occurred_at, direction, gmail_thread_id, gmail_message_id')
      .eq('lead_id', leadId)
      .in('type', ['email_inbound', 'email_outbound'])
      .order('occurred_at', { ascending: false })
      .limit(fetchWindow);

    if (legacyErr) throw legacyErr;

    for (const row of legacy ?? []) {
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
