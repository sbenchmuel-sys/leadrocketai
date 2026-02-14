import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Briefcase, Code2, HeartPulse, Home, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { getAllPlaybooks } from "@/lib/playbooks/registry";
import { DEFAULT_CADENCE_SETTINGS } from "@/lib/cadenceSettingsTypes";
import { cn } from "@/lib/utils";

interface ChoosePlaybookStepProps {
  onNext: () => void;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  general_sales: <Briefcase className="h-6 w-6" />,
  b2b_saas: <Code2 className="h-6 w-6" />,
  medical_device_rep: <HeartPulse className="h-6 w-6" />,
  real_estate: <Home className="h-6 w-6" />,
};

export default function ChoosePlaybookStep({ onNext }: ChoosePlaybookStepProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const playbooks = getAllPlaybooks();

  async function handleContinue() {
    if (!selected) return;
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not logged in");

      await (supabase as any)
        .from("onboarding_config")
        .upsert(
          { user_id: user.id, industry_playbook_id: selected },
          { onConflict: "user_id" }
        );

      const { data: wp } = await (supabase as any)
        .from("workspace_profiles")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (wp) {
        await (supabase as any)
          .from("workspace_profiles")
          .update({ industry_playbook_id: selected })
          .eq("user_id", user.id);
      } else {
        await (supabase as any)
          .from("workspace_profiles")
          .insert({
            user_id: user.id,
            industry_playbook_id: selected,
            meeting_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            cadence_settings: DEFAULT_CADENCE_SETTINGS,
          });
      }

      onNext();
    } catch (err) {
      console.error("Failed to save playbook selection:", err);
      toast.error("Failed to save selection");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col items-center text-center space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold text-foreground tracking-tight">Choose Your Playbook</h1>
        <p className="text-muted-foreground max-w-md text-[15px] leading-relaxed">
          Configure how your AI assistant thinks, writes, and follows up.
        </p>
      </div>

      <div className="grid gap-4 w-full max-w-sm">
        {playbooks.map((pb) => {
          const isSelected = selected === pb.id;
          return (
            <button
              key={pb.id}
              type="button"
              onClick={() => setSelected(pb.id)}
              className={cn(
                "relative flex items-start gap-4 p-5 rounded-2xl border text-left transition-all duration-200 cursor-pointer",
                "bg-card hover:bg-accent/30",
                isSelected
                  ? "border-primary/40 shadow-[0_0_24px_hsl(217_91%_60%/0.12)]"
                  : "border-border hover:border-muted-foreground/20"
              )}
            >
              {/* Left accent line */}
              {isSelected && (
                <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-primary" />
              )}

              <div className={cn(
                "p-2.5 rounded-xl shrink-0 transition-colors",
                isSelected ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
              )}>
                {ICON_MAP[pb.id] || <Briefcase className="h-6 w-6" />}
              </div>

              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground text-[15px]">{pb.label}</p>
                <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">{pb.description}</p>
              </div>

              {isSelected && (
                <div className="shrink-0 mt-0.5">
                  <div className="h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                    <Check className="h-3 w-3 text-primary-foreground" />
                  </div>
                </div>
              )}
            </button>
          );
        })}
      </div>

      <Button
        size="lg"
        onClick={handleContinue}
        disabled={!selected || saving}
        className="w-full max-w-sm h-12 text-[15px] font-medium"
      >
        {saving ? "Saving..." : "Continue"}
      </Button>
    </div>
  );
}
