## Outreach card action row — final plan

Single top-right action row with mobile-safe tweaks. Applies to `src/components/queue/OutreachCard.tsx` only.

### Layout

```text
Desktop (≥sm):
┌─────────────────────────────────────────────────────────────┐
│ Test2 Lead                       [📞 Call] [✓] [🕐]          │
│ Acme · test 5                                                │
│ …preview blocks…                                             │
└─────────────────────────────────────────────────────────────┘

Mobile (<sm, header wraps):
┌───────────────────────────────┐
│ Test2 Lead                    │
│ Acme · test 5                 │
│              [📞] [✓] [🕐]     │
│ …preview blocks…              │
└───────────────────────────────┘
```

### Changes to `OutreachCard.tsx`

- Header row: outer flex uses `flex-wrap gap-2`; name/company column keeps `min-w-0 flex-1`; action group is `flex items-center gap-1 shrink-0 ml-auto`.
- Primary action button:
  - Icon always visible.
  - Text label hidden on mobile for longer labels (`WhatsApp`, `Connecting…`, `Message`, `Send email`) via `hidden sm:inline`; short labels like `Call` / `Send` stay visible on all sizes.
  - Height: `h-9 sm:h-8` so it aligns with icon buttons on each breakpoint.
- Secondary buttons (Mark as handled, Snooze):
  - Icon-only `Button` (`variant="ghost" size="icon"`).
  - Size: `h-9 w-9 sm:h-8 sm:w-8` for 36px mobile tap target.
  - `title` + `aria-label` on both; existing tooltips preserved on desktop.
- Snooze dropdown: `DropdownMenuContent align="end"` so it opens leftward and doesn't clip on phones. Menu items unchanged (3 / 5 / 7 days + Skip).
- No changes to preview blocks, business logic, `snoozeTouch`, `advanceColdEnrollment`, or `outreach-touch-action`.

### Out of scope

- No changes to `QueueCard.tsx`, `Queue.tsx`, edge functions, or DB.
- No copy changes beyond hiding long labels on mobile.

### Verification

- Resize preview to 360px, 768px, 1280px: header wraps cleanly, three buttons stay right-aligned in one row, Snooze menu doesn't clip.
- Primary action still fires; `Mark as handled` calls `advance`; Snooze 3/5/7 calls `snooze`.
