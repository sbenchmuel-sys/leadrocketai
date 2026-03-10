// Shared signal ingestion helper — writes signals to lead_signals table
import { logger } from "./logger.ts";

export interface SignalInput {
  lead_id: string;
  signal_type: string;
  signal_description: string;
  signal_source: "google_search" | "website" | "crm_activity" | "conversation" | "manual";
  confidence_score?: number;
  source_url?: string | null;
  source_detail?: Record<string, unknown> | null;
}

/**
 * Upsert signals into lead_signals, skipping duplicates within last 7 days.
 */
export async function ingestSignals(
  adminClient: any,
  signals: SignalInput[],
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const signal of signals) {
    // De-duplicate: same lead + type + source within 7 days
    const { data: existing } = await adminClient
      .from("lead_signals")
      .select("id")
      .eq("lead_id", signal.lead_id)
      .eq("signal_type", signal.signal_type)
      .eq("signal_source", signal.signal_source)
      .gt("detected_at", sevenDaysAgo)
      .limit(1)
      .maybeSingle();

    if (existing) {
      skipped++;
      continue;
    }

    const { error } = await adminClient.from("lead_signals").insert({
      lead_id: signal.lead_id,
      signal_type: signal.signal_type,
      signal_description: signal.signal_description,
      signal_source: signal.signal_source,
      confidence_score: signal.confidence_score ?? 0.7,
      source_url: signal.source_url ?? null,
      source_detail: signal.source_detail ?? null,
    });

    if (error) {
      logger.warn("signal_insert_error", { error: error.message, signal_type: signal.signal_type });
      skipped++;
    } else {
      inserted++;
    }
  }

  logger.info("signals_ingested", { inserted, skipped, total: signals.length });
  return { inserted, skipped };
}
