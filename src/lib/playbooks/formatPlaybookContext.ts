import type { Playbook } from "./registry";

const MAX_CONTEXT_CHARS = 1200;

function trimBlock(text: string, max: number = MAX_CONTEXT_CHARS): string {
  const cleaned = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max - 3) + '...' : cleaned;
}

export function formatPlaybookContext(playbook: Playbook): string {
  const lines: string[] = ["=== INDUSTRY PLAYBOOK ===", `Industry: ${playbook.label}`];
  const seen = new Set<string>();
  const addLine = (line: string) => {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (trimmed && !seen.has(trimmed)) { seen.add(trimmed); lines.push(trimmed); }
  };

  addLine("Tone Guidelines:");
  addLine(`- Voice: ${playbook.tone_profile.voice}`);
  playbook.tone_profile.do.forEach(d => addLine(`- Do: ${d}`));
  playbook.tone_profile.dont.forEach(d => addLine(`- Don't: ${d}`));

  if (playbook.common_objections.length > 0) {
    addLine("Common Objections:");
    playbook.common_objections.forEach(o => addLine(`- ${o.name} → ${o.guidance}`));
  }

  if (playbook.buying_signals.length > 0) {
    addLine("Buying Signals:");
    playbook.buying_signals.forEach(s => addLine(`- ${s}`));
  }

  if (playbook.red_flags.length > 0) {
    addLine("Red Flags:");
    playbook.red_flags.forEach(f => addLine(`- ${f}`));
  }

  if (playbook.compliance_rules && playbook.compliance_rules.length > 0) {
    addLine("Compliance Rules:");
    playbook.compliance_rules.forEach(r => addLine(`- ${r}`));
  }

  return trimBlock(lines.join("\n"));
}
