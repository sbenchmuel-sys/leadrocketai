// 07_SUPABASE_JS_QUERIES
// Database query functions for Binah Deal Assistant

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
  'id' | 'company' | 'name' | 'email' | 'strategy' | 'status' | 
  'owner_user_id' | 'created_at' | 'last_activity_at' | 'next_step' | 'deal_outlook'
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
    .select('id, company, name, email, strategy, status, owner_user_id, created_at, last_activity_at, next_step, deal_outlook')
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
  'id' | 'company' | 'name' | 'email' | 'strategy' | 'status' | 'owner_user_id' |
  'created_at' | 'last_activity_at' | 'meeting_link' | 'personal_notes' |
  'pref_email_drafts' | 'pref_linkedin_drafts' | 'milestones_json' | 'risks_json' |
  'next_step' | 'next_step_reason' | 'deal_outlook' | 'deal_factors_json' | 'last_ai_run_at'
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
    .select('id, company, name, email, strategy, status, owner_user_id, created_at, last_activity_at, meeting_link, personal_notes, pref_email_drafts, pref_linkedin_drafts, milestones_json, risks_json, next_step, next_step_reason, deal_outlook, deal_factors_json, last_ai_run_at')
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
  strategy: 'fast' | 'nurture';
}

export async function createLead(form: CreateLeadInput): Promise<{ id: string }> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const payload = {
    name: form.name?.trim(),
    company: form.company?.trim(),
    email: form.email?.trim().toLowerCase(),
    strategy: form.strategy,
    owner_user_id: user.id,
    last_activity_at: new Date().toISOString(),
  };

  if (!payload.name || !payload.company || !payload.email || !payload.strategy) {
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

// ============================================
// INTERACTIONS QUERIES
// ============================================

export type InteractionItem = Pick<Interaction,
  'id' | 'lead_id' | 'type' | 'source' | 'occurred_at' | 'subject' |
  'from_email' | 'to_email' | 'body_text' | 'ai_summary' | 'ai_intent' | 'ai_reply_worthy'
>;

export async function getLeadInteractions(leadId: string): Promise<InteractionItem[]> {
  if (!leadId) throw new Error('Missing leadId');

  const { data, error } = await supabase
    .from('interactions')
    .select('id, lead_id, type, source, occurred_at, subject, from_email, to_email, body_text, ai_summary, ai_intent, ai_reply_worthy')
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
  channel: 'email' | 'linkedin';
  draft_type: string;
  to_recipient?: string;
  subject?: string;
  body_text: string;
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
  };

  if (!payload.lead_id || !payload.channel || !payload.draft_type || !payload.body_text) {
    throw new Error('Missing required draft fields');
  }

  const { data, error } = await supabase
    .from('drafts')
    .insert(payload)
    .select('id')
    .single();

  if (error) throw error;
  return data;
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
