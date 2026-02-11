import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface ExtractedField<T = string | null> {
  value: T;
  confidence: number;
}

export interface ExtractedWorkspace {
  company_name?: ExtractedField;
  product_name?: ExtractedField;
  product_description?: ExtractedField;
  primary_value_props?: ExtractedField<string[] | null>;
  meeting_timezone?: ExtractedField;
}

export interface ExtractedRepProfile {
  full_name?: ExtractedField;
  email?: ExtractedField;
  phone?: ExtractedField;
  job_title?: ExtractedField;
  company_name?: ExtractedField;
  linkedin_url?: ExtractedField;
  calendar_link?: ExtractedField;
  office_address?: ExtractedField;
}

export interface ExtractedSignature {
  name: string;
  signature_text: string;
  confidence: number;
}

export interface ExtractionResult {
  workspace?: ExtractedWorkspace;
  rep_profile?: ExtractedRepProfile;
  signatures?: ExtractedSignature[];
}

const MIN_CONFIDENCE = 0.7;

/** Filter only high-confidence fields */
export function getHighConfidenceValue<T>(field?: ExtractedField<T>): T | undefined {
  if (!field) return undefined;
  if (field.confidence >= MIN_CONFIDENCE && field.value != null) return field.value;
  return undefined;
}

export function useProfileSync() {
  const [isSyncing, setIsSyncing] = useState(false);

  async function syncFromKB(target: "workspace" | "rep_profile" | "signatures" | "all"): Promise<ExtractionResult | null> {
    setIsSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("extract-profile-from-kb", {
        body: { target },
      });

      if (error) {
        console.error("[useProfileSync] Edge function error:", error);
        toast.error("Failed to sync from knowledge base");
        return null;
      }

      if (!data?.ok || !data?.extracted) {
        toast.error(data?.error || "No data extracted");
        return null;
      }

      return data.extracted as ExtractionResult;
    } catch (err) {
      console.error("[useProfileSync] Unexpected error:", err);
      toast.error("Failed to sync from knowledge base");
      return null;
    } finally {
      setIsSyncing(false);
    }
  }

  return { isSyncing, syncFromKB, getHighConfidenceValue };
}
