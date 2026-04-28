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
  referral_source?: string;
  deal_value?: string;
  next_milestone_date?: string;
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
  // Referral columns
  "referred by": "referral_source",
  "reffered by": "referral_source",
  "referral": "referral_source",
  "referral source": "referral_source",
  "referral_source": "referral_source",
  // Deal value columns
  "deal value": "deal_value",
  "deal value / type": "deal_value",
  "deal_value": "deal_value",
  "deal value type": "deal_value",
  // Industry segment aliases
  "industry / segment": "industry",
  "industry segment": "industry",
  // Current stage aliases
  "current stage": "stage",
  // Status summary aliases
  "status summary": "history_notes",
  "status_summary": "history_notes",
  // Next milestone date
  "next milestone date": "next_milestone_date",
  "next milestone": "next_milestone_date",
  "next_milestone_date": "next_milestone_date",
  "next_milestone": "next_milestone_date",
  // Notes outcome
  "notes outcome": "history_notes",
  "notes (outcome)": "history_notes",
};

/** Normalize all row keys to canonical names for case/variation-insensitive lookup */
function normalizeRow(row: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const lowerKey = key.trim().toLowerCase().replace(/[:;]+$/, "").replace(/[\s_-]+/g, " ");
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
    referral_source: (r["referral_source"] || "").trim() || undefined,
    deal_value: (r["deal_value"] || "").trim() || undefined,
    next_milestone_date: (r["next_milestone_date"] || "").trim() || undefined,
    // Raw preservation
    raw_import_json: Object.keys(rawImportJson).length > 0 ? rawImportJson : undefined,
  };
}

// ============================================
// LEAD CONTEXT EXTRACTION (deterministic, no AI)
// ============================================

/** Phrases in free-text notes that promote category to relationship_history */
const RELATIONSHIP_HISTORY_PHRASES = [
  "existing contact",
  "ready to be contacted",
  "knows me",
  "warm intro",
  "warm introduction",
  "referred by",
  "referral from",
  "prior contact",
  "previously worked with",
  "previously contacted",
  "introduced by",
  "met at",
  "met with",
  "spoke with before",
  "had a call with",
  "former colleague",
  "ex-colleague",
  // Personal/known relationship signals
  "personal contact",
  "personal connection",
  "personal relationship",
  "my contact",
  "my connection",
  "know personally",
  "knows me personally",
  "friend of",
  "friend at",
  "ex-customer",
  "ex customer",
  "former customer",
  "former client",
  "past customer",
  "past client",
  "previous customer",
  "previous client",
  "long-time contact",
  "longtime contact",
  "old contact",
  "from my network",
  "in my network",
  "network contact",
];

/** Detect if a free-text note implies prior relationship */
function isRelationshipNote(text: string): boolean {
  const lower = text.toLowerCase();
  return RELATIONSHIP_HISTORY_PHRASES.some((p) => lower.includes(p));
}

/** Detect a planned-outreach phrase like "Initial comms wk-of 03/23" or future-dated next step */
function isPlannedOutreachNote(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(wk[- ]of|week of|initial comms|planned outreach|reach out (on|by)|follow up (on|by)|contact (on|by))\b/.test(lower)
    || /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(lower);
}

/** Heuristic mapping for unmapped raw column names → category/content_type */
function classifyUnmappedColumn(rawColName: string): { category: string; content_type: string } | null {
  const k = rawColName.trim().toLowerCase();
  // Commercial / opportunity columns
  if (/(opportunity|opp[\s_-]?size|deal[\s_-]?size|deal[\s_-]?value|annual[\s_-]?value|arr|mrr|contract[\s_-]?value|quota|revenue[\s_-]?potential|probability|win[\s_-]?probability)/.test(k)) {
    return { category: "commercial_signal", content_type: "deal_value" };
  }
  if (/(projected[\s_-]?close|estimated[\s_-]?close|close[\s_-]?date|expected[\s_-]?close|target[\s_-]?close|forecast[\s_-]?(date|close)|close[\s_-]?quarter)/.test(k)) {
    return { category: "commercial_signal", content_type: "close_timing" };
  }
  if (/(product[\s_-]?(line|category|type)|solution[\s_-]?of[\s_-]?interest|sku|model|safe[\s_-]?type)/.test(k)) {
    return { category: "commercial_signal", content_type: "product_owned" };
  }
  if (/(budget|spend|fiscal|fy[\s_-]?budget)/.test(k)) {
    return { category: "commercial_signal", content_type: "budget" };
  }
  if (/(decision[\s_-]?maker|champion|economic[\s_-]?buyer|stakeholder)/.test(k)) {
    return { category: "commercial_signal", content_type: "decision_maker" };
  }
  // Historical / factual columns
  if (/(last[\s_-]?(touch|activity|meeting|call)|account[\s_-]?since|customer[\s_-]?since|signup[\s_-]?date|first[\s_-]?contact|onboarded)/.test(k)) {
    return { category: "historical_fact", content_type: "prior_contact" };
  }
  // Relationship signals
  if (/(referred|referral|introduced|prior[\s_-]?rep|previous[\s_-]?owner|account[\s_-]?owner|csm|relationship[\s_-]?owner)/.test(k)) {
    return { category: "relationship_history", content_type: "prior_contact" };
  }
  return null; // unknown — fall back to imported_note
}

/** Category + content_type classification rules for known column types */
const COLUMN_CONTEXT_RULES: Record<string, { category: string; content_type: string }> = {
  previous_owner: { category: "relationship_history", content_type: "prior_contact" },
  owner_name: { category: "relationship_history", content_type: "prior_contact" },
  product: { category: "commercial_signal", content_type: "product_owned" },
  history_notes: { category: "imported_note", content_type: "prior_rep_notes" },
  last_contact_date: { category: "historical_fact", content_type: "prior_contact" },
  next_step_text: { category: "historical_fact", content_type: "next_step" },
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
  referral_source: { category: "relationship_history", content_type: "prior_contact" },
  deal_value: { category: "commercial_signal", content_type: "deal_value" },
  next_milestone_date: { category: "historical_fact", content_type: "milestone" },
};

// Columns that are already mapped to core lead fields (no need to create context items)
const MAPPED_CANONICAL_KEYS = new Set([
  "first_name", "last_name", "name", "company", "email", "job_title", "phone",
  "industry", "country", "website", "linkedin_url", "company_linkedin_url",
  "city", "state", "street", "stage", "priority_label", "source_label",
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
    { key: "caution", value: lead.caution, label: `⚠️ ${lead.caution}` },
    { key: "competitor", value: lead.competitor, label: `Competitor: ${lead.competitor}` },
    { key: "objection", value: lead.objection, label: `Known objection: ${lead.objection}` },
    { key: "pain_point", value: lead.pain_point, label: `Pain point: ${lead.pain_point}` },
    { key: "referral_source", value: lead.referral_source, label: `Referred by: ${lead.referral_source}` },
    { key: "deal_value", value: lead.deal_value, label: `Deal value/type: ${lead.deal_value}` },
    { key: "next_milestone_date", value: lead.next_milestone_date, label: `Next milestone: ${lead.next_milestone_date}` },
  ];

  // Avoid duplicate: if owner_name === previous_owner, skip one
  const seenValues = new Set<string>();

  for (const ext of knownExtractions) {
    if (!ext.value) continue;
    const normalizedVal = ext.value.toLowerCase().trim();
    if (seenValues.has(normalizedVal)) continue;
    seenValues.add(normalizedVal);

    let rule = COLUMN_CONTEXT_RULES[ext.key] || { category: "imported_note", content_type: "general" };

    // Heuristic upgrade: history_notes that mention prior contact → relationship_history
    if (ext.key === "history_notes" && isRelationshipNote(ext.value)) {
      rule = { category: "relationship_history", content_type: "prior_contact" };
    }

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
      context_date: (ext.key === "last_contact_date" || ext.key === "next_milestone_date" || ext.key === "next_step_text") ? tryParseDate(ext.value) : null,
    });
  }

  // 2. Extract initial_message / notes — promote to relationship_history if it implies prior contact
  if (lead.initial_message) {
    const isRelationship = isRelationshipNote(lead.initial_message);
    const isPlannedOutreach = isPlannedOutreachNote(lead.initial_message);
    items.push({
      lead_id: leadId,
      workspace_id: workspaceId,
      category: isRelationship ? "relationship_history" : (isPlannedOutreach ? "historical_fact" : "imported_note"),
      content_type: isRelationship ? "prior_contact" : (isPlannedOutreach ? "next_step" : "general"),
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

  // Suppressed columns — junk/internal data that should never become context items
  const SUPPRESSED_COLUMNS = new Set(["unnamed: 0", "appears_in_both", "current stage.1"]);

  for (const [originalColName, value] of Object.entries(rawJson)) {
    if (!value || value.trim().length === 0) continue;
    const normalizedKey = originalColName.trim().toLowerCase().replace(/[\s_-]+/g, " ");
    const canonicalKey = KEY_ALIASES[normalizedKey] || KEY_ALIASES[normalizedKey.replace(/ /g, "_")] || normalizedKey;

    // Skip suppressed columns
    if (SUPPRESSED_COLUMNS.has(normalizedKey)) continue;

    // Skip if it's a core mapped field or already extracted
    if (MAPPED_CANONICAL_KEYS.has(canonicalKey) || extractedKeys.has(canonicalKey)) continue;
    // Skip priority_label and source_label (already in personal_notes)
    if (canonicalKey === "priority_label" || canonicalKey === "source_label") continue;

    // Try to classify the unmapped column by name (Opportunity Size → commercial_signal, etc.)
    const inferred = classifyUnmappedColumn(originalColName);
    const category = inferred?.category ?? "imported_note";
    const contentType = inferred?.content_type ?? "general";

    items.push({
      lead_id: leadId,
      workspace_id: workspaceId,
      category,
      content_type: contentType,
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
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    if (!isNaN(d.getTime())) return d.toISOString();
    return null;
  }
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
            const cellVal = rows[i][idx];
            if (cellVal instanceof Date) {
              const y = cellVal.getUTCFullYear();
              const m = String(cellVal.getUTCMonth() + 1).padStart(2, "0");
              const d = String(cellVal.getUTCDate()).padStart(2, "0");
              row[h] = `${y}-${m}-${d}`;
            } else {
              row[h] = String(cellVal ?? "").trim();
            }
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
