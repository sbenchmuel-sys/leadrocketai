

## Problem

The `src/App.css` file contains leftover Vite boilerplate styles that set `max-width: 1280px`, `padding: 2rem`, and `text-align: center` on `#root`. This constrains the dashboard layout and makes it look "spread out" with unnecessary padding and centering.

## Plan

### Step 1: Remove or clear App.css boilerplate

Remove all styles from `src/App.css` (or delete the file entirely and remove its import from wherever it's imported). These styles conflict with the full-width dashboard layout.

### Step 2: Verify App.css import

Check if `App.css` is imported in `App.tsx` or elsewhere and remove the import if the file is deleted.

### Finding the Publish button

The Publish button is part of the **Lovable editor UI**, not the app itself. On desktop, it's a globe/web icon in the **top right corner** of the editor. On mobile, tap the **"..." button** in the bottom-right corner → "Publish".

