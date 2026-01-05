import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { setOnboardingStep } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, ArrowLeft } from "lucide-react";

interface AddKnowledgeStepProps {
  onNext: () => void;
  onBack: () => void;
}

export default function AddKnowledgeStep({ onNext, onBack }: AddKnowledgeStepProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: "",
    content: "",
    customerFacing: true,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.content.trim()) {
      toast.error("Please add some content");
      return;
    }

    setIsLoading(true);
    try {
      const { error } = await supabase.from("kb_chunks").insert({
        title: formData.title.trim() || null,
        content: formData.content.trim(),
        allowed_customer_facing: formData.customerFacing,
        source: "onboarding",
      });

      if (error) throw error;

      await setOnboardingStep(3);
      toast.success("Knowledge added successfully!");
      onNext();
    } catch (err) {
      console.error("Failed to add knowledge:", err);
      toast.error("Failed to add knowledge. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSkip = async () => {
    setIsLoading(true);
    try {
      await setOnboardingStep(3);
      onNext();
    } catch (err) {
      console.error("Failed to skip:", err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-bold text-foreground">Add Product Knowledge</h2>
        <p className="text-muted-foreground">
          Help the AI write better by adding information about your product or service.
        </p>
      </div>

      <div className="p-4 rounded-lg bg-muted/50 text-sm text-muted-foreground">
        <p className="font-medium text-foreground mb-1">What to add:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>Your elevator pitch or value proposition</li>
          <li>Key features and benefits</li>
          <li>Pricing information</li>
          <li>Common objection handlers</li>
        </ul>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="title">Title (optional)</Label>
          <Input
            id="title"
            placeholder="e.g., Product Overview, Pricing, Key Features"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="content">Content</Label>
          <Textarea
            id="content"
            placeholder="Paste your product information here..."
            value={formData.content}
            onChange={(e) => setFormData({ ...formData, content: e.target.value })}
            disabled={isLoading}
            rows={6}
          />
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="customerFacing"
            checked={formData.customerFacing}
            onCheckedChange={(checked) =>
              setFormData({ ...formData, customerFacing: checked as boolean })
            }
            disabled={isLoading}
          />
          <label
            htmlFor="customerFacing"
            className="text-sm text-muted-foreground cursor-pointer"
          >
            Safe to include in customer-facing messages
          </label>
        </div>

        <div className="flex gap-3 pt-4">
          <Button type="button" variant="outline" onClick={onBack} disabled={isLoading}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <Button type="submit" className="flex-1" disabled={isLoading}>
            {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Add & Continue
          </Button>
        </div>

        <Button
          type="button"
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={handleSkip}
          disabled={isLoading}
        >
          Skip for now
        </Button>
      </form>
    </div>
  );
}
