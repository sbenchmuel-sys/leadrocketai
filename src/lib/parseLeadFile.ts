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

  return {
    name,
    company: company || "Unknown Company",
    email,
    job_title: (r["job_title"] || "").trim() || undefined,
    phone: (r["phone"] || "").trim() || undefined,
    industry: (r["industry"] || "").trim() || undefined,
    country: (r["country"] || "").trim() || undefined,
    initial_message: (r["message"] || "").trim() || undefined,
  };
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
