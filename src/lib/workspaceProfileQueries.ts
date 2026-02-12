// Workspace Profile query functions for multi-tenant company/product configuration
import { supabase } from '@/integrations/supabase/client';
import { 
  CadenceSettingsV1, 
  DEFAULT_CADENCE_SETTINGS, 
  deepMergeCadenceSettings 
} from './cadenceSettingsTypes';

// Re-export cadence types for convenience
export type { CadenceSettingsV1 } from './cadenceSettingsTypes';
export { DEFAULT_CADENCE_SETTINGS, deepMergeCadenceSettings } from './cadenceSettingsTypes';

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
  cadence_settings: CadenceSettingsV1;
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
  cadence_settings?: Partial<CadenceSettingsV1>;
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
  
  // Merge with defaults to ensure all fields exist
  const rawCadence = data.cadence_settings || {};
  const mergedCadence = deepMergeCadenceSettings(DEFAULT_CADENCE_SETTINGS, rawCadence);
  
  return {
    ...data,
    primary_value_props: data.primary_value_props || [],
    supported_use_cases: data.supported_use_cases || [],
    allowed_claims: data.allowed_claims || [],
    disallowed_topics: data.disallowed_topics || [],
    cadence_settings: mergedCadence,
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
  
  const lines: string[] = ['=== COMPANY CONTEXT ==='];
  
  if (workspace.company_name) lines.push(`Company: ${workspace.company_name}`);
  if (workspace.product_name) lines.push(`Product: ${workspace.product_name}`);
  if (workspace.product_description) lines.push(`Description: ${workspace.product_description}`);
  
  if (workspace.primary_value_props.length > 0) {
    lines.push('Value Propositions:');
    workspace.primary_value_props.forEach(v => lines.push(`- ${v}`));
  }
  
  if (workspace.pricing_policy === 'no_pricing_in_email') {
    lines.push('Pricing Policy: Do NOT include pricing, discounts, or commercial terms in emails. May propose a meeting to discuss pricing.');
  } else {
    lines.push('Pricing Policy: Pricing may be included in emails.');
  }
  
  if (workspace.allowed_claims.length > 0) {
    lines.push('Allowed Claims:');
    workspace.allowed_claims.forEach(c => lines.push(`- ${c}`));
  }
  
  if (workspace.disallowed_topics.length > 0) {
    lines.push('Disallowed Topics:');
    workspace.disallowed_topics.forEach(t => lines.push(`- ${t}`));
  }
  
  if (workspace.supported_use_cases.length > 0) {
    lines.push('Supported Use Cases:');
    workspace.supported_use_cases.forEach(u => lines.push(`- ${u}`));
  }
  
  const wp = workspace as any;
  if (wp.industry) lines.push(`Industry: ${wp.industry}`);
  
  if (workspace.meeting_timezone) lines.push(`Timezone: ${workspace.meeting_timezone}`);
  
  const result = lines.join('\n');
  return result.length > 1200 ? result.slice(0, 1197) + '...' : result;
}

// ============================================
// CADENCE SETTINGS QUERIES
// ============================================

export async function getCadenceSettings(): Promise<CadenceSettingsV1> {
  const profile = await getWorkspaceProfile();
  if (!profile) {
    return DEFAULT_CADENCE_SETTINGS;
  }
  return profile.cadence_settings;
}

export async function updateCadenceSettings(settings: Partial<CadenceSettingsV1>): Promise<void> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not logged in');

  // Get existing settings to merge with
  const current = await getCadenceSettings();
  const merged = deepMergeCadenceSettings(current, settings);
  
  await upsertWorkspaceProfile({ cadence_settings: merged });
}
