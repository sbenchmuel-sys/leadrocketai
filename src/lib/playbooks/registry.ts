// ============================================
// INDUSTRY PLAYBOOK REGISTRY
// ============================================

export interface ToneProfile {
  voice: string;
  do: string[];
  dont: string[];
}

export interface Objection {
  name: string;
  guidance: string;
}

export interface Playbook {
  id: string;
  label: string;
  description: string;
  tone_profile: ToneProfile;
  common_objections: Objection[];
  buying_signals: string[];
  red_flags: string[];
  compliance_rules?: string[];
}

// ============================================
// PLAYBOOK DEFINITIONS
// ============================================

const PLAYBOOKS: Playbook[] = [
  {
    id: "general_sales",
    label: "General B2B Sales",
    description: "Professional B2B sales assistant focused on clarity, value, and momentum.",
    tone_profile: {
      voice: "Clear, helpful, direct, non-pushy",
      do: [
        "Focus on outcomes, not features",
        "Keep emails concise",
        "End with a specific next step",
        "Personalize lightly but meaningfully",
      ],
      dont: [
        "Use hype language",
        "Overpromise",
        "Create aggressive urgency",
        "Use buzzword-heavy phrasing",
      ],
    },
    common_objections: [
      { name: "Not interested", guidance: "Acknowledge respectfully, reframe value briefly, leave door open." },
      { name: "Too busy", guidance: "Offer short async summary or 10-15 min call." },
      { name: "Send more info", guidance: "Provide concise summary and propose a next step." },
      { name: "Budget concern", guidance: "Reframe in ROI or cost-of-inaction terms." },
    ],
    buying_signals: [
      "Pricing questions",
      "Timeline mentions",
      "Looping in a colleague",
      "Implementation questions",
    ],
    red_flags: [
      "Repeated vague responses",
      "No decision-maker identified",
      "Long silence after proposal",
    ],
    compliance_rules: [
      "When objection is detected: do not argue, acknowledge first, provide one focused response, offer low-friction next step",
    ],
  },
  {
    id: "b2b_saas",
    label: "B2B SaaS",
    description: "Playbook for software-as-a-service deals with technical buyers.",
    tone_profile: {
      voice: "Knowledgeable, direct, outcome-driven",
      do: ["Reference integrations and workflows", "Quantify time/cost savings", "Offer sandbox access"],
      dont: ["Use vague ROI claims", "Ignore technical questions", "Skip security topics"],
    },
    common_objections: [
      { name: "Security concerns", guidance: "Share SOC2/compliance docs; offer security review call." },
      { name: "Integration complexity", guidance: "Highlight API docs, pre-built connectors, onboarding support." },
      { name: "Too many tools already", guidance: "Show consolidation value; map to their existing stack." },
    ],
    buying_signals: [
      "Asks about API or integrations",
      "Requests SOC2 or security documentation",
      "Shares internal evaluation timeline",
    ],
    red_flags: [
      "No technical evaluator involved",
      "Refuses to share current stack",
      "Procurement stalls after verbal yes",
    ],
  },
  {
    id: "medical_device_rep",
    label: "Medical Device Sales",
    description: "Playbook for regulated medical/health-tech sales with compliance constraints.",
    tone_profile: {
      voice: "Credible, patient, evidence-based",
      do: ["Cite published evidence", "Respect clinical workflows", "Acknowledge regulatory context"],
      dont: ["Make clinical outcome claims", "Rush decision timelines", "Bypass compliance stakeholders"],
    },
    common_objections: [
      { name: "Regulatory approval", guidance: "Share clearance status and relevant certifications upfront." },
      { name: "Clinical validation", guidance: "Provide peer-reviewed studies or pilot data." },
      { name: "Budget cycle timing", guidance: "Align with fiscal year; offer evaluation agreement." },
    ],
    buying_signals: [
      "Asks for clinical evidence or white papers",
      "Introduces compliance or procurement team",
      "Discusses implementation timeline",
    ],
    red_flags: [
      "No clinical champion identified",
      "Compliance team unaware of evaluation",
      "Requests off-label use information",
    ],
    compliance_rules: [
      "Never claim clinical outcomes without published evidence",
      "Do not compare to competitor devices without approved data",
      "All pricing must go through formal quote process",
    ],
  },
  {
    id: "real_estate",
    label: "Real Estate Agent",
    description: "Playbook for residential and commercial real estate sales.",
    tone_profile: {
      voice: "Warm, local-expert, responsive",
      do: ["Reference neighborhood specifics", "Respond quickly to inquiries", "Highlight lifestyle fit"],
      dont: ["Pressure urgency artificially", "Guarantee appreciation", "Skip disclosure requirements"],
    },
    common_objections: [
      { name: "Price too high", guidance: "Provide comps and market trend data." },
      { name: "Bad timing", guidance: "Share rate forecasts; offer to set alerts." },
      { name: "Want to see more options", guidance: "Curate a focused shortlist matching criteria." },
    ],
    buying_signals: [
      "Asks about mortgage pre-approval",
      "Requests second showing",
      "Brings family to viewing",
    ],
    red_flags: [
      "No pre-approval after multiple showings",
      "Keeps expanding search criteria",
      "Unresponsive after offer discussion",
    ],
  },
];

// ============================================
// LOOKUP
// ============================================

const PLAYBOOK_MAP = new Map(PLAYBOOKS.map(p => [p.id, p]));

export function getPlaybookById(id: string): Playbook {
  return PLAYBOOK_MAP.get(id) || PLAYBOOK_MAP.get("general_sales")!;
}

export function getAllPlaybooks(): Playbook[] {
  return PLAYBOOKS;
}
