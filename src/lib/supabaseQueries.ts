// 07_SUPABASE_JS_QUERIES
// Database query functions for Deal Assistant

import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';

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
  'owner_user_id' | 'created_at' | 'last_activity_at' | 'next_step' | 'deal_outlook' | 'country'
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
    .select('id, company, name, email, status, owner_user_id, created_at, last_activity_at, next_step, deal_outlook, country')
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
  'nurture_cadence' | 'mode_changed_at'
>;

export async function getLeadDetail(leadId: string): Promise<LeadDetail> {
  if (!leadId) throw new Error('Missing leadId');

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
    .select('id, company, name, email, strategy, status, stage, owner_user_id, created_at, last_activity_at, meeting_link, personal_notes, pref_email_drafts, pref_linkedin_drafts, milestones_json, risks_json, next_step, next_step_reason, deal_outlook, deal_factors_json, last_ai_run_at, job_title, phone, industry, country, initial_message, motion, source_type, needs_action, next_action_key, next_action_label, has_future_meeting, last_inbound_at, last_outbound_at, eligible_at, nurture_cadence, mode_changed_at')
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
  source_type?: 'outbound_prospecting' | 'contact_form' | 'gmail_inbound' | 'event_lead' | 'referral' | 'csv_import' | 'manual_entry';
}

export async function createLead(form: CreateLeadInput): Promise<{ id: string }> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const payload = {
    name: form.name?.trim(),
    company: form.company?.trim(),
    email: form.email?.trim().toLowerCase(),
    strategy: 'fast' as const, // kept for DB column compatibility, no longer used for logic
    source_type: form.source_type || 'manual_entry',
    owner_user_id: user.id,
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
  'from_email' | 'to_email' | 'body_text' | 'ai_summary' | 'ai_intent' | 'ai_reply_worthy' | 'gmail_message_id'
>;

export async function getLeadInteractions(leadId: string): Promise<InteractionItem[]> {
  if (!leadId) throw new Error('Missing leadId');

  const { data, error } = await supabase
    .from('interactions')
    .select('id, lead_id, type, source, occurred_at, subject, from_email, to_email, body_text, ai_summary, ai_intent, ai_reply_worthy, gmail_message_id')
    .eq('lead_id', leadId)
    .order('occurred_at', { ascending: false })
    .limit(100);

  if (error) throw error;
  return data ?? [];
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
}

export async function insertInteraction(leadId: string, form: InsertInteractionInput): Promise<{ id: string; lead_id: string }> {
  if (!leadId) throw new Error('Missing leadId');

  const payload = {
    lead_id: leadId,
    type: form.type,
    source: form.source || 'manual',
    occurred_at: form.occurred_at || new Date().toISOString(),
    subject: form.subject || null,
    from_email: form.from_email || null,
    to_email: form.to_email || null,
    body_text: form.body_text?.trim() || '',
  };

  if (!payload.body_text) throw new Error('Missing body_text');

  const { data, error } = await supabase
    .from('interactions')
    .insert(payload)
    .select('id, lead_id')
    .single();

  if (error) throw error;

  // Update lead's last_activity_at
  await supabase
    .from('leads')
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', leadId);

  return data;
}

// ============================================
// DRAFTS QUERIES
// ============================================

export interface SaveDraftInput {
  lead_id?: string;
  channel: 'email' | 'linkedin' | 'whatsapp';
  draft_type: string;
  to_recipient?: string;
  subject?: string;
  body_text: string;
  step_key?: string;
  nurture_theme?: string;
  nurture_cadence?: string;
  status?: 'pending' | 'saved' | 'sent' | 'skipped';
}

export async function saveDraft(leadId: string, form: SaveDraftInput): Promise<{ id: string }> {
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

  // Fetch current milestones
  const { data: lead, error: fetchErr } = await supabase
    .from('leads')
    .select('milestones_json')
    .eq('id', leadId)
    .single();

  if (fetchErr) throw fetchErr;

  const milestones = (lead?.milestones_json as unknown as MilestoneItem[] | null) ?? [];
  
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
    .from('leads')
    .update({ 
      milestones_json: updatedMilestones as unknown as Database['public']['Tables']['leads']['Update']['milestones_json'],
      last_activity_at: now
    })
    .eq('id', leadId);

  if (updateErr) throw updateErr;
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

export async function getLeadEmailThread(
  leadId: string, 
  limit = 10
): Promise<{ emails: EmailThreadItem[]; threadSummary: string }> {
  if (!leadId) throw new Error('Missing leadId');

  const { data, error } = await supabase
    .from('interactions')
    .select('id, type, from_email, to_email, subject, body_text, occurred_at, direction, gmail_thread_id, gmail_message_id')
    .eq('lead_id', leadId)
    .in('type', ['email_inbound', 'email_outbound'])
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const emails: EmailThreadItem[] = (data ?? []).map(row => ({
    id: row.id,
    direction: row.type === 'email_inbound' ? 'inbound' : 'outbound',
    from_email: row.from_email,
    to_email: row.to_email,
    subject: row.subject,
    body_text: row.body_text,
    occurred_at: row.occurred_at,
    gmail_thread_id: row.gmail_thread_id,
    gmail_message_id: row.gmail_message_id,
  }));

  // Build thread summary for AI context
  const threadSummary = emails
    .map(e => `[${e.direction.toUpperCase()}] ${e.from_email} → ${e.to_email}\nSubject: ${e.subject || 'No subject'}\n${e.body_text?.slice(0, 500) || ''}`)
    .join('\n\n---\n\n');

  return { emails, threadSummary };
}

// ============================================
// LEAD ACTION MANAGEMENT
// ============================================

export async function dismissLeadAction(leadId: string, reasonCode?: string): Promise<void> {
  if (!leadId) throw new Error('Missing leadId');

  const { error } = await supabase
    .from('leads')
    .update({
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
      action_reason_code: reasonCode || null,
      action_dismissed_at: new Date().toISOString(), // Track dismissal timestamp
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

export async function getLatestInboundEmail(leadId: string): Promise<EmailPreviewSnippet | null> {
  if (!leadId) throw new Error('Missing leadId');

  const { data, error } = await supabase
    .from('interactions')
    .select('body_text, from_email, occurred_at, subject')
    .eq('lead_id', leadId)
    .eq('type', 'email_inbound')
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
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
