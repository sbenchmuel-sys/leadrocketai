// Query helpers for the Phase 2 lead_groups + group_partners data layer.
// Surfaces a single getLeadGroupContext() for the sidebar panel and thin
// wrappers around the RPC helpers for atomic create/swap operations.

import { supabase } from "@/integrations/supabase/client";

export interface LeadGroupRow {
  id: string;
  workspace_id: string;
  champion_lead_id: string | null;
  group_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  id: string;
  name: string;
  company: string | null;
  job_title: string | null;
  email: string | null;
  is_champion: boolean;
}

export interface GroupPartner {
  contact_id: string;
  display_name: string | null;
  company: string | null;
  role_note: string | null;
  added_at: string;
}

export interface LeadGroupContext {
  group: LeadGroupRow | null;
  members: GroupMember[];
  partners: GroupPartner[];
}

/**
 * Fetch the stakeholder group + members + partners for a given lead.
 * Returns { group: null, members: [], partners: [] } when the lead is solo.
 */
export async function getLeadGroupContext(leadId: string): Promise<LeadGroupContext> {
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("group_id")
    .eq("id", leadId)
    .single();

  if (leadErr || !lead?.group_id) {
    return { group: null, members: [], partners: [] };
  }

  const groupId = lead.group_id;

  const [groupRes, membersRes, partnersRes] = await Promise.all([
    supabase.from("lead_groups").select("*").eq("id", groupId).single(),
    supabase
      .from("leads")
      .select("id, name, company, job_title, email")
      .eq("group_id", groupId),
    supabase
      .from("group_partners")
      .select("contact_id, role_note, added_at, contacts:contact_id (id, display_name, company)")
      .eq("group_id", groupId),
  ]);

  const group = (groupRes.data as LeadGroupRow | null) ?? null;
  const championId = group?.champion_lead_id ?? null;

  const members: GroupMember[] = ((membersRes.data ?? []) as any[]).map((m) => ({
    id: m.id,
    name: m.name,
    company: m.company,
    job_title: m.job_title,
    email: m.email,
    is_champion: m.id === championId,
  }));

  const partners: GroupPartner[] = ((partnersRes.data ?? []) as any[]).map((p) => ({
    contact_id: p.contact_id,
    display_name: p.contacts?.display_name ?? null,
    company: p.contacts?.company ?? null,
    role_note: p.role_note,
    added_at: p.added_at,
  }));

  return { group, members, partners };
}

/**
 * Atomic group creation via SECURITY DEFINER RPC. Returns the new group id.
 * Use this instead of multi-step inserts to satisfy the deferred champion
 * constraint and avoid race conditions.
 */
export async function createLeadGroupWithChampion(
  championLeadId: string,
  groupName?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("create_lead_group_with_champion", {
    p_champion_lead_id: championLeadId,
    p_group_name: groupName ?? null,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Add an existing lead to an existing group. Caller must ensure the lead is
 * not already in another group (the UI should disable the action if so).
 */
export async function addLeadToGroup(leadId: string, groupId: string): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ group_id: groupId })
    .eq("id", leadId);
  if (error) throw error;
}

/** Remove a lead from its group. The cleanup trigger handles champion + empty-group cleanup. */
export async function removeLeadFromGroup(leadId: string): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ group_id: null })
    .eq("id", leadId);
  if (error) throw error;
}

/** Swap the champion. Wraps the RPC so the deferred constraint validates correctly. */
export async function setGroupChampion(groupId: string, newChampionLeadId: string): Promise<void> {
  const { error } = await supabase.rpc("set_lead_group_champion", {
    p_group_id: groupId,
    p_new_champion_lead_id: newChampionLeadId,
  });
  if (error) throw error;
}

/** Link an existing contact (partner) to a group. */
export async function addPartnerToGroup(
  groupId: string,
  contactId: string,
  roleNote?: string,
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("group_partners").insert({
    group_id: groupId,
    contact_id: contactId,
    role_note: roleNote ?? null,
    added_by_user_id: user?.id ?? null,
  });
  if (error) throw error;
}

/** Remove a partner from a group. */
export async function removePartnerFromGroup(
  groupId: string,
  contactId: string,
): Promise<void> {
  const { error } = await supabase
    .from("group_partners")
    .delete()
    .eq("group_id", groupId)
    .eq("contact_id", contactId);
  if (error) throw error;
}

/**
 * Search for workspace leads to add as stakeholders. Excludes leads already
 * in the given group. Optionally filters to a company name (case-insensitive
 * substring) to surface "people from the same company" by default.
 */
export async function searchLeadsForStakeholder(opts: {
  workspaceId: string;
  excludeGroupId?: string | null;
  excludeLeadIds?: string[];
  companyFilter?: string | null;
  query?: string;
  limit?: number;
}): Promise<Array<{ id: string; name: string; company: string | null; email: string | null; job_title: string | null; group_id: string | null }>> {
  let q = supabase
    .from("leads")
    .select("id, name, company, email, job_title, group_id")
    .eq("workspace_id", opts.workspaceId)
    .order("last_activity_at", { ascending: false })
    .limit(opts.limit ?? 25);

  if (opts.companyFilter) {
    q = q.ilike("company", `%${opts.companyFilter}%`);
  }
  if (opts.query) {
    const term = `%${opts.query}%`;
    q = q.or(`name.ilike.${term},email.ilike.${term},company.ilike.${term}`);
  }
  if (opts.excludeLeadIds && opts.excludeLeadIds.length > 0) {
    q = q.not("id", "in", `(${opts.excludeLeadIds.join(",")})`);
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data as any[] | null) ?? [];
}

/** Search workspace contacts for partner linking. */
export async function searchContactsForPartner(opts: {
  workspaceId: string;
  excludeContactIds?: string[];
  query?: string;
  limit?: number;
}): Promise<Array<{ id: string; display_name: string | null; company: string | null }>> {
  let q = supabase
    .from("contacts")
    .select("id, display_name, company")
    .eq("workspace_id", opts.workspaceId)
    .order("last_activity_at", { ascending: false })
    .limit(opts.limit ?? 25);

  if (opts.query) {
    const term = `%${opts.query}%`;
    q = q.or(`display_name.ilike.${term},company.ilike.${term}`);
  }
  if (opts.excludeContactIds && opts.excludeContactIds.length > 0) {
    q = q.not("id", "in", `(${opts.excludeContactIds.join(",")})`);
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data as any[] | null) ?? [];
}

/** Create a new contact (used by the partner-add dialog). */
export async function createContact(opts: {
  workspaceId: string;
  displayName: string;
  company?: string | null;
  notes?: string | null;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      workspace_id: opts.workspaceId,
      display_name: opts.displayName,
      company: opts.company ?? null,
      notes: opts.notes ?? null,
      status: "unclassified",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data as { id: string };
}

// ============================================================
// PR 2.3 — Contact detail page (`/app/contacts/:id`)
// ------------------------------------------------------------
// Cross-deal partner view. Given a contact, surface every group/deal
// they're linked to plus a small editable card of contact info.
// Editable fields: display_name + company. Email is read-only because
// it lives in the separate `contact_identities` table (UNIQUE per
// workspace+type+value); making it editable would require multi-table
// writes with collision handling — deferred, see PROGRESS.md.
// ============================================================

export interface ContactDetailRow {
  id: string;
  workspace_id: string;
  display_name: string | null;
  company: string | null;
  notes: string | null;
  primary_email: string | null;        // joined from contact_identities (read-only here)
  assigned_rep_user_id: string | null; // for the canEditContact RLS check
  created_at: string;
  updated_at: string;
}

export interface ContactGroupRow {
  group_id: string;
  group_name: string | null;
  role_note: string | null;
  added_at: string;
  champion_lead_id: string | null;
  champion_name: string | null;
  champion_company: string | null;
  champion_stage: string | null;
}

export interface UpdateContactPatch {
  display_name?: string | null;
  company?: string | null;
}

/** Load a contact by id plus their primary email (from contact_identities).
 *  RLS denial / not-found → returns null; caller renders the "not found" state. */
export async function getContactDetail(contactId: string): Promise<ContactDetailRow | null> {
  if (!contactId) return null;

  const [contactRes, emailRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, workspace_id, display_name, company, notes, assigned_rep_user_id, created_at, updated_at")
      .eq("id", contactId)
      .maybeSingle(),
    supabase
      .from("contact_identities")
      .select("value, is_primary")
      .eq("contact_id", contactId)
      .eq("type", "email")
      .order("is_primary", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (contactRes.error) throw contactRes.error;
  if (!contactRes.data) return null;

  const c = contactRes.data as {
    id: string;
    workspace_id: string;
    display_name: string | null;
    company: string | null;
    notes: string | null;
    assigned_rep_user_id: string | null;
    created_at: string;
    updated_at: string;
  };

  return {
    ...c,
    primary_email: ((emailRes.data as { value: string } | null)?.value) ?? null,
  };
}

/** Every group/deal this contact is linked to via `group_partners`,
 *  with the champion lead's basic info for the row label. Sorted by
 *  most-recently-added partner link first. */
export async function getGroupsForContact(contactId: string): Promise<ContactGroupRow[]> {
  if (!contactId) return [];

  const { data, error } = await supabase
    .from("group_partners")
    .select(`
      role_note,
      added_at,
      group:group_id (
        id,
        group_name,
        champion_lead_id,
        champion:champion_lead_id ( id, name, company, stage )
      )
    `)
    .eq("contact_id", contactId)
    .order("added_at", { ascending: false });

  if (error) throw error;

  return ((data ?? []) as any[])
    .filter(r => r.group) // RLS could in theory return a partner row whose group isn't visible
    .map(r => ({
      group_id: r.group.id as string,
      group_name: (r.group.group_name as string | null) ?? null,
      role_note: (r.role_note as string | null) ?? null,
      added_at: r.added_at as string,
      champion_lead_id: (r.group.champion_lead_id as string | null) ?? null,
      champion_name: (r.group.champion?.name as string | null) ?? null,
      champion_company: (r.group.champion?.company as string | null) ?? null,
      champion_stage: (r.group.champion?.stage as string | null) ?? null,
    }));
}

/** Partial update of a contact. Returns the updated columns so the page
 *  can merge into local state without a full refetch. */
export async function updateContact(
  contactId: string,
  patch: UpdateContactPatch,
): Promise<{ display_name: string | null; company: string | null; updated_at: string }> {
  // Strip undefined keys so we don't accidentally null a column the caller
  // didn't intend to touch.
  const cleaned: Record<string, unknown> = {};
  if (patch.display_name !== undefined) cleaned.display_name = patch.display_name;
  if (patch.company !== undefined) cleaned.company = patch.company;

  const { data, error } = await supabase
    .from("contacts")
    .update(cleaned)
    .eq("id", contactId)
    .select("display_name, company, updated_at")
    .single();
  if (error) throw error;
  return data as { display_name: string | null; company: string | null; updated_at: string };
}

/** Whether the current authenticated user can UPDATE this contact under
 *  the existing RLS policy: `is_workspace_member AND (admin OR
 *  assigned_rep_user_id = auth.uid())`. One workspace_members read.
 *  Used to disable edit fields with a tooltip when the user lacks
 *  permission — preferred over letting an UPDATE silently fail RLS. */
export async function canEditContact(
  contact: Pick<ContactDetailRow, "workspace_id" | "assigned_rep_user_id">,
): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  if (contact.assigned_rep_user_id === user.id) return true;

  const { data: member } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", contact.workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  return (member as { role?: string } | null)?.role === "admin";
}
