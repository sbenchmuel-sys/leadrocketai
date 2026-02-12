import type { Playbook } from "./registry";

export function formatPlaybookContext(playbook: Playbook): string {
  const lines: string[] = ["=== INDUSTRY PLAYBOOK ===", `Industry: ${playbook.label}`];

  lines.push("Tone Guidelines:");
  lines.push(`- Voice: ${playbook.tone_profile.voice}`);
  playbook.tone_profile.do.forEach(d => lines.push(`- Do: ${d}`));
  playbook.tone_profile.dont.forEach(d => lines.push(`- Don't: ${d}`));

  if (playbook.common_objections.length > 0) {
    lines.push("Common Objections:");
    playbook.common_objections.forEach(o => lines.push(`- ${o.name} → ${o.guidance}`));
  }

  if (playbook.buying_signals.length > 0) {
    lines.push("Buying Signals:");
    playbook.buying_signals.forEach(s => lines.push(`- ${s}`));
  }

  if (playbook.red_flags.length > 0) {
    lines.push("Red Flags:");
    playbook.red_flags.forEach(f => lines.push(`- ${f}`));
  }

  if (playbook.compliance_rules && playbook.compliance_rules.length > 0) {
    lines.push("Compliance Rules:");
    playbook.compliance_rules.forEach(r => lines.push(`- ${r}`));
  }

  const result = lines.join("\n");
  return result.length > 1200 ? result.slice(0, 1197) + "..." : result;
}
