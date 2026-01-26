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
import { Loader2, Clock, Shield, Calendar, Mail, X, Plus, AlertCircle } from "lucide-react";
import { getCadenceSettings, updateCadenceSettings, CadenceSettingsV1 } from "@/lib/workspaceProfileQueries";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp } from "lucide-react";

// Helper component for editing day sequences as chips
function DaySequenceInput({
  value,
  onChange,
  label,
  maxItems = 8,
  minItems = 1,
}: {
  value: number[];
  onChange: (val: number[]) => void;
  label: string;
  maxItems?: number;
  minItems?: number;
}) {
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
        {value.map((day, idx) => (
          <Badge key={idx} variant="secondary" className="flex items-center gap-1 px-2 py-1">
            {day} days
            <button
              type="button"
              onClick={() => removeDay(idx)}
              className="ml-1 hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <div className="flex items-center gap-1">
          <Input
            type="number"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addDay())}
            placeholder="Add"
            className="w-16 h-7 text-sm"
            min={1}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={addDay}
            className="h-7 w-7 p-0"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// Helper component for hour sequence inputs
function HourSequenceInput({
  value,
  onChange,
  label,
  maxItems = 4,
}: {
  value: number[];
  onChange: (val: number[]) => void;
  label: string;
  maxItems?: number;
}) {
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
        {value.map((hour, idx) => (
          <Badge key={idx} variant="secondary" className="flex items-center gap-1 px-2 py-1">
            {hour}h
            <button
              type="button"
              onClick={() => removeHour(idx)}
              className="ml-1 hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <div className="flex items-center gap-1">
          <Input
            type="number"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addHour())}
            placeholder="Add"
            className="w-16 h-7 text-sm"
            min={0}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={addHour}
            className="h-7 w-7 p-0"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function CadenceSettingsCard() {
  const [settings, setSettings] = useState<CadenceSettingsV1 | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState("modes");
  const [selectedMode, setSelectedMode] = useState<"fast" | "nurture">("fast");

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

    // Validation
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

  const updateModeSettings = (mode: "fast" | "nurture", key: string, value: unknown) => {
    if (!settings) return;
    setSettings({
      ...settings,
      modes: {
        ...settings.modes,
        [mode]: {
          ...settings.modes[mode],
          [key]: value,
        },
      },
    });
  };

  const updateBreakupTrigger = (mode: "fast" | "nurture", key: string, value: number) => {
    if (!settings) return;
    setSettings({
      ...settings,
      modes: {
        ...settings.modes,
        [mode]: {
          ...settings.modes[mode],
          breakup_trigger: {
            ...settings.modes[mode].breakup_trigger,
            [key]: value,
          },
        },
      },
    });
  };

  const updatePostMeeting = (mode: "fast" | "nurture", key: string, value: unknown) => {
    if (!settings) return;
    setSettings({
      ...settings,
      modes: {
        ...settings.modes,
        [mode]: {
          ...settings.modes[mode],
          post_meeting: {
            ...settings.modes[mode].post_meeting,
            [key]: value,
          },
        },
      },
    });
  };

  const updateGuardrail = (key: keyof typeof settings.guardrails, value: unknown) => {
    if (!settings) return;
    setSettings({
      ...settings,
      guardrails: {
        ...settings.guardrails,
        [key]: value,
      },
    });
  };

  const updateTimeRule = (key: keyof typeof settings.time_rules, value: unknown) => {
    if (!settings) return;
    setSettings({
      ...settings,
      time_rules: {
        ...settings.time_rules,
        [key]: value,
      },
    });
  };

  const updateFlow = (
    flowKey: keyof typeof settings.flows,
    key: string,
    value: unknown
  ) => {
    if (!settings) return;
    setSettings({
      ...settings,
      flows: {
        ...settings.flows,
        [flowKey]: {
          ...settings.flows[flowKey],
          [key]: value,
        },
      },
    });
  };

  const updateNurtureCadence = (cadence: "weekly" | "biweekly" | "monthly", value: number) => {
    if (!settings) return;
    setSettings({
      ...settings,
      flows: {
        ...settings.flows,
        nurture_campaigns: {
          ...settings.flows.nurture_campaigns,
          cadences_days: {
            ...settings.flows.nurture_campaigns.cadences_days,
            [cadence]: value,
          },
        },
      },
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Email Cadence Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!settings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Email Cadence Settings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Failed to load settings</p>
        </CardContent>
      </Card>
    );
  }

  const currentMode = settings.modes[selectedMode];

  return (
    <Card>
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CardHeader className="cursor-pointer" onClick={() => setIsExpanded(!isExpanded)}>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Email Cadence Settings
              </CardTitle>
              <CardDescription>
                Configure timing for email suggestions and follow-ups
              </CardDescription>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </CollapsibleTrigger>
          </div>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="space-y-6">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="modes" className="flex items-center gap-1">
                  <Mail className="h-4 w-4" />
                  <span className="hidden sm:inline">Modes</span>
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

              {/* MODES TAB */}
              <TabsContent value="modes" className="space-y-6 mt-4">
                <div className="flex items-center gap-2 mb-4">
                  <Label>Editing Mode:</Label>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={selectedMode === "fast" ? "default" : "outline"}
                      onClick={() => setSelectedMode("fast")}
                    >
                      Fast
                    </Button>
                    <Button
                      size="sm"
                      variant={selectedMode === "nurture" ? "default" : "outline"}
                      onClick={() => setSelectedMode("nurture")}
                    >
                      Nurture
                    </Button>
                  </div>
                </div>

                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                  <h4 className="font-medium text-sm uppercase tracking-wide text-muted-foreground">
                    {selectedMode === "fast" ? "Fast Mode" : "Nurture Mode"} — 
                    {selectedMode === "fast" 
                      ? " For hot leads who need quick responses" 
                      : " For long-cycle deals with patient cadence"}
                  </h4>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor={`reply-pending-${selectedMode}`}>Reply Alert After (hours)</Label>
                      <Input
                        id={`reply-pending-${selectedMode}`}
                        type="number"
                        value={currentMode.reply_pending_hours}
                        onChange={(e) =>
                          updateModeSettings(selectedMode, "reply_pending_hours", parseInt(e.target.value, 10) || 1)
                        }
                        min={1}
                        className="w-24"
                      />
                      <p className="text-xs text-muted-foreground">
                        Flag as "needs reply" after this many hours
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={`post-recap-${selectedMode}`}>Post-Meeting Recap (hours)</Label>
                      <Input
                        id={`post-recap-${selectedMode}`}
                        type="number"
                        value={currentMode.post_meeting.recap_suggest_after_hours}
                        onChange={(e) =>
                          updatePostMeeting(selectedMode, "recap_suggest_after_hours", parseInt(e.target.value, 10) || 1)
                        }
                        min={1}
                        className="w-24"
                      />
                      <p className="text-xs text-muted-foreground">
                        Suggest recap email after meeting
                      </p>
                    </div>
                  </div>

                  <Separator />

                  <DaySequenceInput
                    value={currentMode.outbound_followups_days}
                    onChange={(val) => updateModeSettings(selectedMode, "outbound_followups_days", val)}
                    label="Follow-up Sequence (days between emails)"
                    maxItems={8}
                    minItems={1}
                  />

                  <DaySequenceInput
                    value={currentMode.post_meeting.checkins_days}
                    onChange={(val) => updatePostMeeting(selectedMode, "checkins_days", val)}
                    label="Post-Meeting Check-ins (days after recap)"
                    maxItems={5}
                    minItems={1}
                  />

                  <Separator />

                  <div className="space-y-3">
                    <h5 className="text-sm font-medium">Breakup Email Trigger</h5>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Days since first outbound</Label>
                        <Input
                          type="number"
                          value={currentMode.breakup_trigger.days_since_first_outbound}
                          onChange={(e) =>
                            updateBreakupTrigger(selectedMode, "days_since_first_outbound", parseInt(e.target.value, 10) || 1)
                          }
                          min={1}
                          className="w-24"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Days since last outbound</Label>
                        <Input
                          type="number"
                          value={currentMode.breakup_trigger.days_since_last_outbound}
                          onChange={(e) =>
                            updateBreakupTrigger(selectedMode, "days_since_last_outbound", parseInt(e.target.value, 10) || 1)
                          }
                          min={1}
                          className="w-24"
                        />
                      </div>
                    </div>
                  </div>
                </div>
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
                        className="w-24"
                      />
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
                        className="w-24"
                      />
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
                        className="w-24"
                      />
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
                      onCheckedChange={(checked) => updateGuardrail("same_day_send_allowed", checked)}
                    />
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
                      className="w-full"
                    />
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
                      onCheckedChange={(checked) => updateTimeRule("use_business_days", checked)}
                    />
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
                      onCheckedChange={(checked) => updateTimeRule("avoid_weekends", checked)}
                    />
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
                              start: e.target.value,
                            })
                          }
                          className="w-32"
                        />
                        <span className="text-muted-foreground">to</span>
                        <Input
                          type="time"
                          value={settings.time_rules.send_window_local.end}
                          onChange={(e) =>
                            updateTimeRule("send_window_local", {
                              ...settings.time_rules.send_window_local,
                              end: e.target.value,
                            })
                          }
                          className="w-32"
                        />
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
                      onCheckedChange={(checked) => updateFlow("nurture_campaigns", "enabled", checked)}
                    />
                  </div>

                  {settings.flows.nurture_campaigns.enabled && (
                    <div className="space-y-4 pt-2">
                      <div className="grid grid-cols-3 gap-4">
                        <div className="space-y-2">
                          <Label>Weekly (days)</Label>
                          <Input
                            type="number"
                            value={settings.flows.nurture_campaigns.cadences_days.weekly}
                            onChange={(e) => updateNurtureCadence("weekly", parseInt(e.target.value, 10) || 7)}
                            min={1}
                            className="w-20"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Biweekly (days)</Label>
                          <Input
                            type="number"
                            value={settings.flows.nurture_campaigns.cadences_days.biweekly}
                            onChange={(e) => updateNurtureCadence("biweekly", parseInt(e.target.value, 10) || 14)}
                            min={1}
                            className="w-20"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Monthly (days)</Label>
                          <Input
                            type="number"
                            value={settings.flows.nurture_campaigns.cadences_days.monthly}
                            onChange={(e) => updateNurtureCadence("monthly", parseInt(e.target.value, 10) || 30)}
                            min={1}
                            className="w-20"
                          />
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
                          className="w-24"
                        />
                        <p className="text-xs text-muted-foreground">
                          Wait at least this many days after any email before sending nurture
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Reengagement */}
                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium">Re-engagement</h4>
                      <p className="text-xs text-muted-foreground">
                        Reach out to leads that have gone cold
                      </p>
                    </div>
                    <Switch
                      checked={settings.flows.reengagement.enabled}
                      onCheckedChange={(checked) => updateFlow("reengagement", "enabled", checked)}
                    />
                  </div>

                  {settings.flows.reengagement.enabled && (
                    <div className="space-y-4 pt-2">
                      <div className="space-y-2">
                        <Label>Trigger after no contact (days)</Label>
                        <Input
                          type="number"
                          value={settings.flows.reengagement.after_days_no_contact}
                          onChange={(e) =>
                            updateFlow("reengagement", "after_days_no_contact", parseInt(e.target.value, 10) || 30)
                          }
                          min={1}
                          className="w-24"
                        />
                      </div>

                      <DaySequenceInput
                        value={settings.flows.reengagement.sequence_days}
                        onChange={(val) => updateFlow("reengagement", "sequence_days", val)}
                        label="Re-engagement sequence (days between emails)"
                        maxItems={4}
                        minItems={1}
                      />
                    </div>
                  )}
                </div>

                {/* Pre-Meeting Reminders */}
                <div className="p-4 border rounded-lg space-y-4 bg-muted/30">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium">Pre-Meeting Reminders</h4>
                      <p className="text-xs text-muted-foreground">
                        Send reminders before scheduled meetings
                      </p>
                    </div>
                    <Switch
                      checked={settings.flows.pre_meeting.enabled}
                      onCheckedChange={(checked) => updateFlow("pre_meeting", "enabled", checked)}
                    />
                  </div>

                  {settings.flows.pre_meeting.enabled && (
                    <div className="pt-2">
                      <HourSequenceInput
                        value={settings.flows.pre_meeting.reminder_hours_before}
                        onChange={(val) => updateFlow("pre_meeting", "reminder_hours_before", val)}
                        label="Reminder hours before meeting"
                        maxItems={4}
                      />
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex justify-end pt-4">
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Settings"
                )}
              </Button>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
