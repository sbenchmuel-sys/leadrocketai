import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Briefcase, Code2, HeartPulse, Home, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { getAllPlaybooks } from "@/lib/playbooks/registry";

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

      // Save to onboarding_config
      await (supabase as any)
        .from("onboarding_config")
        .upsert(
          { user_id: user.id, industry_playbook_id: selected },
          { onConflict: "user_id" }
        );

      // If workspace_profiles exists, update it too
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
    <div className="flex flex-col items-center text-center space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-foreground">Choose Your Playbook</h1>
        <p className="text-muted-foreground max-w-md">
          Select the sales motion that best fits your business. This shapes AI tone, objection handling, and cadence.
        </p>
      </div>

      <div className="grid gap-3 w-full max-w-sm">
        {playbooks.map((pb) => {
          const isSelected = selected === pb.id;
          return (
            <Card
              key={pb.id}
              onClick={() => setSelected(pb.id)}
              className={`relative cursor-pointer p-4 transition-all border-2 ${
                isSelected
                  ? "border-primary bg-primary/5"
                  : "border-transparent hover:border-muted-foreground/20"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg ${isSelected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                  {ICON_MAP[pb.id] || <Briefcase className="h-6 w-6" />}
                </div>
                <div className="text-left flex-1">
                  <p className="font-medium text-foreground">{pb.label}</p>
                  <p className="text-sm text-muted-foreground">{pb.description}</p>
                </div>
                {isSelected && (
                  <Check className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <Button
        size="lg"
        onClick={handleContinue}
        disabled={!selected || saving}
        className="w-full max-w-sm"
      >
        {saving ? "Saving..." : "Continue"}
      </Button>
    </div>
  );
}
