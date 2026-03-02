// Feature flags — read from env at build time
export const flags = {
  dev_smoke: import.meta.env.VITE_DEV_SMOKE === "1",
  ui_v2: import.meta.env.VITE_UI_V2 !== "0",
  evidence_debug: import.meta.env.VITE_EVIDENCE_DEBUG === "1",
} as const;
