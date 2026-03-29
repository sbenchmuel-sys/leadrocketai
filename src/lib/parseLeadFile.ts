import Papa from "papaparse";
import readExcelFile from "read-excel-file";

export interface ParsedLead {
  name: string;
  company: string;
  email: string;
  job_title?: string;
  phone?: string;
  industry?: string;
  country?: string;
  initial_message?: string;
  website?: string;
  linkedin_url?: string;
  company_linkedin_url?: string;
  city?: string;
  state?: string;
  // Extended import fields (Item 4)
  stage?: string;
  priority_label?: string;
  source_label?: string;
  product?: string;
  owner_name?: string;
  previous_owner?: string;
  last_contact_date?: string;
  next_step_text?: string;
  history_notes?: string;
  caution?: string;
  competitor?: string;
  objection?: string;
  pain_point?: string;
  // Raw import preservation
  raw_import_json?: Record<string, string>;
}

// Canonical key aliases: maps normalized variations to a single canonical name
const KEY_ALIASES: Record<string, string> = {
  "first name": "first_name",
  "firstname": "first_name",
  "first_name": "first_name",
  "last name": "last_name",
  "lastname": "last_name",
  "last_name": "last_name",
  "name": "name",
  "full name": "name",
  "fullname": "name",
  "company": "company",
  "company name": "company",
  "company_name": "company",
  "organisation": "company",
  "organization": "company",
  "email": "email",
  "email address": "email",
  "e-mail": "email",
  "email_address": "email",
  "job title": "job_title",
  "title": "job_title",
  "job_title": "job_title",
  "jobtitle": "job_title",
  "position": "job_title",
  "role": "job_title",
  "phone": "phone",
  "phone number": "phone",
  "phone_number": "phone",
  "phonenumber": "phone",
  "mobile": "phone",
  "telephone": "phone",
  "industry": "industry",
  "country": "country",
  "country/region": "country",
  "country_region": "country",
  "region": "country",
  "location": "country",
  "message": "message",
  "notes": "message",
  "note": "message",
  "initial message": "message",
  "initial_message": "message",
  "website": "website",
  "company website": "website",
  "web": "website",
  "url": "website",
  "person linkedin url": "linkedin_url",
  "linkedin url": "linkedin_url",
  "linkedin": "linkedin_url",
  "linkedin_url": "linkedin_url",
  "person linkedin": "linkedin_url",
  "company linkedin url": "company_linkedin_url",
  "company linkedin": "company_linkedin_url",
  "company_linkedin_url": "company_linkedin_url",
  "company street": "street",
  "street": "street",
  "address": "street",
  "company city": "city",
  "city": "city",
  "company state": "state",
  "state": "state",
  "state/province": "state",
  "province": "state",
  // Extended import fields (Item 4)
  "stage": "stage",
  "lead stage": "stage",
  "deal stage": "stage",
  "pipeline stage": "stage",
  "priority": "priority_label",
  "lead priority": "priority_label",
  "source": "source_label",
  "lead source": "source_label",
  "product": "product",
  "product interest": "product",
  "product_interest": "product",
  "owner": "owner_name",
  "lead owner": "owner_name",
  "assigned to": "owner_name",
  "assigned_to": "owner_name",
  "previous owner": "previous_owner",
  "previous_owner": "previous_owner",
  "last contact date": "last_contact_date",
  "last contact": "last_contact_date",
  "last_contact_date": "last_contact_date",
  "last contacted": "last_contact_date",
  "last_contacted": "last_contact_date",
  "next step": "next_step_text",
  "next_step": "next_step_text",
  "next action": "next_step_text",
  "next_action": "next_step_text",
  "history": "history_notes",
  "history notes": "history_notes",
  "history_notes": "history_notes",
  "account notes": "history_notes",
  "account_notes": "history_notes",
  "context": "history_notes",
  // Caution / restriction columns
  "caution": "caution",
  "cautions": "caution",
  "do not mention": "caution",
  "do_not_mention": "caution",
  "do not say": "caution",
  "do_not_say": "caution",
  "warning": "caution",
  "restriction": "caution",
  "restrictions": "caution",
  "sensitive": "caution",
  // Competitor columns
  "competitor": "competitor",
  "competitors": "competitor",
  "competitor_info": "competitor",
  "competitive context": "competitor",
  // Objection columns
  "objection": "objection",
  "objections": "objection",
  "known objections": "objection",
  "known_objections": "objection",
  "pain point": "pain_point",
  "pain points": "pain_point",
  "pain_points": "pain_point",
  "challenges": "pain_point",
};

/** Normalize all row keys to canonical names for case/variation-insensitive lookup */
function normalizeRow(row: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const lowerKey = key.trim().toLowerCase().replace(/[\s_-]+/g, " ");
    const canonical = KEY_ALIASES[lowerKey] || KEY_ALIASES[lowerKey.replace(/ /g, "_")] || lowerKey;
    // Only set if not already set (first match wins)
    if (!normalized[canonical]) {
      normalized[canonical] = value;
    }
  }
  return normalized;
}

function mapRowToLead(row: Record<string, string>): ParsedLead {
  const r = normalizeRow(row);
  const firstName = (r["first_name"] || "").trim();
  const lastName = (r["last_name"] || "").trim();
  const name = firstName && lastName
    ? `${firstName} ${lastName}`
    : (r["name"] || firstName || "Unknown").trim();

  const company = (r["company"] || "").trim();
  const email = (r["email"] || "").trim().toLowerCase();

  // Preserve ALL original columns verbatim (before normalization)
  const rawImportJson: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const trimmed = (value || "").trim();
    if (trimmed) rawImportJson[key] = trimmed;
  }

  return {
    name,
    company: company || "Unknown Company",
    email,
    job_title: (r["job_title"] || "").trim() || undefined,
    phone: (r["phone"] || "").trim() || undefined,
    industry: (r["industry"] || "").trim() || undefined,
    country: (r["country"] || "").trim() || undefined,
    initial_message: (r["message"] || "").trim() || undefined,
    website: (r["website"] || "").trim() || undefined,
    linkedin_url: (r["linkedin_url"] || "").trim() || undefined,
    company_linkedin_url: (r["company_linkedin_url"] || "").trim() || undefined,
    city: (r["city"] || "").trim() || undefined,
    state: (r["state"] || "").trim() || undefined,
    // Extended import fields (Item 4)
    stage: (r["stage"] || "").trim() || undefined,
    priority_label: (r["priority_label"] || "").trim() || undefined,
    source_label: (r["source_label"] || "").trim() || undefined,
    product: (r["product"] || "").trim() || undefined,
    owner_name: (r["owner_name"] || "").trim() || undefined,
    previous_owner: (r["previous_owner"] || "").trim() || undefined,
    last_contact_date: (r["last_contact_date"] || "").trim() || undefined,
    next_step_text: (r["next_step_text"] || "").trim() || undefined,
    history_notes: (r["history_notes"] || "").trim() || undefined,
    caution: (r["caution"] || "").trim() || undefined,
    competitor: (r["competitor"] || "").trim() || undefined,
    objection: (r["objection"] || "").trim() || undefined,
    pain_point: (r["pain_point"] || "").trim() || undefined,
    // Raw preservation
    raw_import_json: Object.keys(rawImportJson).length > 0 ? rawImportJson : undefined,
  };
}

// ============================================
// LEAD CONTEXT EXTRACTION (deterministic, no AI)
// ============================================

/** Category + content_type classification rules for known column types */
const COLUMN_CONTEXT_RULES: Record<string, { category: string; content_type: string }> = {
  previous_owner: { category: "relationship_history", content_type: "prior_contact" },
  owner_name: { category: "relationship_history", content_type: "prior_contact" },
  product: { category: "commercial_signal", content_type: "product_owned" },
  history_notes: { category: "imported_note", content_type: "prior_rep_notes" },
  last_contact_date: { category: "historical_fact", content_type: "prior_contact" },
  next_step_text: { category: "imported_note", content_type: "next_step" },
  priority_label: { category: "imported_note", content_type: "general" },
  source_label: { category: "historical_fact", content_type: "general" },
  message: { category: "imported_note", content_type: "general" },
  // Caution / restriction items
  caution: { category: "caution", content_type: "do_not_say" },
  // Competitor intel
  competitor: { category: "commercial_signal", content_type: "competitor_context" },
  // Pain points / objections
  objection: { category: "commercial_signal", content_type: "known_objection" },
  pain_point: { category: "commercial_signal", content_type: "pain_point" },
};

// Columns that are already mapped to core lead fields (no need to create context items)
const MAPPED_CANONICAL_KEYS = new Set([
  "first_name", "last_name", "name", "company", "email", "job_title", "phone",
  "industry", "country", "website", "linkedin_url", "company_linkedin_url",
  "city", "state", "street", "stage",
]);

export interface LeadContextItemInsert {
  lead_id: string;
  workspace_id: string;
  category: string;
  content_type: string;
  content_text: string;
  original_snippet: string;
  source_type: string;
  source_column_name: string | null;
  confidence: number | null;
  author_name: string | null;
  context_date: string | null;
}

/**
 * Deterministically extract context items from a parsed lead's data.
 * No AI involved — purely rule-based.
 */
export function extractLeadContextItems(
  lead: ParsedLead,
  leadId: string,
  workspaceId: string,
): LeadContextItemInsert[] {
  const items: LeadContextItemInsert[] = [];
  const rawJson = lead.raw_import_json || {};

  // 1. Extract from known extended fields
  const knownExtractions: Array<{ key: string; value: string | undefined; label: string }> = [
    { key: "previous_owner", value: lead.previous_owner, label: `Previous owner/rep: ${lead.previous_owner}` },
    { key: "owner_name", value: lead.owner_name, label: `Prior owner: ${lead.owner_name}` },
    { key: "product", value: lead.product, label: `Product interest/owned: ${lead.product}` },
    { key: "history_notes", value: lead.history_notes, label: lead.history_notes || "" },
    { key: "last_contact_date", value: lead.last_contact_date, label: `Last contacted: ${lead.last_contact_date}` },
    { key: "next_step_text", value: lead.next_step_text, label: `Next step: ${lead.next_step_text}` },
  ];

  // Avoid duplicate: if owner_name === previous_owner, skip one
  const seenValues = new Set<string>();

  for (const ext of knownExtractions) {
    if (!ext.value) continue;
    const normalizedVal = ext.value.toLowerCase().trim();
    if (seenValues.has(normalizedVal)) continue;
    seenValues.add(normalizedVal);

    const rule = COLUMN_CONTEXT_RULES[ext.key] || { category: "imported_note", content_type: "general" };
    const authorName = (ext.key === "previous_owner" || ext.key === "owner_name") ? ext.value : null;

    items.push({
      lead_id: leadId,
      workspace_id: workspaceId,
      category: rule.category,
      content_type: rule.content_type,
      content_text: ext.label,
      original_snippet: ext.value,
      source_type: "csv_import",
      source_column_name: ext.key,
      confidence: null, // deterministic — no confidence needed
      author_name: authorName,
      context_date: ext.key === "last_contact_date" ? tryParseDate(ext.value) : null,
    });
  }

  // 2. Extract initial_message / notes as imported_note
  if (lead.initial_message) {
    items.push({
      lead_id: leadId,
      workspace_id: workspaceId,
      category: "imported_note",
      content_type: "general",
      content_text: lead.initial_message,
      original_snippet: lead.initial_message,
      source_type: "csv_import",
      source_column_name: "message",
      confidence: null,
      author_name: null,
      context_date: null,
    });
  }

  // 3. Capture unmapped columns (columns not in MAPPED_CANONICAL_KEYS or known extractions)
  const extractedKeys = new Set(knownExtractions.map(e => e.key));
  extractedKeys.add("message");

  for (const [originalColName, value] of Object.entries(rawJson)) {
    if (!value || value.trim().length === 0) continue;
    const normalizedKey = originalColName.trim().toLowerCase().replace(/[\s_-]+/g, " ");
    const canonicalKey = KEY_ALIASES[normalizedKey] || KEY_ALIASES[normalizedKey.replace(/ /g, "_")] || normalizedKey;

    // Skip if it's a core mapped field or already extracted
    if (MAPPED_CANONICAL_KEYS.has(canonicalKey) || extractedKeys.has(canonicalKey)) continue;
    // Skip priority_label and source_label (already in personal_notes)
    if (canonicalKey === "priority_label" || canonicalKey === "source_label") continue;

    items.push({
      lead_id: leadId,
      workspace_id: workspaceId,
      category: "imported_note", // safe default for unmapped columns
      content_type: "general",
      content_text: `${originalColName}: ${value}`,
      original_snippet: value,
      source_type: "csv_import",
      source_column_name: originalColName,
      confidence: null,
      author_name: null,
      context_date: null,
    });
  }

  return items;
}

function tryParseDate(value: string): string | null {
  try {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch { /* ignore */ }
  return null;
}

function isExcel(fileName: string): boolean {
  return /\.xlsx?$/i.test(fileName);
}

export function parseLeadFile(file: File): Promise<ParsedLead[]> {
  return new Promise((resolve, reject) => {
    if (isExcel(file.name)) {
      readExcelFile(file).then((rows) => {
        if (rows.length < 2) {
          resolve([]);
          return;
        }
        const headers = rows[0].map((h) => String(h ?? "").trim());
        const leads: ParsedLead[] = [];
        for (let i = 1; i < rows.length; i++) {
          const row: Record<string, string> = {};
          headers.forEach((h, idx) => {
            row[h] = String(rows[i][idx] ?? "").trim();
          });
          leads.push(mapRowToLead(row));
        }
        resolve(leads.filter((l) => l.email && l.email.includes("@")));
      }).catch(reject);
    } else {
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const leads = results.data.map(mapRowToLead);
          resolve(leads.filter((l) => l.email && l.email.includes("@")));
        },
        error: (err) => reject(err),
      });
    }
  });
}
