import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Dynamic CORS based on allowed origins
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
  
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isLovableProject = origin.endsWith(".lovableproject.com");
  const isLovableApp = origin.endsWith(".lovable.app");
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || isLovableProject || isLovableApp || allowedOrigins.includes("*");
  
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

interface ZoomSummaryInput {
  user_id: string;
  gmail_message_id: string;
  gmail_thread_id: string;
  sent_at: string;
  subject: string;
  from_email: string;
  to_email: string;
  cc_email?: string;
  raw_text: string;
}

interface SuggestedLead {
  lead_id: string;
  name: string;
  company: string;
  reason: string;
}

// Detection rules for Zoom summary emails
function isZoomSummaryEmail(from: string, subject: string, body: string): boolean {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  const bodyLower = body.toLowerCase();

  // A) Sender allowlist
  const isFromZoom = fromLower.includes("@zoom.us") || fromLower.includes("@zoom.com");

  // B) Subject match
  const subjectKeywords = ["meeting summary", "ai companion", "zoom ai companion"];
  const hasSubjectMatch = subjectKeywords.some(kw => subjectLower.includes(kw));

  // C) Body keyword match (need 2+)
  const bodyKeywords = [
    "meeting summary",
    "key takeaways",
    "action items",
    "next steps",
    "topics discussed",
    "ai companion"
  ];
  const bodyMatches = bodyKeywords.filter(kw => bodyLower.includes(kw)).length;
  const hasBodyMatch = bodyMatches >= 2;

  // Decision rule: (A && B) OR (A && C) OR (B && C)
  return (isFromZoom && hasSubjectMatch) || (isFromZoom && hasBodyMatch) || (hasSubjectMatch && hasBodyMatch);
}

// Extract meeting title from subject or body
function extractMeetingTitle(subject: string, body: string): string {
  // Try to extract from subject first (remove "Meeting Summary:" prefix)
  let title = subject
    .replace(/^(Re:|Fwd:|FW:)\s*/gi, "")
    .replace(/^Meeting Summary[:\-–—]\s*/i, "")
    .replace(/^Zoom AI Companion[:\-–—]\s*/i, "")
    .replace(/AI Companion\s*-?\s*/i, "")
    .trim();

  if (title && title.length > 3) {
    return title.substring(0, 200);
  }

  // Try to find a heading in the body
  const headingMatch = body.match(/^#+\s*(.+)$/m) || body.match(/^([A-Z][^.!?\n]{10,60})$/m);
  if (headingMatch) {
    return headingMatch[1].trim().substring(0, 200);
  }

  return subject.substring(0, 200) || "Zoom Meeting";
}

// Extract and clean participant emails
function extractParticipantEmails(body: string, toEmail: string, ccEmail: string | undefined, internalDomains: string[]): string[] {
  const emails = new Set<string>();

  // Parse To and Cc headers
  const allRecipients = [toEmail, ccEmail || ""].join(" ");
  const emailRegex = /[\w.-]+@[\w.-]+\.\w+/gi;
  
  // From body
  const bodyEmails = body.match(emailRegex) || [];
  bodyEmails.forEach(e => emails.add(e.toLowerCase()));

  // From headers
  const headerEmails = allRecipients.match(emailRegex) || [];
  headerEmails.forEach(e => emails.add(e.toLowerCase()));

  // Filter out internal domains and Zoom system emails
  const internalDomainsLower = internalDomains.map(d => d.toLowerCase());
  const systemDomains = ["zoom.us", "zoom.com", "noreply", "no-reply"];

  const filtered = Array.from(emails).filter(email => {
    const domain = email.split("@")[1] || "";
    const isInternal = internalDomainsLower.some(d => domain.includes(d));
    const isSystem = systemDomains.some(s => email.includes(s) || domain.includes(s));
    return !isInternal && !isSystem;
  });

  // Cap to 200 entries
  return filtered.slice(0, 200);
}

// Extract participant names from Zoom summary text AND subject
function extractParticipantNames(body: string, subject?: string): string[] {
  const names = new Set<string>();
  
  // Pattern 0: Extract names from subject line (e.g., "Meeting assets for Jithen Paramanund: 30 Minute Intro...")
  if (subject) {
    // "Meeting assets for [Name]'s Zoom Meeting" or "Meeting assets for [Name]: [Meeting Title]"
    const subjectNamePatterns = [
      /Meeting assets for ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)'s (?:Zoom )?Meeting/i,
      /Meeting (?:with|for) ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+):\s*\d+\s*(?:Min|Hour)/i,
      /Intro (?:to|with) .+? with ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    ];
    
    for (const pattern of subjectNamePatterns) {
      const match = subject.match(pattern);
      if (match && match[1]) {
        // This could be a full name, add it
        names.add(match[1].trim());
      }
    }
    
    // Also try to extract any capitalized multi-word names from subject
    const subjectFullNamePattern = /\b([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
    let match;
    while ((match = subjectFullNamePattern.exec(subject)) !== null) {
      const potentialName = match[1].trim();
      // Filter out common non-name phrases
      const subjectExclude = ['Meeting Summary', 'Zoom Meeting', 'Meeting Assets', 'Quick Recap', 'Action Items', 'Next Steps'];
      if (!subjectExclude.some(ex => potentialName.includes(ex))) {
        names.add(potentialName);
      }
    }
  }
  
  // Pattern 1: "[Name] discussed/mentioned/emphasized/noted/said/explained/asked..."
  const actionPatterns = [
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:discussed|mentioned|emphasized|noted|said|explained|presented|shared|suggested|asked|added|agreed|confirmed|talked|stated|raised|pointed|highlighted|addressed|covered|reviewed|proposed|recommended|indicated|expressed|focused|described|outlined|summarized|reported|clarified)\b/g
  ];
  
  for (const pattern of actionPatterns) {
    let match;
    while ((match = pattern.exec(body)) !== null) {
      names.add(match[1].trim());
    }
  }
  
  // Pattern 2: Names in action items (e.g., "Shai: Prepare a draft")
  const actionItemPattern = /^\s*[-•*]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?):\s+[A-Z]/gm;
  let match;
  while ((match = actionItemPattern.exec(body)) !== null) {
    names.add(match[1].trim());
  }
  
  // Pattern 3: Next steps format - "Name will..." or "Name to..."
  const nextStepsPattern = /\b([A-Z][a-z]+)\s+(?:will|to|should|needs to|is going to)\s+/g;
  while ((match = nextStepsPattern.exec(body)) !== null) {
    names.add(match[1].trim());
  }
  
  // Filter out common false positives
  const exclude = new Set([
    'Meeting', 'Summary', 'Quick', 'Next', 'Action', 'Topics', 'Key', 'The', 'This', 
    'Zoom', 'Call', 'Discussion', 'Team', 'Project', 'Update', 'Review', 'Session',
    'Agenda', 'Notes', 'Items', 'Steps', 'Takeaways', 'Overview', 'Welcome', 'Thanks',
    'Please', 'Hello', 'Regards', 'Best', 'Sincerely', 'From', 'Date', 'Subject',
    'Attendees', 'Participants', 'Recording', 'Transcript', 'Minute', 'Intro', 'Assets'
  ]);
  
  return Array.from(names).filter(n => !exclude.has(n) && n.length > 2);
}

// Clean summary text (remove boilerplate/signatures)
function cleanSummaryText(body: string): string {
  let cleaned = body;

  // Remove common email signatures and footers
  const signaturePatterns = [
    /^-{2,}[\s\S]*$/m,
    /^Sent from my [\s\S]*$/m,
    /^This is an automatically generated email[\s\S]*$/m,
    /^Copyright © \d{4} Zoom[\s\S]*$/m,
    /^You are receiving this email because[\s\S]*$/m,
    /^Unsubscribe[\s\S]*$/m,
  ];

  signaturePatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, "");
  });

  // Trim and normalize whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned.substring(0, 50000); // Cap at 50k chars
}

// Validate input schema
function validateInput(input: unknown): input is ZoomSummaryInput {
  if (!input || typeof input !== "object") return false;
  const obj = input as Record<string, unknown>;
  
  return (
    typeof obj.user_id === "string" &&
    typeof obj.gmail_message_id === "string" &&
    typeof obj.gmail_thread_id === "string" &&
    typeof obj.sent_at === "string" &&
    typeof obj.subject === "string" &&
    typeof obj.raw_text === "string"
  );
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { messages, user_id: requestUserId } = body;

    if (!Array.isArray(messages) || !requestUserId) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid request body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get org settings
    const { data: orgSettings } = await serviceSupabase
      .from("org_settings")
      .select("*")
      .eq("user_id", requestUserId)
      .maybeSingle();

    // If sync is disabled, skip processing
    if (!orgSettings?.zoom_meeting_sync_enabled) {
      console.log("[process-zoom-summary] Zoom sync disabled for user, skipping");
      return new Response(
        JSON.stringify({ ok: true, processed: 0, skipped: messages.length, reason: "disabled" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const internalDomains = orgSettings?.internal_email_domains || [];
    const autoGenerateFollowups = orgSettings?.zoom_auto_generate_followups_enabled ?? true;

    let processed = 0;
    let skipped = 0;
    let unmatched = 0;
    const errors: string[] = [];

    // Get all leads for this user for matching
    const { data: leads } = await serviceSupabase
      .from("leads")
      .select("id, name, company, email, last_activity_at, last_inbound_at, last_outbound_at")
      .eq("owner_user_id", requestUserId);

    // Get existing gmail_message_ids to avoid duplicates
    const existingMessageIds = new Set<string>();
    const { data: existingSummaries } = await serviceSupabase
      .from("meeting_summaries")
      .select("gmail_message_id")
      .eq("user_id", requestUserId);
    (existingSummaries || []).forEach(s => {
      if (s.gmail_message_id) existingMessageIds.add(s.gmail_message_id);
    });

    const { data: existingUnmatched } = await serviceSupabase
      .from("unmatched_meeting_summaries")
      .select("gmail_message_id")
      .eq("user_id", requestUserId);
    (existingUnmatched || []).forEach(s => {
      if (s.gmail_message_id) existingMessageIds.add(s.gmail_message_id);
    });

    // Get thread-to-lead mappings from existing interactions
    const { data: threadMappings } = await serviceSupabase
      .from("interactions")
      .select("gmail_thread_id, lead_id")
      .eq("source", "gmail")
      .not("gmail_thread_id", "is", null);

    const threadToLead = new Map<string, string>();
    (threadMappings || []).forEach(m => {
      if (m.gmail_thread_id && m.lead_id) {
        threadToLead.set(m.gmail_thread_id, m.lead_id);
      }
    });

    // Also check meeting_summaries for thread locks
    const { data: summaryThreads } = await serviceSupabase
      .from("meeting_summaries")
      .select("gmail_thread_id, lead_id")
      .not("gmail_thread_id", "is", null)
      .not("lead_id", "is", null);
    (summaryThreads || []).forEach(s => {
      if (s.gmail_thread_id && s.lead_id) {
        threadToLead.set(s.gmail_thread_id, s.lead_id);
      }
    });

    for (const msg of messages) {
      try {
        if (!validateInput(msg)) {
          console.log("[process-zoom-summary] Invalid message format, skipping");
          skipped++;
          continue;
        }

        // Skip already processed
        if (existingMessageIds.has(msg.gmail_message_id)) {
          skipped++;
          continue;
        }

        // Check if this is a Zoom summary email
        if (!isZoomSummaryEmail(msg.from_email || "", msg.subject, msg.raw_text)) {
          skipped++;
          continue;
        }

        console.log(`[process-zoom-summary] Detected Zoom summary: ${msg.subject}`);

        // Extract data
        const meetingTitle = extractMeetingTitle(msg.subject, msg.raw_text);
        const participantEmails = extractParticipantEmails(
          msg.raw_text,
          msg.to_email || "",
          msg.cc_email,
          internalDomains
        );
        const summaryText = cleanSummaryText(msg.raw_text);

        // Lead matching priority:
        // 1. Thread lock
        let matchedLeadId: string | null = null;
        let matchReason: string | null = null;

        if (threadToLead.has(msg.gmail_thread_id)) {
          matchedLeadId = threadToLead.get(msg.gmail_thread_id)!;
          matchReason = "thread_lock";
          console.log(`[process-zoom-summary] Matched via thread lock: ${matchedLeadId}`);
        }

        // 2. Participant email match
        if (!matchedLeadId && leads && participantEmails.length > 0) {
          for (const lead of leads) {
            const leadEmailLower = lead.email.toLowerCase();
            if (participantEmails.some(p => p === leadEmailLower)) {
              matchedLeadId = lead.id;
              matchReason = "participant_email";
              console.log(`[process-zoom-summary] Matched via participant email: ${lead.email}`);
              break;
            }
          }
        }

        // 3. Participant name match (now also extracts from subject line)
        const participantNames = extractParticipantNames(msg.raw_text, msg.subject);
        console.log(`[process-zoom-summary] Extracted names from body+subject: ${participantNames.join(", ")}`);
        
        if (!matchedLeadId && leads && participantNames.length > 0) {
          const nameMatchedLeads = leads.filter(lead => {
            const leadNameLower = lead.name.toLowerCase();
            const leadFirstName = leadNameLower.split(' ')[0];
            const leadLastName = leadNameLower.split(' ').slice(-1)[0];
            
            return participantNames.some(name => {
              const nameLower = name.toLowerCase();
              const nameFirst = nameLower.split(' ')[0];
              // Match on first name OR full name contains
              return leadFirstName === nameFirst || 
                     leadNameLower.includes(nameLower) ||
                     nameLower.includes(leadFirstName);
            });
          });
          
          if (nameMatchedLeads.length === 1) {
            matchedLeadId = nameMatchedLeads[0].id;
            matchReason = `name_match: ${participantNames.join(', ')}`;
            console.log(`[process-zoom-summary] Matched via name: ${nameMatchedLeads[0].name}`);
          } else if (nameMatchedLeads.length > 1) {
            console.log(`[process-zoom-summary] Multiple name matches (${nameMatchedLeads.length}), continuing to scoring`);
          }
        }

        // 4. Recency + domain + name scoring fallback
        if (!matchedLeadId && leads) {
          const participantDomains = new Set(
            participantEmails.map(e => e.split("@")[1]).filter(Boolean)
          );

          const now = Date.now();
          const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

          const scoredLeads: Array<{ lead: typeof leads[0]; score: number; reason: string }> = [];

          for (const lead of leads) {
            let score = 0;
            const reasons: string[] = [];

            // Name match scoring (+40)
            if (participantNames.length > 0) {
              const leadNameLower = lead.name.toLowerCase();
              const leadFirstName = leadNameLower.split(' ')[0];
              if (participantNames.some(n => {
                const nameLower = n.toLowerCase();
                return leadFirstName === nameLower.split(' ')[0] || leadNameLower.includes(nameLower);
              })) {
                score += 40;
                reasons.push("name_match");
              }
            }

            // Domain match (+50)
            const leadDomain = lead.email.split("@")[1]?.toLowerCase();
            if (leadDomain && participantDomains.has(leadDomain)) {
              score += 50;
              reasons.push("domain_match");
            }

            // Recent activity (+30)
            const lastActivity = lead.last_activity_at ? new Date(lead.last_activity_at).getTime() : 0;
            const lastInbound = lead.last_inbound_at ? new Date(lead.last_inbound_at).getTime() : 0;
            const lastOutbound = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0;
            const recentActivity = Math.max(lastActivity, lastInbound, lastOutbound);

            if (now - recentActivity < FOURTEEN_DAYS) {
              score += 30;
              reasons.push("recent_activity");
            }

            if (score > 0) {
              scoredLeads.push({ lead, score, reason: reasons.join(", ") });
            }
          }

          scoredLeads.sort((a, b) => b.score - a.score);

          // Only match if top candidate is clearly highest
          if (scoredLeads.length === 1 || 
              (scoredLeads.length > 1 && scoredLeads[0].score > scoredLeads[1].score + 20)) {
            matchedLeadId = scoredLeads[0].lead.id;
            matchReason = scoredLeads[0].reason;
            console.log(`[process-zoom-summary] Matched via scoring: ${scoredLeads[0].lead.email} (score: ${scoredLeads[0].score})`);
          } else if (scoredLeads.length > 0) {
            // Ambiguous - create unmatched entry with suggestions
            const suggestedLeads: SuggestedLead[] = scoredLeads.slice(0, 3).map(sl => ({
              lead_id: sl.lead.id,
              name: sl.lead.name,
              company: sl.lead.company,
              reason: sl.reason,
            }));

            const { error: unmatchedError } = await serviceSupabase
              .from("unmatched_meeting_summaries")
              .insert({
                user_id: requestUserId,
                gmail_message_id: msg.gmail_message_id,
                gmail_thread_id: msg.gmail_thread_id,
                meeting_title: meetingTitle,
                sent_at: msg.sent_at,
                summary_text: summaryText,
                participants_emails: participantEmails,
                suggested_leads: suggestedLeads,
              });

            if (unmatchedError && !unmatchedError.message.includes("duplicate")) {
              console.error("[process-zoom-summary] Failed to insert unmatched:", unmatchedError);
              errors.push(unmatchedError.message);
            } else {
              unmatched++;
              existingMessageIds.add(msg.gmail_message_id);
            }
            continue;
          }
        }

        // If still no match, create unmatched entry
        if (!matchedLeadId) {
          const { error: unmatchedError } = await serviceSupabase
            .from("unmatched_meeting_summaries")
            .insert({
              user_id: requestUserId,
              gmail_message_id: msg.gmail_message_id,
              gmail_thread_id: msg.gmail_thread_id,
              meeting_title: meetingTitle,
              sent_at: msg.sent_at,
              summary_text: summaryText,
              participants_emails: participantEmails,
              suggested_leads: [],
            });

          if (unmatchedError && !unmatchedError.message.includes("duplicate")) {
            console.error("[process-zoom-summary] Failed to insert unmatched:", unmatchedError);
            errors.push(unmatchedError.message);
          } else {
            unmatched++;
            existingMessageIds.add(msg.gmail_message_id);
          }
          continue;
        }

        // Insert matched summary
        const { data: insertedSummary, error: insertError } = await serviceSupabase
          .from("meeting_summaries")
          .insert({
            user_id: requestUserId,
            lead_id: matchedLeadId,
            source: "zoom_email",
            gmail_message_id: msg.gmail_message_id,
            gmail_thread_id: msg.gmail_thread_id,
            sent_at: msg.sent_at,
            meeting_title: meetingTitle,
            summary_text: summaryText,
            participants_emails: participantEmails,
          })
          .select()
          .single();

        if (insertError) {
          if (!insertError.message.includes("duplicate")) {
            console.error("[process-zoom-summary] Failed to insert summary:", insertError);
            errors.push(insertError.message);
          }
          continue;
        }

        processed++;
        existingMessageIds.add(msg.gmail_message_id);

        // Trigger auto-generation if enabled
        if (autoGenerateFollowups && insertedSummary) {
          try {
            // Call the ai_task function to generate post-meeting recap
            const { error: aiError } = await serviceSupabase.functions.invoke("ai_task", {
              body: {
                task: "post_meeting_followup_email",
                payload: {
                  lead_id: matchedLeadId,
                  meeting_summary: summaryText,
                  meeting_title: meetingTitle,
                },
              },
            });

            if (aiError) {
              console.error("[process-zoom-summary] AI task error:", aiError);
            } else {
              // Mark as followup generated
              await serviceSupabase
                .from("meeting_summaries")
                .update({ 
                  followup_generated: true,
                  processed_at: new Date().toISOString()
                })
                .eq("id", insertedSummary.id);
            }
          } catch (aiErr) {
            console.error("[process-zoom-summary] AI generation failed:", aiErr);
            // Don't fail the whole operation, just log
          }
        }

      } catch (msgErr) {
        console.error("[process-zoom-summary] Error processing message:", msgErr);
        errors.push(msgErr instanceof Error ? msgErr.message : "Unknown error");
      }
    }

    console.log(`[process-zoom-summary] Done: processed=${processed}, skipped=${skipped}, unmatched=${unmatched}`);

    return new Response(
      JSON.stringify({
        ok: true,
        processed,
        skipped,
        unmatched,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[process-zoom-summary] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: "An error occurred", error_id: errorId }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
