// ============================================================================
// Recipient timezone resolution (Outreach Unit C, PR 4)
//
// Lightweight, dependency-free country (+ US/CA state) → IANA timezone lookup so
// cold emails land in the PROSPECT's local morning, not the rep's. Folds into the
// existing send-window logic: the cold sender builds an ExecutionSettings whose
// `timezone` is the lead's, then checkSendWindow / computeNextEligibleAt do the
// rest (no new send logic). Falls back to the workspace timezone when the lead's
// location is unknown — so behavior is unchanged for location-less leads.
//
// Only ACTIVE when the workspace opts into timezone_mode:"lead"; otherwise the
// workspace timezone is used as today.
// ============================================================================

// US state / territory → IANA (representative zone per state).
const US_STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise",
  IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago", KS: "America/Chicago",
  KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York", MD: "America/New_York",
  MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago", NV: "America/Los_Angeles",
  NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York",
  NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York", OK: "America/Chicago",
  OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York", SC: "America/New_York",
  SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York",
  WI: "America/Chicago", WY: "America/Denver", DC: "America/New_York", PR: "America/Puerto_Rico",
};

const US_STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

// Canadian province → IANA.
const CA_PROVINCE_TZ: Record<string, string> = {
  BC: "America/Vancouver", AB: "America/Edmonton", SK: "America/Regina", MB: "America/Winnipeg",
  ON: "America/Toronto", QC: "America/Toronto", NB: "America/Halifax", NS: "America/Halifax",
  PE: "America/Halifax", NL: "America/St_Johns", YT: "America/Whitehorse", NT: "America/Yellowknife",
  NU: "America/Iqaluit",
};
const CA_PROVINCE_NAMES: Record<string, string> = {
  "british columbia": "BC", alberta: "AB", saskatchewan: "SK", manitoba: "MB", ontario: "ON",
  quebec: "QC", "québec": "QC", "new brunswick": "NB", "nova scotia": "NS",
  "prince edward island": "PE", "newfoundland and labrador": "NL", "newfoundland": "NL",
  yukon: "YT", "northwest territories": "NT", nunavut: "NU",
};

// Country → a single representative IANA zone.
const COUNTRY_TZ: Record<string, string> = {
  "united kingdom": "Europe/London", uk: "Europe/London", gb: "Europe/London", england: "Europe/London",
  ireland: "Europe/Dublin", france: "Europe/Paris", germany: "Europe/Berlin", spain: "Europe/Madrid",
  italy: "Europe/Rome", netherlands: "Europe/Amsterdam", belgium: "Europe/Brussels",
  switzerland: "Europe/Zurich", austria: "Europe/Vienna", sweden: "Europe/Stockholm",
  norway: "Europe/Oslo", denmark: "Europe/Copenhagen", finland: "Europe/Helsinki",
  poland: "Europe/Warsaw", portugal: "Europe/Lisbon", greece: "Europe/Athens",
  turkey: "Europe/Istanbul", israel: "Asia/Jerusalem", uae: "Asia/Dubai",
  "united arab emirates": "Asia/Dubai", india: "Asia/Kolkata", pakistan: "Asia/Karachi",
  singapore: "Asia/Singapore", "hong kong": "Asia/Hong_Kong", china: "Asia/Shanghai",
  japan: "Asia/Tokyo", "south korea": "Asia/Seoul", australia: "Australia/Sydney",
  "new zealand": "Pacific/Auckland", brazil: "America/Sao_Paulo", mexico: "America/Mexico_City",
  canada: "America/Toronto", "united states": "America/New_York", usa: "America/New_York",
  us: "America/New_York",
  // ISO-3166 alpha-2 codes (imports/CRMs often store the code, not the full name).
  ie: "Europe/Dublin", fr: "Europe/Paris", de: "Europe/Berlin", es: "Europe/Madrid",
  it: "Europe/Rome", nl: "Europe/Amsterdam", be: "Europe/Brussels", ch: "Europe/Zurich",
  at: "Europe/Vienna", se: "Europe/Stockholm", no: "Europe/Oslo", dk: "Europe/Copenhagen",
  fi: "Europe/Helsinki", pl: "Europe/Warsaw", pt: "Europe/Lisbon", gr: "Europe/Athens",
  tr: "Europe/Istanbul", il: "Asia/Jerusalem", ae: "Asia/Dubai", in: "Asia/Kolkata",
  pk: "Asia/Karachi", sg: "Asia/Singapore", hk: "Asia/Hong_Kong", cn: "Asia/Shanghai",
  jp: "Asia/Tokyo", kr: "Asia/Seoul", au: "Australia/Sydney", nz: "Pacific/Auckland",
  br: "America/Sao_Paulo", mx: "America/Mexico_City",
};

function norm(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}

function isUS(country: string): boolean {
  return ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"].includes(country);
}
function isCA(country: string): boolean {
  return ["ca", "can", "canada"].includes(country);
}

/**
 * Resolve a lead's IANA timezone from city/state/country, falling back to the
 * workspace timezone when unknown. city is currently unused (state/country are
 * enough for a representative zone); it's accepted for a future finer pass.
 */
export function resolveLeadTimezone(
  lead: { city?: string | null; state?: string | null; country?: string | null },
  fallbackTimezone: string,
): string {
  const country = norm(lead.country);
  const stateRaw = norm(lead.state);

  // US: prefer state.
  if (isUS(country) || (!country && US_STATE_TZ[stateRaw.toUpperCase()])) {
    const code = stateRaw.length === 2 ? stateRaw.toUpperCase() : US_STATE_NAMES[stateRaw];
    if (code && US_STATE_TZ[code]) return US_STATE_TZ[code];
    if (isUS(country)) return "America/New_York";
  }

  // Canada: prefer province.
  if (isCA(country)) {
    const code = stateRaw.length === 2 ? stateRaw.toUpperCase() : CA_PROVINCE_NAMES[stateRaw];
    if (code && CA_PROVINCE_TZ[code]) return CA_PROVINCE_TZ[code];
    return "America/Toronto";
  }

  // Other countries.
  if (country && COUNTRY_TZ[country]) return COUNTRY_TZ[country];

  return fallbackTimezone;
}
