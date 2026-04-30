This is not a one-line prompt issue. From the code and recent draft data, automation has multiple generation paths and the follow-up path is using cold-sequence logic even when the lead is inbound. That explains the instability.

What I found already:
- Manual draft generation and automation preview both call the AI pipeline, but automation changes the intent based on `stepKey`.
- For inbound leads, step 1 can use `inbound_intro`, but step 2/3 still map to cold outbound tasks: `pre_email_2_followup`, `pre_email_3_followup`.
- The backend then tries to patch this with `motion=inbound_response`, but the prompt body is still the cold follow-up prompt. That creates conflict: warm inbound CTA vs cold discovery-question framework.
- Automation preview can generate `send_pre_2` before `send_pre_1` has actually been sent, so the follow-up prompt may receive “No previous emails sent yet.” That can produce blank/thin follow-ups.
- Sanitizers strip leaked reasoning but do not enforce a send-safe contract. A bad model output can still become `Best, Shai` or a cold question and get saved.
- Current approved drafts show this exact problem: an inbound contact-form lead saved as `send_pre_2` with a cold discovery question and meeting link.

Plan after approval:

1. Map every email-generation entry point
- Audit these paths end-to-end:
  - Manual Drafts tab generation
  - Lead page automation preview generation
  - Bulk automation enablement
  - Background automation executor
  - Nurture pre-generation
- Produce a clear matrix:

```text
UI action -> step_key -> ai_task -> motion -> campaign framework -> subject source -> save/send path
```

Goal: remove hidden differences between “manual draft” and “automation preview”.

2. Define a canonical sequence model for inbound vs cold outbound
- Cold outbound should remain:
  - Step 1: cold intro / neutral observation
  - Step 2: cold follow-up 1
  - Step 3: cold follow-up 2
  - Step 4: breakup
- Warm inbound should become its own sequence, not a cold sequence with patches:
  - Step 1: warm inbound reply, thank them, acknowledge request, meeting CTA
  - Step 2: warm follow-up if no meeting/reply, reference prior warm reply, meeting CTA
  - Step 3: gentle close-loop follow-up, still warm, no cold discovery framing
- Add/align backend task support for inbound follow-ups instead of reusing cold `pre_email_2_followup` and `pre_email_3_followup`.

3. Fix automation preview step resolution
- Make `AutomationDraftPreviewDialog` use a single canonical resolver instead of local `if stepKey startsWith(...)` mapping.
- Ensure inbound source detection does not depend on partially-loaded lead props.
- If `motion`, `source_type`, or `initial_message` are missing from the loaded lead object, fetch the fresh lead row before generating.
- Subject should be deterministic and not AI-derived:
  - Inbound step 1: `Thanks for reaching out - {Company}` or `Thanks for reaching out, {FirstName}`
  - Inbound follow-up: `Following up - {FirstName}`
  - Cold intro: `Introduction - {Company}` or `Connecting with you, {FirstName}`
- Never allow subjects like `Introduction - -`.

4. Fix follow-up context for previews
- When previewing step 2/3 before prior steps were actually sent, automation should use the saved approved previous automation draft as context.
- If no prior sent email and no approved previous-step draft exists:
  - Either block generation of step 2/3 with a clear message, or
  - Generate step 1 first and use it as context.
- This removes the “follow-up with no previous email” failure mode.

5. Replace weak sanitization with hard validation gates
Add a shared validator used by both frontend preview and backend executor:

Reject/regenerate if body:
- Contains reasoning markers: `INTERNAL REASONING`, `Word count check`, `All instructions`, etc.
- Is too short for an email, e.g. only sign-off or greeting/sign-off.
- Missing greeting with lead first name.
- Missing body paragraph.
- Missing sign-off.
- Contains placeholders like `[Name]`, `[Meeting Link]`, `{First Name}`.
- For inbound warm emails: missing thank-you/acknowledgement, missing meeting CTA, or contains cold discovery phrases like “biggest challenge”.
- For breakup emails: missing close-loop question or too thin.

Important: if validation fails, do not display/save/send the draft. Regenerate once with strict repair instructions. If still invalid, return an error and block sending.

6. Make automation executor send-safe even if preview saved bad content
- Before sending any approved/pending automation draft, validate it again server-side.
- If it fails validation:
  - Do not send.
  - Mark automation log as failed/blocked with reason.
  - Keep the lead needing action so the user can review.
- This is the final safety net so a leaked-reasoning or blank draft cannot reach a prospect.

7. Consolidate prompt assembly
- Remove conflicting prompt layers where possible:
  - cold framework blocks applied to warm inbound
  - quality regeneration forcing `neutral_observation` on inbound motion
  - meeting-link stripping/keeping based on old cold logic
- Keep campaign instructions, motion, framework, and task prompt in one deterministic priority order.
- For inbound, meeting CTA should be default, not optional.

8. Add observability for this exact problem
- Add structured generation metadata to logs/drafts:
  - `task`
  - `motion`
  - `source_type`
  - `step_key`
  - `validation_status`
  - `validation_errors`
  - `regenerated`
  - `framework_used`
- This lets us inspect why a bad draft happened without guessing.

9. Test matrix before declaring fixed
Use real cases from the current issue:
- Inbound contact-form lead, step 1: warm thank-you + meeting CTA.
- Inbound contact-form lead, step 2 with prior approved step 1 draft: warm follow-up + meeting CTA.
- Inbound contact-form lead, step 2 without prior draft/sent email: blocked or auto-generates step 1 context, not blank.
- Cold outbound lead, step 1: cold neutral observation, no meeting link unless instructed.
- Cold outbound lead, step 2: references prior outbound and asks one clear question.
- Breakup email: complete body, not just `Best, Shai`.
- Reasoning-leak fixture: validator blocks it.
- Placeholder fixture: validator blocks it.

10. Rollout approach
- First implement validation/blocking so nothing unsafe can be sent.
- Then fix inbound/cold routing and follow-up context.
- Then clean up duplicated resolver logic.
- Then run the test matrix against the deployed backend function.

Expected result:
- Manual drafts and automation previews use the same generation rules.
- Inbound leads stay warm across the cadence.
- Cold outbound stays cold and concise.
- Blank/sign-off-only drafts are impossible to save/send.
- Reasoning leaks are blocked, not merely stripped after the fact.
- Automation no longer changes the prompt behavior unpredictably.