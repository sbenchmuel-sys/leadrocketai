import { differenceInDays, parseISO } from "date-fns";
import type { EnrichedLead } from "@/lib/dashboardUtils";
import { getActionType } from "@/lib/dashboardUtils";
import type { TabFilters, NextActionGroup } from "@/lib/dashboardStateCache";

function isAutomationOn(lead: EnrichedLead): boolean {
  const hasSeq = !!(lead as any).eligible_at && lead.needs_action;
  const hasNurtureAuto = (lead as any).nurture_mode === "auto" && (lead as any).nurture_status === "active";
  return hasSeq || hasNurtureAuto;
}

function actionGroupOf(lead: EnrichedLead): NextActionGroup {
  if (!lead.needs_action || !lead.next_action_key) return "none";
  const t = getActionType(lead.next_action_key);
  if (t === "reply") return "reply";
  if (t === "follow_up") return "follow_up";
  if (t === "recap") return "recap";
  if (t === "nurture") return "nurture";
  if (t === "closing") return "closing";
  return "none";
}

export function applyLeadFilters(leads: EnrichedLead[], f: TabFilters): EnrichedLead[] {
  const now = Date.now();
  return leads.filter((lead) => {
    // Phase
    if (f.phases.length > 0 && !f.phases.includes(lead.displayPhase)) return false;

    // Activity
    if (f.activity !== "all") {
      const inT = lead.last_inbound_at ? new Date(lead.last_inbound_at).getTime() : 0;
      const outT = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0;
      const lastActT = lead.last_activity_at ? new Date(lead.last_activity_at).getTime() : 0;
      const sevenDays = 7 * 86400 * 1000;

      if (f.activity === "recent_inbound") {
        if (!(inT > 0 && now - inT <= sevenDays && inT > outT)) return false;
      } else if (f.activity === "recent_outbound") {
        if (!(outT > 0 && now - outT <= sevenDays && outT >= inT)) return false;
      } else if (f.activity === "stale") {
        if (!lastActT) {
          // never contacted but old enough
          if (lead.created_at) {
            const daysCreated = differenceInDays(new Date(), parseISO(lead.created_at));
            if (daysCreated <= 14) return false;
          } else return false;
        } else {
          if ((now - lastActT) / 86400000 <= 14) return false;
        }
      } else if (f.activity === "never") {
        if ((lead as any).first_outbound_at || lead.last_inbound_at) return false;
      }
    }

    // Next Action
    if (f.nextActions.length > 0 && !f.nextActions.includes(actionGroupOf(lead))) return false;

    // Automation
    if (f.automation !== "all") {
      const on = isAutomationOn(lead);
      if (f.automation === "on" && !on) return false;
      if (f.automation === "off" && on) return false;
    }

    return true;
  });
}
