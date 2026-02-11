// AutomationPreviewCard — Phase 6: Automation OFF by default.
// This card is intentionally disabled. Nothing auto-sends unless automation
// is explicitly enabled in a future phase.

import type { LeadDetail } from "@/lib/supabaseQueries";

interface AutomationPreviewCardProps {
  lead: LeadDetail;
  onUpdate: () => void;
}

export default function AutomationPreviewCard(_props: AutomationPreviewCardProps) {
  // Phase 6: Automation OFF by default — card is hidden.
  // When automation is enabled in a future phase, this component will
  // render the scheduled steps and allow pause/resume/preview.
  return null;
}
