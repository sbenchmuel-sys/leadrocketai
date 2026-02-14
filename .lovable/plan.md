

## Add Privacy Policy Page

### Overview
Create a public (no auth required) Privacy Policy page at `/privacy` with the full policy content provided, styled consistently with the app's design system.

### Implementation

**1. New file: `src/pages/Privacy.tsx`**
- A standalone page component with the full privacy policy text
- Clean, readable layout with proper heading hierarchy (h1, h2, h3)
- Uses existing Tailwind classes for consistent styling
- Includes a "Back" link to return to the app
- Shows effective date as February 14, 2026 (today) and last updated date
- No authentication required -- publicly accessible

**2. Update: `src/App.tsx`**
- Import the new `Privacy` component
- Add a `<Route path="/privacy" element={<Privacy />} />` as a public route (alongside `/auth`, before the catch-all `*` route)

### Design
- White/card background with max-width container for readability
- Proper spacing between sections using Tailwind's `space-y` utilities
- DrivePilot branding in the header
- Responsive layout that works on mobile and desktop
- No sidebar or dashboard chrome -- standalone page like the auth page

### Files Changed

| File | Change |
|------|--------|
| `src/pages/Privacy.tsx` | New file -- full privacy policy page |
| `src/App.tsx` | Add `/privacy` route |

