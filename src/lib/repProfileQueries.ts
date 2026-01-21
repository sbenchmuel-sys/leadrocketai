// Rep Profile and Signatures query functions
import { supabase } from '@/integrations/supabase/client';

// ============================================
// REP PROFILE TYPES & QUERIES
// ============================================

export interface RepProfile {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  company_name: string | null;
  linkedin_url: string | null;
  calendar_link: string | null;
  office_address: string | null;
  created_at: string;
  updated_at: string;
}

export interface RepProfileInput {
  full_name?: string | null;
  email?: string | null;
  phone?: string | null;
  job_title?: string | null;
  company_name?: string | null;
  linkedin_url?: string | null;
  calendar_link?: string | null;
  office_address?: string | null;
}

export async function getRepProfile(): Promise<RepProfile | null> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const { data, error } = await supabase
    .from('rep_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw error;
  return data as RepProfile | null;
}

export async function upsertRepProfile(input: RepProfileInput): Promise<RepProfile> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  // Check if profile exists
  const { data: existing } = await supabase
    .from('rep_profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing) {
    // Update
    const { data, error } = await supabase
      .from('rep_profiles')
      .update(input)
      .eq('user_id', user.id)
      .select()
      .single();
    
    if (error) throw error;
    return data as RepProfile;
  } else {
    // Insert
    const { data, error } = await supabase
      .from('rep_profiles')
      .insert({ user_id: user.id, ...input })
      .select()
      .single();
    
    if (error) throw error;
    return data as RepProfile;
  }
}

// ============================================
// SIGNATURES TYPES & QUERIES
// ============================================

export interface RepSignature {
  id: string;
  user_id: string;
  name: string;
  signature_text: string;
  is_default: boolean;
  created_at: string;
}

export interface SignatureInput {
  name: string;
  signature_text: string;
}

export async function getSignatures(): Promise<RepSignature[]> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const { data, error } = await supabase
    .from('rep_signatures')
    .select('*')
    .eq('user_id', user.id)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as RepSignature[];
}

export async function getDefaultSignature(): Promise<RepSignature | null> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  const { data, error } = await supabase
    .from('rep_signatures')
    .select('*')
    .eq('user_id', user.id)
    .eq('is_default', true)
    .maybeSingle();

  if (error) throw error;
  return data as RepSignature | null;
}

export async function createSignature(input: SignatureInput): Promise<RepSignature> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  // Check if this is the first signature - make it default
  const existingSignatures = await getSignatures();
  const isDefault = existingSignatures.length === 0;

  const { data, error } = await supabase
    .from('rep_signatures')
    .insert({
      user_id: user.id,
      name: input.name,
      signature_text: input.signature_text,
      is_default: isDefault,
    })
    .select()
    .single();

  if (error) throw error;
  return data as RepSignature;
}

export async function updateSignature(id: string, input: Partial<SignatureInput>): Promise<void> {
  const { error } = await supabase
    .from('rep_signatures')
    .update(input)
    .eq('id', id);

  if (error) throw error;
}

export async function deleteSignature(id: string): Promise<void> {
  const { error } = await supabase
    .from('rep_signatures')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

export async function setDefaultSignature(id: string): Promise<void> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  // First, unset all defaults for this user
  await supabase
    .from('rep_signatures')
    .update({ is_default: false })
    .eq('user_id', user.id);

  // Then set the selected one as default
  const { error } = await supabase
    .from('rep_signatures')
    .update({ is_default: true })
    .eq('id', id);

  if (error) throw error;
}

// ============================================
// KNOWLEDGE DOCUMENTS FOR ATTACHMENTS
// ============================================

export interface KnowledgeDocument {
  id: string;
  title: string | null;
  source: string | null;
  content: string;
}

export async function getKnowledgeDocuments(): Promise<KnowledgeDocument[]> {
  const { data, error } = await supabase
    .from('kb_chunks')
    .select('id, title, source, content')
    .eq('allowed_customer_facing', true)
    .eq('processing_status', 'completed')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;

  // Dedupe by title/source to get unique documents
  const seen = new Set<string>();
  const unique: KnowledgeDocument[] = [];
  
  for (const doc of data ?? []) {
    const key = doc.title || doc.source || doc.id;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push({
        id: doc.id,
        title: doc.title,
        source: doc.source,
        content: doc.content,
      });
    }
  }

  return unique;
}

// ============================================
// LEAD ACTION INSTRUCTIONS
// ============================================

export async function updateLeadActionInstructions(leadId: string, instructions: string | null): Promise<void> {
  if (!leadId) throw new Error('Missing leadId');

  const { error } = await supabase
    .from('leads')
    .update({ action_instructions: instructions })
    .eq('id', leadId);

  if (error) throw error;
}

export async function getLeadActionInstructions(leadId: string): Promise<string | null> {
  if (!leadId) throw new Error('Missing leadId');

  const { data, error } = await supabase
    .from('leads')
    .select('action_instructions')
    .eq('id', leadId)
    .single();

  if (error) throw error;
  return (data as { action_instructions: string | null })?.action_instructions ?? null;
}
