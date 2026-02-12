import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import { createLead, setOnboardingStep } from "@/lib/supabaseQueries";
import { Loader2, ArrowLeft } from "lucide-react";

interface CreateLeadStepProps {
  onNext: () => void;
  onBack: () => void;
}

export default function CreateLeadStep({ onNext, onBack }: CreateLeadStepProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    company: "",
    email: "",
    motion: "outbound_prospecting" as string,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.name.trim() || !formData.company.trim() || !formData.email.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    setIsLoading(true);
    try {
      await createLead({
        name: formData.name,
        company: formData.company,
        email: formData.email,
        motion: formData.motion,
      });
      await setOnboardingStep(2);
      toast.success("Lead created successfully!");
      onNext();
    } catch (err) {
      console.error("Failed to create lead:", err);
      toast.error("Failed to create lead. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-bold text-foreground">Add Your First Lead</h2>
        <p className="text-muted-foreground">
          Start by adding a prospect you're currently working with.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Contact Name</Label>
          <Input
            id="name"
            placeholder="John Smith"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="company">Company</Label>
          <Input
            id="company"
            placeholder="Acme Corp"
            value={formData.company}
            onChange={(e) => setFormData({ ...formData, company: e.target.value })}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="john@acme.com"
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-3">
          <Label>Motion</Label>
          <RadioGroup
            value={formData.motion}
            onValueChange={(value) => setFormData({ ...formData, motion: value })}
            disabled={isLoading}
            className="grid grid-cols-3 gap-3"
          >
            <div className="flex flex-col items-center space-y-1.5 p-3 rounded-lg border border-border bg-card hover:bg-accent/50 cursor-pointer text-center">
              <RadioGroupItem value="outbound_prospecting" id="outbound" />
              <label htmlFor="outbound" className="cursor-pointer">
                <p className="font-medium text-foreground text-sm">Outbound</p>
                <p className="text-xs text-muted-foreground">Cold outreach</p>
              </label>
            </div>
            <div className="flex flex-col items-center space-y-1.5 p-3 rounded-lg border border-border bg-card hover:bg-accent/50 cursor-pointer text-center">
              <RadioGroupItem value="inbound_response" id="inbound" />
              <label htmlFor="inbound" className="cursor-pointer">
                <p className="font-medium text-foreground text-sm">Inbound</p>
                <p className="text-xs text-muted-foreground">They reached out</p>
              </label>
            </div>
            <div className="flex flex-col items-center space-y-1.5 p-3 rounded-lg border border-border bg-card hover:bg-accent/50 cursor-pointer text-center">
              <RadioGroupItem value="nurture" id="nurture" />
              <label htmlFor="nurture" className="cursor-pointer">
                <p className="font-medium text-foreground text-sm">Nurture</p>
                <p className="text-xs text-muted-foreground">Long-term play</p>
              </label>
            </div>
          </RadioGroup>
        </div>

        <div className="flex gap-3 pt-4">
          <Button type="button" variant="outline" onClick={onBack} disabled={isLoading}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <Button type="submit" className="flex-1" disabled={isLoading}>
            {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create Lead & Continue
          </Button>
        </div>
      </form>
    </div>
  );
}
