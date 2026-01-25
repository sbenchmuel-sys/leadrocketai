// Workspace Profile query functions for multi-tenant company/product configuration
import { supabase } from '@/integrations/supabase/client';

// ============================================
// WORKSPACE PROFILE TYPES & QUERIES
// ============================================

export interface WorkspaceProfile {
  id: string;
  user_id: string;
  company_name: string | null;
  product_name: string | null;
  product_description: string | null;
  primary_value_props: string[];
  supported_use_cases: string[];
  allowed_claims: string[];
  disallowed_topics: string[];
  pricing_policy: 'no_pricing_in_email' | 'pricing_allowed';
  meeting_timezone: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceProfileInput {
  company_name?: string | null;
  product_name?: string | null;
  product_description?: string | null;
  primary_value_props?: string[];
  supported_use_cases?: string[];
  allowed_claims?: string[];
  disallowed_topics?: string[];
  pricing_policy?: 'no_pricing_in_email' | 'pricing_allowed';
  meeting_timezone?: string | null;
}

export async function getWorkspaceProfile(): Promise<WorkspaceProfile | null> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  // Cast to any to work around type generation lag
  const { data, error } = await (supabase as any)
    .from('workspace_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw error;
  
  if (!data) return null;
  
  return {
    ...data,
    primary_value_props: data.primary_value_props || [],
    supported_use_cases: data.supported_use_cases || [],
    allowed_claims: data.allowed_claims || [],
    disallowed_topics: data.disallowed_topics || [],
  } as WorkspaceProfile;
}

export async function upsertWorkspaceProfile(input: WorkspaceProfileInput): Promise<WorkspaceProfile> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  // Check if profile exists
  const { data: existing } = await (supabase as any)
    .from('workspace_profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing) {
    // Update
    const { data, error } = await (supabase as any)
      .from('workspace_profiles')
      .update(input)
      .eq('user_id', user.id)
      .select()
      .single();
    
    if (error) throw error;
    return data as WorkspaceProfile;
  } else {
    // Insert
    const { data, error } = await (supabase as any)
      .from('workspace_profiles')
      .insert({ user_id: user.id, ...input })
      .select()
      .single();
    
    if (error) throw error;
    return data as WorkspaceProfile;
  }
}

// ============================================
// HELPER: Format workspace context for AI prompts
// ============================================

export function formatWorkspaceContext(workspace: WorkspaceProfile | null): string {
  if (!workspace) return '';
  
  const lines: string[] = [];
  
  if (workspace.company_name) {
    lines.push(`Company: ${workspace.company_name}`);
  }
  if (workspace.product_name) {
    lines.push(`Product: ${workspace.product_name}`);
  }
  if (workspace.product_description) {
    lines.push(`Description: ${workspace.product_description}`);
  }
  if (workspace.primary_value_props.length > 0) {
    lines.push(`Value Props: ${workspace.primary_value_props.join('; ')}`);
  }
  if (workspace.pricing_policy === 'no_pricing_in_email') {
    lines.push(`Pricing Policy: Do NOT include pricing, discounts, or commercial terms in emails. May propose a meeting to discuss pricing.`);
  }
  if (workspace.meeting_timezone) {
    lines.push(`Timezone: ${workspace.meeting_timezone}`);
  }
  
  return lines.join('\n');
}
