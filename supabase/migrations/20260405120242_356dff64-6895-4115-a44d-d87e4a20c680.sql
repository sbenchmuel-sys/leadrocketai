
-- Stagger overdue nurture leads across 9:00-16:30 window using lead id hash
UPDATE leads
SET
  eligible_at = date_trunc('day', now()) + interval '1 day'
    + make_interval(
        mins => 540 + (abs(hashtext(id::text)) % 450)
      )
WHERE motion = 'nurture'
  AND nurture_status = 'active'
  AND status IN ('active', 'new')
  AND unsubscribed = false
  AND needs_action = true
  AND eligible_at < now();
