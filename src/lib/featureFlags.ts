// Feature flags — read from env at build time
export const flags = {
  dev_smoke: import.meta.env.VITE_DEV_SMOKE === "1",
} as const;
