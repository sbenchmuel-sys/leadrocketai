import { useState } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Pencil, Loader2, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { LeadDetail } from "@/lib/supabaseQueries";

const editLeadSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.string().trim().email("Invalid email").max(255),
  company: z.string().trim().min(1, "Company is required").max(100),
  job_title: z.string().trim().max(100).optional().or(z.literal("")),
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  industry: z.string().trim().max(100).optional().or(z.literal("")),
  country: z.string().trim().max(100).optional().or(z.literal("")),
  website: z.string().trim().max(500).optional().or(z.literal("")),
  linkedin_url: z.string().trim().max(500).optional().or(z.literal("")),
  company_linkedin_url: z.string().trim().max(500).optional().or(z.literal("")),
  city: z.string().trim().max(100).optional().or(z.literal("")),
  state: z.string().trim().max(100).optional().or(z.literal("")),
  stage: z.enum(["new", "contacted", "engaged", "post_meeting", "closing", "closed_won", "closed_lost"]),
  meeting_link: z.string().trim().max(500).optional().or(z.literal("")),
  personal_notes: z.string().trim().max(2000).optional().or(z.literal("")),
  initial_message: z.string().trim().max(5000).optional().or(z.literal("")),
  wa_opted_in: z.boolean(),
  automation_mode: z.enum(["manual", "suggest_only", "hybrid", "full_auto"]).nullable(),
  outbound_tone: z.enum(["direct", "conversational", "assertive", "consultative"]),
});

type EditLeadFormData = z.infer<typeof editLeadSchema>;

interface EditLeadDialogProps {
  lead: LeadDetail;
  onUpdate: () => void;
}

export function EditLeadDialog({ lead, onUpdate }: EditLeadDialogProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<EditLeadFormData>({
    resolver: zodResolver(editLeadSchema),
    defaultValues: {
      name: lead.name,
      email: lead.email,
      company: lead.company,
      job_title: lead.job_title || "",
      phone: lead.phone || "",
      industry: lead.industry || "",
      country: lead.country || "",
      website: lead.website || "",
      linkedin_url: lead.linkedin_url || "",
      company_linkedin_url: lead.company_linkedin_url || "",
      city: lead.city || "",
      state: lead.state || "",
      stage: (lead.stage as "new" | "contacted" | "engaged" | "post_meeting" | "closing" | "closed_won" | "closed_lost") || "new",
      meeting_link: lead.meeting_link || "",
      personal_notes: lead.personal_notes || "",
      initial_message: lead.initial_message || "",
      wa_opted_in: lead.wa_opted_in ?? false,
      automation_mode: (lead.automation_mode as "manual" | "suggest_only" | "hybrid" | "full_auto" | null) ?? null,
      outbound_tone: ((lead as any).outbound_tone as "direct" | "conversational" | "assertive" | "consultative") || "direct",
    },
  });

  const onSubmit = async (data: EditLeadFormData) => {
    setIsSubmitting(true);
    try {
      const { error } = await supabase
        .from("leads")
        .update({
          name: data.name,
          email: data.email,
          company: data.company,
          job_title: data.job_title || null,
          phone: data.phone || null,
          industry: data.industry || null,
          country: data.country || null,
          website: data.website || null,
          linkedin_url: data.linkedin_url || null,
          company_linkedin_url: data.company_linkedin_url || null,
          city: data.city || null,
          state: data.state || null,
          stage: data.stage,
          meeting_link: data.meeting_link || null,
          personal_notes: data.personal_notes || null,
          initial_message: data.initial_message || null,
          wa_opted_in: data.wa_opted_in,
          automation_mode: data.automation_mode,
          outbound_tone: data.outbound_tone,
        } as any)
        .eq("id", lead.id);

      if (error) throw error;

      toast.success("Lead updated successfully");
      setOpen(false);
      onUpdate();
    } catch (err) {
      console.error("Failed to update lead:", err);
      toast.error("Failed to update lead");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="h-4 w-4 mr-2" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Lead</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name *</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email *</FormLabel>
                    <FormControl>
                      <Input type="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="company"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Company *</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="job_title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Job Title</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. VP of Operations" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. +1 555-1234" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="industry"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Industry</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Healthcare" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>City</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Toronto" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="state"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>State / Province</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Ontario" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="country"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Country</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Canada" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="meeting_link"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Meeting Link</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. https://calendly.com/..." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="website"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Website</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. https://www.example.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="linkedin_url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>LinkedIn URL</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. https://linkedin.com/in/..." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="company_linkedin_url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Company LinkedIn URL</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. https://linkedin.com/company/..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="stage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Deal Stage</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="new">New</SelectItem>
                        <SelectItem value="contacted">Contacted</SelectItem>
                        <SelectItem value="engaged">Engaged</SelectItem>
                        <SelectItem value="post_meeting">Post-Meeting</SelectItem>
                        <SelectItem value="closing">Closing</SelectItem>
                        <SelectItem value="closed_won">Won</SelectItem>
                        <SelectItem value="closed_lost">Lost</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <Separator />

            {/* WhatsApp Automation Section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <MessageCircle className="h-4 w-4 text-[hsl(142,71%,45%)]" />
                WhatsApp Automation
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="automation_mode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Automation Mode</FormLabel>
                      <Select
                        onValueChange={(val) => field.onChange(val === "workspace_default" ? null : val)}
                        value={field.value ?? "workspace_default"}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="workspace_default">Workspace Default</SelectItem>
                          <SelectItem value="manual">Manual (no auto-replies)</SelectItem>
                          <SelectItem value="suggest_only">Suggest Only</SelectItem>
                          <SelectItem value="hybrid">Hybrid (low-risk auto)</SelectItem>
                          <SelectItem value="full_auto">Full Auto</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="wa_opted_in"
                  render={({ field }) => (
                    <FormItem className="flex flex-col justify-end pb-1">
                      <FormLabel>WA Automation Opted In</FormLabel>
                      <div className="flex items-center gap-3 pt-1">
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                        <span className="text-sm text-muted-foreground">
                          {field.value ? "Enabled" : "Disabled"}
                        </span>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Both opt-in and mode must be set for automation to execute. Mode defaults to the workspace setting if not overridden here.
              </p>
            </div>

            <FormField
              control={form.control}
              name="initial_message"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Initial Message</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="The lead's initial inquiry or message..."
                      className="min-h-[80px]"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="personal_notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Personal Notes</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Internal notes about this lead..."
                      className="min-h-[80px]"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
