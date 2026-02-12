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
    description: "Universal playbook for any B2B sales motion.",
    tone_profile: {
      voice: "Professional, consultative, concise",
      do: ["Personalize to prospect's role", "Lead with value", "One CTA per message"],
      dont: ["Over-promise", "Use filler phrases", "Send walls of text"],
    },
    common_objections: [
      { name: "No budget", guidance: "Explore ROI framing; offer pilot or phased rollout." },
      { name: "Already have a solution", guidance: "Ask what's working vs. not; position as complement." },
      { name: "Not the right time", guidance: "Anchor to a trigger event or upcoming initiative." },
    ],
    buying_signals: [
      "Asks about pricing or packaging",
      "Involves additional stakeholders",
      "Requests a demo or trial",
    ],
    red_flags: [
      "Repeated no-shows",
      "Only junior contacts engaged",
      "Vague timelines with no sponsor",
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
