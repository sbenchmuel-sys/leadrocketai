
UPDATE leads
SET eligible_at = date_trunc('day', eligible_at)
    + make_interval(mins => 540 + (abs(hashtext(id::text)) % 450))
WHERE motion = 'nurture'
  AND nurture_status = 'active'
  AND status IN ('active', 'new')
  AND needs_action = true
  AND eligible_at IS NOT NULL;
