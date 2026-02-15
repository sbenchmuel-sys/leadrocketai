

# Add Navigation Button to Onboarding Page

## What Changes
Add a small navigation link/button in the onboarding header area that lets users leave the onboarding flow:
- If onboarding is already done (edge case), it links to `/app` (Dashboard)
- Otherwise, it links to `/` (Homepage/Landing)

## File to Modify

**`src/pages/Onboarding.tsx`**
- Add a button (e.g., a subtle ghost button with a home or arrow-left icon) in the top-left area of the progress header
- Use `useAuth` to check `profile?.onboarding_done` to determine the destination (`/app` vs `/`)
- Use `react-router-dom`'s `Link` or `useNavigate` for navigation

The button will sit above or beside the step indicator, styled as a minimal ghost/link button (e.g., "Back to Home" with an ArrowLeft icon) so it doesn't distract from the onboarding flow but remains accessible.

