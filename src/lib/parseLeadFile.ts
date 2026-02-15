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
}

function mapRowToLead(row: Record<string, string>): ParsedLead {
  const firstName = (row["First Name"] || row["FirstName"] || row["first_name"] || "").trim();
  const lastName = (row["Last Name"] || row["LastName"] || row["last_name"] || "").trim();
  const name = firstName && lastName
    ? `${firstName} ${lastName}`
    : (row["Name"] || row["name"] || firstName || "Unknown").trim();

  const company = (
    row["Company Name"] || row["Company"] || row["company"] || row["company_name"] || ""
  ).trim();

  const email = (
    row["Email"] || row["email"] || row["Email Address"] || ""
  ).trim().toLowerCase();

  return {
    name,
    company: company || "Unknown Company",
    email,
    job_title: (row["Job Title"] || row["Title"] || row["job_title"] || "").trim() || undefined,
    phone: (row["Phone Number"] || row["Phone"] || row["phone"] || "").trim() || undefined,
    industry: (row["Industry"] || row["industry"] || "").trim() || undefined,
    country: (row["Country/Region"] || row["Country"] || row["country"] || "").trim() || undefined,
    initial_message: (row["Message"] || row["Notes"] || row["message"] || "").trim() || undefined,
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
