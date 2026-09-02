# DrivePilot QA — Follow-ups to go deeper / maybe fix

Running list of things QA surfaced that aren't resolved yet. Plain-English, founder-readable.
Last updated: 2026-06-11 (Week 2 data-safety run, against `drivepilot-staging`).

## To investigate / maybe fix

- [ ] **Email-login tokens may not be encrypted (`mail_accounts`).** Gmail and integration logins store their tokens in clearly-encrypted fields, but the `mail_accounts` path stores its login tokens in plain-looking fields. Couldn't confirm the actual contents (table was empty), but the setup suggests one email-login path isn't encrypting tokens like the others. This is a standalone issue — not related to the deletion problems below. Priority: check whether it affects production too.
  - Where to look: `supabase/functions/_shared/encryption.ts` and wherever `mail_accounts` rows are written.

- [ ] **Staging's scheduled job points at a different project.** The one scheduled job on staging (email sync) is aimed at another project's address (`umqhdxjtgarwkdpwsxrm`), not staging's own. Likely a leftover from copying setup between environments. Worth a glance so staging isn't quietly poking another system.

## Deliberately deferred (don't "fix" without a plan)

- **Email & call auto-deletion — left as-is on purpose.** The 72-hour deletion was erasing timeline history and breaking the ability to reply to emails (it blanks the same text the timeline shows and that replies are built from). Currently widened to a 30-day window as a workaround. Revisit only with a plan that preserves timeline history and reply context. (Cases IN-2, IN-3, CL-3.)

## Confirmed good (for the record)

- **Data isolation (IS-1..IS-5) — PASS, verified live on staging 2026-06-11.** Logged in as each test dealership; each saw only its own leads, and a cross-dealership edit attempt changed zero rows. One company cannot see or modify another's data.
