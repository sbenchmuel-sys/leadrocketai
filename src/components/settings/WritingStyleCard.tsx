import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { toast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type Channel = "email" | "sms" | "whatsapp";

interface StyleProfile {
  channel: string;
  motion_type: string;
  profile_json: Record<string, unknown>;
  example_count: number;
  last_synthesized_at: string;
}

export function WritingStyleCard() {
  const { workspaceId } = useWorkspace();
  const [directiveText, setDirectiveText] = useState("");
  const [learningPaused, setLearningPaused] = useState(false);
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [exampleCounts, setExampleCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<Channel>("email");

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const [directiveRes, profilesRes, countsRes] = await Promise.all([
        supabase.from("user_style_directives").select("*").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_style_profiles").select("*").eq("user_id", user.id),
        supabase.from("style_examples").select("channel", { count: "exact", head: false }).eq("user_id", user.id),
      ]);

      if (directiveRes.data) {
        setDirectiveText(directiveRes.data.directive_text || "");
        setLearningPaused(directiveRes.data.learning_paused || false);
      }

      if (profilesRes.data) {
        setProfiles(profilesRes.data as StyleProfile[]);
      }

      // Count examples per channel
      if (countsRes.data) {
        const counts: Record<string, number> = {};
        for (const row of countsRes.data) {
          const ch = (row as any).channel || "email";
          counts[ch] = (counts[ch] || 0) + 1;
        }
        setExampleCounts(counts);
      }
    } catch (err) {
      console.error("[WritingStyleCard] Load error:", err);
    } finally {
      setLoading(false);
    }
  };

  const saveDirective = async () => {
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !workspaceId) return;

      const { error } = await supabase.from("user_style_directives").upsert({
        user_id: user.id,
        workspace_id: workspaceId,
        directive_text: directiveText,
        learning_paused: learningPaused,
      }, { onConflict: "user_id" });

      if (error) throw error;
      toast({ title: "Saved", description: "Your writing style preferences have been updated." });
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      await Promise.all([
        supabase.from("style_examples").delete().eq("user_id", user.id),
        supabase.from("user_style_profiles").delete().eq("user_id", user.id),
      ]);

      setProfiles([]);
      setExampleCounts({});
      toast({ title: "Style reset", description: "All learned patterns have been cleared. Starting fresh." });
    } catch (err: any) {
      toast({ title: "Reset failed", description: err.message, variant: "destructive" });
    }
  };

  const togglePause = async (paused: boolean) => {
    setLearningPaused(paused);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !workspaceId) return;

      await supabase.from("user_style_directives").upsert({
        user_id: user.id,
        workspace_id: workspaceId,
        directive_text: directiveText,
        learning_paused: paused,
      }, { onConflict: "user_id" });
    } catch (err) {
      console.error("[WritingStyleCard] Pause toggle error:", err);
    }
  };

  const channelProfiles = profiles.filter((p) => p.channel === activeTab);
  const totalExamples = Object.values(exampleCounts).reduce((a, b) => a + b, 0);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              Writing Style
            </CardTitle>
            <CardDescription>
              The AI learns your writing style from sent messages and feedback.
              {totalExamples > 0 && (
                <span className="ml-1">
                  {totalExamples} messages learned ({exampleCounts.email || 0} email, {exampleCounts.whatsapp || 0} WhatsApp, {exampleCounts.sms || 0} SMS)
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="pause-learning" className="text-xs text-muted-foreground">
              {learningPaused ? "Paused" : "Active"}
            </Label>
            <Switch
              id="pause-learning"
              checked={!learningPaused}
              onCheckedChange={(checked) => togglePause(!checked)}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Voice directive */}
        <div className="space-y-2">
          <Label>Your voice directive</Label>
          <Textarea
            value={directiveText}
            onChange={(e) => setDirectiveText(e.target.value)}
            placeholder="Describe your writing style (e.g., 'I write like a busy founder — no fluff, always direct')"
            className="min-h-[60px] text-sm"
            rows={2}
          />
          <Button size="sm" onClick={saveDirective} disabled={saving}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Save
          </Button>
        </div>

        {/* Channel tabs with detected traits */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Channel)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="email">Email</TabsTrigger>
            <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
            <TabsTrigger value="sms">SMS</TabsTrigger>
          </TabsList>

          {(["email", "whatsapp", "sms"] as Channel[]).map((ch) => (
            <TabsContent key={ch} value={ch} className="space-y-3">
              {profiles.filter((p) => p.channel === ch).length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No style profile yet for {ch}. Send at least 5 messages to start learning.
                </p>
              ) : (
                profiles
                  .filter((p) => p.channel === ch)
                  .map((p) => (
                    <div key={`${p.channel}-${p.motion_type}`} className="border rounded-md p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium capitalize">
                          {p.motion_type.replace(/_/g, " ")}
                        </span>
                        <Badge variant="secondary" className="text-[10px]">
                          {p.example_count} examples
                        </Badge>
                      </div>
                      <div className="grid gap-1">
                        {Object.entries(p.profile_json)
                          .filter(([k]) => !["confidence"].includes(k))
                          .map(([key, value]) => (
                            <div key={key} className="flex gap-2 text-xs">
                              <span className="text-muted-foreground min-w-[100px] capitalize">
                                {key.replace(/_/g, " ")}:
                              </span>
                              <span className="text-foreground">
                                {Array.isArray(value) ? value.join(", ") : String(value)}
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))
              )}
            </TabsContent>
          ))}
        </Tabs>

        {/* Reset */}
        <div className="pt-2 border-t">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                <RotateCcw className="h-3 w-3 mr-1" />
                Reset all learned styles
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset writing style?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete all learned style patterns and examples across all channels. The AI will start learning from scratch.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleReset}>Reset</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
