## What / why

<!-- 2–4 sentences a non-coder can follow. -->

## Risk tier and why

<!-- 1 = touches sends / isolation / retention; 2 = broad breakage; 3 = contained. One sentence why. -->

## Files owned by this unit

<!-- List. Anything outside it is a review question. -->

## Migration

<!-- Exactly one of: -->
- [ ] `Apply migration <file>`   <!-- one migration per PR, full filename -->
- [ ] no migration

## Edge functions to redeploy

<!-- `supabase functions deploy <name> --project-ref jhipmqdpjenojfhfjgzq` per function, or "none". -->

## Tests added (names)

<!-- file names, one per line -->

## Results

- `npm test`: <!-- N passed -->
- `npx tsc -b --noEmit`: <!-- clean / errors -->
- `npm run build`: <!-- ok -->
- `npm run test:edge`: <!-- ran / NOT RUN (why) -->
- `npm run test:isolation`: <!-- ran / N/A (no RLS change) / NOT RUN (why) -->

## QA verdict (pasted)

<!-- Paste the QA agent's verdict verbatim, or "pending". -->

## Feature preservation

<!-- Nothing rep-facing removed/hidden unless it is on the plan's "deliberately removed" list. Anything moved → name its new location here (must stay reachable in ≤2 taps). -->

## At-risk items handled / unsure about

<!-- What could bite, what you did about it, what you were not sure of. "none" is a valid answer only after saying why. -->

## Human-only staging steps

<!-- Anything a person must click/see/receive (real mailbox, calendar, phone). -->

## Checklist

- [ ] I did not edit `src/integrations/supabase/types.ts`
- [ ] Every deploy / db push command in this PR includes `--project-ref`
- [ ] The staging cron file (`*_codify_cron_jobs_staging.sql`) is applied to staging only, never via Lovable / never to production
- [ ] No behaviour change outside the files owned by this unit
- [ ] `STAGING_TEST_PLAN.md` updated if this PR adds a scenario worth re-testing nightly
