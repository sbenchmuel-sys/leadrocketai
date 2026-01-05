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
    strategy: "nurture" as "fast" | "nurture",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.name.trim() || !formData.company.trim() || !formData.email.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    setIsLoading(true);
    try {
      await createLead(formData);
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
          <Label>Sales Strategy</Label>
          <RadioGroup
            value={formData.strategy}
            onValueChange={(value) => setFormData({ ...formData, strategy: value as "fast" | "nurture" })}
            disabled={isLoading}
            className="grid grid-cols-2 gap-4"
          >
            <div className="flex items-start space-x-3 p-4 rounded-lg border border-border bg-card hover:bg-accent/50 cursor-pointer">
              <RadioGroupItem value="fast" id="fast" className="mt-0.5" />
              <label htmlFor="fast" className="cursor-pointer">
                <p className="font-medium text-foreground">Fast</p>
                <p className="text-sm text-muted-foreground">Quick close, direct approach</p>
              </label>
            </div>
            <div className="flex items-start space-x-3 p-4 rounded-lg border border-border bg-card hover:bg-accent/50 cursor-pointer">
              <RadioGroupItem value="nurture" id="nurture" className="mt-0.5" />
              <label htmlFor="nurture" className="cursor-pointer">
                <p className="font-medium text-foreground">Nurture</p>
                <p className="text-sm text-muted-foreground">Build relationship over time</p>
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
