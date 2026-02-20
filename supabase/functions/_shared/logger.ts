// ============================================================
// Structured logger — replaces all console.log in Outlook functions
// Emits JSON lines for observability pipelines
// ============================================================

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEvent {
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line: LogEvent = {
    level,
    event,
    ts: new Date().toISOString(),
    ...fields,
  };
  // Deno runtime: use console.error for errors, console.log for rest
  // but always structured JSON
  if (level === "error") {
    console.error(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

export const logger = {
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
};
