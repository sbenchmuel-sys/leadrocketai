/**
 * Demo Mode Toggle
 * 
 * When enabled via VITE_DEMO_MODE=true, the app loads curated
 * demo data instead of querying the database. No writes occur.
 */

export const isDemoMode = (): boolean => {
  return import.meta.env.VITE_DEMO_MODE === "true";
};
