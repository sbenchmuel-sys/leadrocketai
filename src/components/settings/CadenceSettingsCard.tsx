import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Loader2, Clock, Shield, Calendar, Mail, X, Plus, AlertCircle, MessageSquare } from "lucide-react";
import { getCadenceSettings, updateCadenceSettings, CadenceSettingsV1 } from "@/lib/workspaceProfileQueries";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp } from "lucide-react";
import { WhatsAppCadenceSettings } from "@/lib/cadenceSettingsTypes";

// Helper component for editing day sequences as chips
function DaySequenceInput({
  value,
  onChange,
  label,
  maxItems = 8,
  minItems = 1






}: {value: number[];onChange: (val: number[]) => void;label: string;maxItems?: number;minItems?: number;}) {
  const [inputValue, setInputValue] = useState("");

  const addDay = () => {
    const num = parseInt(inputValue, 10);
    if (isNaN(num) || num <= 0) {
      toast.error("Please enter a positive number");
      return;
    }
    if (value.length >= maxItems) {
      toast.error(`Maximum ${maxItems} items allowed`);
      return;
    }
    onChange([...value, num]);
    setInputValue("");
  };

  const removeDay = (index: number) => {
    if (value.length <= minItems) {
      toast.error(`Minimum ${minItems} item(s) required`);
      return;
    }
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm">{label}</Label>
      <div className="flex flex-wrap gap-2 items-center">
        {value.map((day, idx) =>
        <Badge key={idx} variant="secondary" className="flex items-center gap-1 px-2 py-1">
            {day}d
            <button
            type="button"
            onClick={() => removeDay(idx)}
            className="ml-1 hover:text-destructive">

              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
        <div className="flex items-center gap-1">
          <Input
            type="number"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addDay())}
            placeholder="Add"
            className="w-16 h-7 text-sm"
            min={1} />

          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={addDay}
            className="h-7 w-7 p-0">

            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>);

}

// Helper component for hour sequence inputs
function HourSequenceInput({
  value,
  onChange,
  label,
  maxItems = 4





}: {value: number[];onChange: (val: number[]) => void;label: string;maxItems?: number;}) {
  const [inputValue, setInputValue] = useState("");

  const addHour = () => {
    const num = parseInt(inputValue, 10);
    if (isNaN(num) || num < 0) {
      toast.error("Please enter a non-negative number");
      return;
    }
    if (value.length >= maxItems) {
      toast.error(`Maximum ${maxItems} items allowed`);
      return;
    }
    onChange([...value, num]);
    setInputValue("");
  };

  const removeHour = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm">{label}</Label>
      <div className="flex flex-wrap gap-2 items-center">
        {value.map((hour, idx) =>
        <Badge key={idx} variant="secondary" className="flex items-center gap-1 px-2 py-1">
            {hour}h
            <button
            type="button"
            onClick={() => removeHour(idx)}
            className="ml-1 hover:text-destructive">

              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
        <div className="flex items-center gap-1">
          <Input
            type="number"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addHour())}
            placeholder="Add"
            className="w-16 h-7 text-sm"
            min={0} />

          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={addHour}
            className="h-7 w-7 p-0">

            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>);

}

// Visual sequence summary component — motion-based
function SequenceSummary({ settings, motion }: {settings: CadenceSettingsV1;motion: "outbound" | "inbound" | "nurture";}) {
  const wa = settings.whatsapp;

  if (motion === "nurture") {
    const cadences = settings.motions.nurture.cadences;
    return (
      <div className="p-3 border rounded-lg bg-muted/20 space-y-2 text-xs">
        <div className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
          Nurture — Cadence Profiles
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">Weekly: {cadences.weekly}d</Badge>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">Biweekly: {cadences.biweekly}d</Badge>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">Monthly: {cadences.monthly}d</Badge>
        </div>
      </div>);

  }

  const intervals = motion === "outbound" ?
  settings.motions.outbound.email_intervals_days :
  settings.motions.inbound.email_intervals_days;

  const stepLabels = motion === "outbound" ?
  ["Intro", "FU1", "FU2", "Breakup"] :
  ["Intro", "FU1", "FU2"];

  const waSteps = ["Intro", "Follow-up", "Nudge", "Pause"];
  const waIntervals = wa.outbound_followups_hours.map((h) => `${h}h`);

  const buildEmailFlow = () => {
    const parts: string[] = [];
    intervals.forEach((offset, i) => {
      if (i < stepLabels.length) {
        if (i > 0) parts.push(`${offset - intervals[i - 1]}d`);
        parts.push(stepLabels[i]);
      }
    });
    return parts;
  };

  const buildFlow = (steps: string[], ints: string[]) => {
    const parts: string[] = [];
    steps.forEach((step, i) => {
      parts.push(step);
      if (i < ints.length) parts.push(ints[i]);
    });
    return parts;
  };

  const emailFlow = buildEmailFlow();

  return (
    <div className="p-3 border rounded-lg bg-muted/20 space-y-2 text-xs">
      <div className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
        {motion === "outbound" ? "Outbound" : "Inbound"} — Active Sequences
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1 flex-wrap">
          <Mail className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="font-medium text-muted-foreground mr-1">Email:</span>
          {emailFlow.map((part, i) =>
          <span key={i}>
              {stepLabels.includes(part) ?
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">{part}</Badge> :

            <span className="text-muted-foreground mx-0.5">→ {part} →</span>
            }
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <MessageSquare className="h-3.5 w-3.5 text-green-600 shrink-0" />
          <span className="font-medium text-muted-foreground mr-1">WhatsApp:</span>
          {buildFlow(waSteps, waIntervals).map((part, i) =>
          <span key={i}>
              {waSteps.includes(part) ?
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-green-600/30">{part}</Badge> :

            <span className="text-muted-foreground mx-0.5">→ {part} →</span>
            }
            </span>
          )}
        </div>
      </div>
    </div>);

}

export function CadenceSettingsCard() {
  const [settings, setSettings] = useState<CadenceSettingsV1 | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState("motions");
  const [selectedMotion, setSelectedMotion] = useState<"outbound" | "inbound" | "nurture">("outbound");
  const [selectedChannel, setSelectedChannel] = useState<"email" | "whatsapp">("email");

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await getCadenceSettings();
      setSettings(data);
    } catch (err) {
      console.error("Failed to load cadence settings:", err);
      toast.error("Failed to load cadence settings");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;

    const { time_rules, guardrails } = settings;
    if (time_rules.send_window_local.start >= time_rules.send_window_local.end) {
      toast.error("Send window start must be before end");
      return;
    }
    if (guardrails.jitter_percent < 0 || guardrails.jitter_percent > 0.25) {
      toast.error("Jitter must be between 0% and 25%");
      return;
    }

    setIsSaving(true);
    try {
      await updateCadenceSettings(settings);
      toast.success("Cadence settings saved!");
    } catch (err) {
      console.error("Failed to save cadence settings:", err);
      toast.error("Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const updateMotionIntervals = (motion: "outbound" | "inbound", intervals: number[]) => {
    if (!settings) return;
    setSettings({
      ...settings,
      motions: {
        ...settings.motions,
        [motion]: { ...settings.motions[motion], email_intervals_days: intervals }
      }
    });
  };

  const updateNurtureCadence = (cadence: "weekly" | "biweekly" | "monthly", value: number) => {
    if (!settings) return;
    setSettings({
      ...settings,
      motions: {
        ...settings.motions,
        nurture: {
          ...settings.motions.nurture,
          cadences: { ...settings.motions.nurture.cadences, [cadence]: value }
        }
      }
    });
  };

  const updateWhatsAppSetting = <K extends keyof WhatsAppCadenceSettings,>(key: K, value: WhatsAppCadenceSettings[K]) => {
    if (!settings) return;
    setSettings({
      ...settings,
      whatsapp: { ...settings.whatsapp, [key]: value }
    });
  };

  const updateGuardrail = (key: keyof typeof settings.guardrails, value: unknown) => {
    if (!settings) return;
    setSettings({ ...settings, guardrails: { ...settings.guardrails, [key]: value } });
  };

  const updateTimeRule = (key: keyof typeof settings.time_rules, value: unknown) => {
    if (!settings) return;
    setSettings({ ...settings, time_rules: { ...settings.time_rules, [key]: value } });
  };

  const updateFlow = (flowKey: keyof typeof settings.flows, key: string, value: unknown) => {
    if (!settings) return;
    setSettings({
      ...settings,
      flows: { ...settings.flows, [flowKey]: { ...settings.flows[flowKey], [key]: value } }
    });
  };

  const updateFlowNurtureCadence = (cadence: "weekly" | "biweekly" | "monthly", value: number) => {
    if (!settings) return;
    setSettings({
      ...settings,
      flows: {
        ...settings.flows,
        nurture_campaigns: {
          ...settings.flows.nurture_campaigns,
          cadences_days: { ...settings.flows.nurture_campaigns.cadences_days, [cadence]: value }
        }
      }
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Sequence & Cadence Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>);

  }

  if (!settings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Sequence & Cadence Settings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Failed to load settings</p>
        </CardContent>
      </Card>);

  }

  return (
    <Card>
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CardHeader className="cursor-pointer" onClick={() => setIsExpanded(!isExpanded)}>
          















        </CardHeader>

        <CollapsibleContent>
          <CardContent className="space-y-6">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="motions" className="flex items-center gap-1">
                  <Mail className="h-4 w-4" />
                  <span className="hidden sm:inline">Motions</span>
                </TabsTrigger>
                <TabsTrigger value="guardrails" className="flex items-center gap-1">
                  <Shield className="h-4 w-4" />
                  <span className="hidden sm:inline">Guardrails</span>
                </TabsTrigger>
                <TabsTrigger value="time" className="flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  <span className="hidden sm:inline">Time</span>
                </TabsTrigger>
                <TabsTrigger value="campaigns" className="flex items-center gap-1">
                  <Mail className="h-4 w-4" />
                  <span className="hidden sm:inline">Campaigns</span>
                </TabsTrigger>
              </TabsList>

              {/* MOTIONS TAB */}
              <TabsContent value="motions" className="space-y-6 mt-4">
                {/* Visual Sequence Summary */}
                <SequenceSummary settings={settings} motion={selectedMotion} />

                {/* Motion Toggle */}
                <div className="flex items-center gap-2">
                  <Label>Motion:</Label>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={selectedMotion === "outbound" ? "default" : "outline"}
                      onClick={() => setSelectedMotion("outbound")}>

                      Outbound
                    </Button>
                    <Button
                      size="sm"
                      variant={selectedMotion === "inbound" ? "default" : "outline"}
                      onClick={() => setSelectedMotion("inbound")}>

                      Inbound
                    </Button>
                    <Button
                      size="sm"
                      variant={selectedMotion === "nurture" ? "default" : "outline"}
                      onClick={() => setSelectedMotion("nurture")}>

                      Nurture
                    </Button>
                  </div>
                </div>

                {/* Channel Sub-tabs (not for nurture) */}
                {selectedMotion !== "nurture" &&
                <div className="flex items-center gap-2">
                    <Label>Channel:</Label>
                    <div className="flex gap-2">
                      <Button
                      size="sm"
                      variant={selectedChannel === "email" ? "default" : "outline"}
                      onClick={() => setSelectedChannel("email")}
                      className="flex items-center gap-1">

                        <Mail className="h-3.5 w-3.5" />
                        Email
                      </Button>
                      <Button
                      size="sm"
                      variant={selectedChannel === "whatsapp" ? "default" : "outline"}
                      onClick={() => setSelectedChannel("whatsapp")}
                      className="flex items-center gap-1">

                        <MessageSquare className="h-3.5 w-3.5" />
                        WhatsApp
                      </Button>
                    </div>
                  </div>
                }

                {/* Outbound / Inbound Email Settings */}
                {selectedMotion !== "nurture" && selectedChannel === "email" &&
                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                    <h4 className="font-medium text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      {selectedMotion === "outbound" ? "Outbound" : "Inbound"} — Email Intervals
                    </h4>

                    <DaySequenceInput
                    value={settings.motions[selectedMotion].email_intervals_days}
                    onChange={(val) => updateMotionIntervals(selectedMotion as "outbound" | "inbound", val)}
                    label="Step offsets from first send (cumulative days)"
                    maxItems={8}
                    minItems={1} />


                    <p className="text-xs text-muted-foreground">
                      Each value is the day offset from the first email. E.g., [0, 2, 4, 7] means: send intro immediately, follow-up 1 at day 2, follow-up 2 at day 4, breakup at day 7.
                    </p>
                  </div>
                }

                {/* Nurture Settings */}
                {selectedMotion === "nurture" &&
                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                    <h4 className="font-medium text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      Nurture — Cadence Profiles
                    </h4>

                    <p className="text-xs text-muted-foreground">
                      Each lead in nurture mode uses one of these cadence profiles. The interval defines days between nurture emails.
                    </p>

                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <Label>Weekly (days)</Label>
                        <Input
                        type="number"
                        value={settings.motions.nurture.cadences.weekly}
                        onChange={(e) => updateNurtureCadence("weekly", parseInt(e.target.value, 10) || 7)}
                        min={1}
                        className="w-20" />

                      </div>
                      <div className="space-y-2">
                        <Label>Biweekly (days)</Label>
                        <Input
                        type="number"
                        value={settings.motions.nurture.cadences.biweekly}
                        onChange={(e) => updateNurtureCadence("biweekly", parseInt(e.target.value, 10) || 14)}
                        min={1}
                        className="w-20" />

                      </div>
                      <div className="space-y-2">
                        <Label>Monthly (days)</Label>
                        <Input
                        type="number"
                        value={settings.motions.nurture.cadences.monthly}
                        onChange={(e) => updateNurtureCadence("monthly", parseInt(e.target.value, 10) || 30)}
                        min={1}
                        className="w-20" />

                      </div>
                    </div>
                  </div>
                }

                {/* WhatsApp Channel */}
                {selectedMotion !== "nurture" && selectedChannel === "whatsapp" &&
                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                    <h4 className="font-medium text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                      <MessageSquare className="h-4 w-4 text-green-600" />
                      {selectedMotion === "outbound" ? "Outbound" : "Inbound"} — WhatsApp
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      WhatsApp uses conversational nudges — shorter, lighter cadences than email.
                    </p>

                    <HourSequenceInput
                    value={settings.whatsapp.outbound_followups_hours}
                    onChange={(val) => updateWhatsAppSetting("outbound_followups_hours", val)}
                    label="Outbound Follow-up Intervals (hours)"
                    maxItems={5} />


                    <div className="space-y-2">
                      <Label>Max messages before pause</Label>
                      <Input
                      type="number"
                      value={settings.whatsapp.max_messages_before_pause}
                      onChange={(e) =>
                      updateWhatsAppSetting("max_messages_before_pause", parseInt(e.target.value, 10) || 1)
                      }
                      min={1}
                      max={10}
                      className="w-24" />

                      <p className="text-xs text-muted-foreground">
                        Auto-pause WhatsApp sequence after this many unanswered messages
                      </p>
                    </div>

                    <Separator />

                    <HourSequenceInput
                    value={settings.whatsapp.post_meeting_hours}
                    onChange={(val) => updateWhatsAppSetting("post_meeting_hours", val)}
                    label="Post-Meeting Nudge Timing (hours)"
                    maxItems={4} />


                    <Separator />

                    <div className="flex items-center justify-between">
                      <div>
                        <Label>Automation enabled</Label>
                        <p className="text-xs text-muted-foreground">
                          WhatsApp is manual-only for now
                        </p>
                      </div>
                      <Switch
                      checked={settings.whatsapp.automation_enabled}
                      onCheckedChange={(checked) => updateWhatsAppSetting("automation_enabled", checked)} />

                    </div>
                  </div>
                }
              </TabsContent>

              {/* GUARDRAILS TAB */}
              <TabsContent value="guardrails" className="space-y-6 mt-4">
                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                  <div className="flex items-center gap-2 text-sm text-warning">
                    <AlertCircle className="h-4 w-4" />
                    <span>These limits prevent over-emailing and protect sender reputation</span>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Minimum gap between emails (hours)</Label>
                      <Input
                        type="number"
                        value={settings.guardrails.min_gap_hours_between_emails}
                        onChange={(e) =>
                        updateGuardrail("min_gap_hours_between_emails", parseInt(e.target.value, 10) || 1)
                        }
                        min={1}
                        className="w-24" />

                    </div>

                    <div className="space-y-2">
                      <Label>Max emails per lead (7 days)</Label>
                      <Input
                        type="number"
                        value={settings.guardrails.max_emails_per_lead_per_7d}
                        onChange={(e) =>
                        updateGuardrail("max_emails_per_lead_per_7d", parseInt(e.target.value, 10) || 1)
                        }
                        min={1}
                        className="w-24" />

                    </div>

                    <div className="space-y-2">
                      <Label>Max emails per lead (30 days)</Label>
                      <Input
                        type="number"
                        value={settings.guardrails.max_emails_per_lead_per_30d}
                        onChange={(e) =>
                        updateGuardrail("max_emails_per_lead_per_30d", parseInt(e.target.value, 10) || 1)
                        }
                        min={1}
                        className="w-24" />

                    </div>
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Allow same-day sends</Label>
                      <p className="text-xs text-muted-foreground">
                        Whether to allow multiple emails to the same lead on the same day
                      </p>
                    </div>
                    <Switch
                      checked={settings.guardrails.same_day_send_allowed}
                      onCheckedChange={(checked) => updateGuardrail("same_day_send_allowed", checked)} />

                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Timing jitter: {Math.round(settings.guardrails.jitter_percent * 100)}%</Label>
                      <span className="text-xs text-muted-foreground">
                        Randomizes send times slightly to appear more natural
                      </span>
                    </div>
                    <Slider
                      value={[settings.guardrails.jitter_percent * 100]}
                      onValueChange={([val]) => updateGuardrail("jitter_percent", val / 100)}
                      min={0}
                      max={25}
                      step={1}
                      className="w-full" />

                  </div>
                </div>
              </TabsContent>

              {/* TIME RULES TAB */}
              <TabsContent value="time" className="space-y-6 mt-4">
                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Use business days only</Label>
                      <p className="text-xs text-muted-foreground">
                        Calculate intervals in business days (Mon-Fri)
                      </p>
                    </div>
                    <Switch
                      checked={settings.time_rules.use_business_days}
                      onCheckedChange={(checked) => updateTimeRule("use_business_days", checked)} />

                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Avoid weekends</Label>
                      <p className="text-xs text-muted-foreground">
                        Don't suggest sends on Saturday or Sunday
                      </p>
                    </div>
                    <Switch
                      checked={settings.time_rules.avoid_weekends}
                      onCheckedChange={(checked) => updateTimeRule("avoid_weekends", checked)} />

                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <Label>Send Window (local time)</Label>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2">
                        <Input
                          type="time"
                          value={settings.time_rules.send_window_local.start}
                          onChange={(e) =>
                          updateTimeRule("send_window_local", {
                            ...settings.time_rules.send_window_local,
                            start: e.target.value
                          })
                          }
                          className="w-32" />

                        <span className="text-muted-foreground">to</span>
                        <Input
                          type="time"
                          value={settings.time_rules.send_window_local.end}
                          onChange={(e) =>
                          updateTimeRule("send_window_local", {
                            ...settings.time_rules.send_window_local,
                            end: e.target.value
                          })
                          }
                          className="w-32" />

                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Suggestions will only be scheduled during this window
                    </p>
                  </div>
                </div>
              </TabsContent>

              {/* CAMPAIGNS TAB */}
              <TabsContent value="campaigns" className="space-y-6 mt-4">
                {/* Nurture Campaigns */}
                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium">Nurture Campaigns</h4>
                      <p className="text-xs text-muted-foreground">
                        Long-term engagement for stalled or cold leads
                      </p>
                    </div>
                    <Switch
                      checked={settings.flows.nurture_campaigns.enabled}
                      onCheckedChange={(checked) => updateFlow("nurture_campaigns", "enabled", checked)} />

                  </div>

                  {settings.flows.nurture_campaigns.enabled &&
                  <div className="space-y-4 pt-2">
                      <div className="grid grid-cols-3 gap-4">
                        <div className="space-y-2">
                          <Label>Weekly (days)</Label>
                          <Input
                          type="number"
                          value={settings.flows.nurture_campaigns.cadences_days.weekly}
                          onChange={(e) => updateFlowNurtureCadence("weekly", parseInt(e.target.value, 10) || 7)}
                          min={1}
                          className="w-20" />

                        </div>
                        <div className="space-y-2">
                          <Label>Biweekly (days)</Label>
                          <Input
                          type="number"
                          value={settings.flows.nurture_campaigns.cadences_days.biweekly}
                          onChange={(e) => updateFlowNurtureCadence("biweekly", parseInt(e.target.value, 10) || 14)}
                          min={1}
                          className="w-20" />

                        </div>
                        <div className="space-y-2">
                          <Label>Monthly (days)</Label>
                          <Input
                          type="number"
                          value={settings.flows.nurture_campaigns.cadences_days.monthly}
                          onChange={(e) => updateFlowNurtureCadence("monthly", parseInt(e.target.value, 10) || 30)}
                          min={1}
                          className="w-20" />

                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Min days after last touch</Label>
                        <Input
                        type="number"
                        value={settings.flows.nurture_campaigns.min_days_after_last_touch}
                        onChange={(e) =>
                        updateFlow("nurture_campaigns", "min_days_after_last_touch", parseInt(e.target.value, 10) || 1)
                        }
                        min={1}
                        className="w-24" />

                        <p className="text-xs text-muted-foreground">
                          Wait at least this many days after any email before sending nurture
                        </p>
                      </div>
                    </div>
                  }
                </div>

                {/* Re-engagement */}
                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium">Re-engagement</h4>
                      <p className="text-xs text-muted-foreground">
                        Auto-suggest re-engagement for leads gone quiet
                      </p>
                    </div>
                    <Switch
                      checked={settings.flows.reengagement.enabled}
                      onCheckedChange={(checked) => updateFlow("reengagement", "enabled", checked)} />

                  </div>

                  {settings.flows.reengagement.enabled &&
                  <div className="space-y-4 pt-2">
                      <div className="space-y-2">
                        <Label>After days of no contact</Label>
                        <Input
                        type="number"
                        value={settings.flows.reengagement.after_days_no_contact}
                        onChange={(e) =>
                        updateFlow("reengagement", "after_days_no_contact", parseInt(e.target.value, 10) || 30)
                        }
                        min={7}
                        className="w-24" />

                      </div>

                      <DaySequenceInput
                      value={settings.flows.reengagement.sequence_days}
                      onChange={(val) => updateFlow("reengagement", "sequence_days", val)}
                      label="Re-engagement Sequence (days)"
                      maxItems={4}
                      minItems={1} />

                    </div>
                  }
                </div>

                {/* Stop/Pause Rules */}
                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                  <h4 className="font-medium flex items-center gap-2">
                    <Shield className="h-4 w-4" />
                    Stop & Pause Rules
                  </h4>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Stop on any reply</Label>
                      <Switch
                        checked={settings.stop_pause_rules.stop_on_any_reply}
                        onCheckedChange={(checked) =>
                        setSettings({
                          ...settings,
                          stop_pause_rules: { ...settings.stop_pause_rules, stop_on_any_reply: checked }
                        })
                        } />

                    </div>
                    <div className="flex items-center justify-between">
                      <Label>Stop on negative reply</Label>
                      <Switch
                        checked={settings.stop_pause_rules.stop_on_negative_reply}
                        onCheckedChange={(checked) =>
                        setSettings({
                          ...settings,
                          stop_pause_rules: { ...settings.stop_pause_rules, stop_on_negative_reply: checked }
                        })
                        } />

                    </div>
                    <div className="flex items-center justify-between">
                      <Label>Stop on unsubscribe</Label>
                      <Switch
                        checked={settings.stop_pause_rules.stop_on_unsubscribe}
                        onCheckedChange={(checked) =>
                        setSettings({
                          ...settings,
                          stop_pause_rules: { ...settings.stop_pause_rules, stop_on_unsubscribe: checked }
                        })
                        } />

                    </div>
                    <div className="flex items-center justify-between">
                      <Label>Stop on bounce</Label>
                      <Switch
                        checked={settings.stop_pause_rules.stop_on_bounce}
                        onCheckedChange={(checked) =>
                        setSettings({
                          ...settings,
                          stop_pause_rules: { ...settings.stop_pause_rules, stop_on_bounce: checked }
                        })
                        } />

                    </div>
                    <div className="flex items-center justify-between">
                      <Label>Pause when meeting scheduled</Label>
                      <Switch
                        checked={settings.stop_pause_rules.pause_when_meeting_scheduled}
                        onCheckedChange={(checked) =>
                        setSettings({
                          ...settings,
                          stop_pause_rules: {
                            ...settings.stop_pause_rules,
                            pause_when_meeting_scheduled: checked
                          }
                        })
                        } />

                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            {/* Save Button */}
            <div className="flex justify-end pt-2">
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Settings
              </Button>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>);

}