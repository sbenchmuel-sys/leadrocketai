// Removes the "Best,\nMike" sign-off the AI generates per prompt instructions.
// Must run before the real signature block is appended to avoid duplication.
// Moved verbatim from automation-executor/index.ts (infra/p0-harness) so it can
// be unit-tested (src/lib/__tests__/stripAISignOff.test.ts). Pure module.
export function stripAISignOff(body: string): string {
  const pattern = /\n\n(?:Best regards?|Best|Thanks|Thank you|Kind regards?|Warm regards?|Regards|Cheers|Sincerely),?\s*\n[^\n]{1,40}\s*$/i;
  return body.replace(pattern, "").trimEnd();
}
