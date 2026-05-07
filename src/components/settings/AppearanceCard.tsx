import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun, description: "Bright background, easier on the eyes in daylight" },
  { value: "dark", label: "Dark", icon: Moon, description: "Dim background, easier on the eyes at night" },
  { value: "system", label: "System", icon: Monitor, description: "Match your operating system preference" },
] as const;

export function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // next-themes can't read the resolved theme until after hydration
  useEffect(() => {
    setMounted(true);
  }, []);

  const current = mounted ? theme ?? "dark" : "dark";

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Choose how DrivePilot looks on this device. The setting is saved per browser.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {OPTIONS.map(({ value, label, icon: Icon, description }) => {
          const selected = current === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              aria-pressed={selected}
              className={cn(
                "flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors",
                "hover:border-primary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "border-primary bg-accent" : "border-border bg-card",
              )}
            >
              <div className="flex w-full items-center justify-between">
                <Icon className="h-4 w-4 text-muted-foreground" />
                {selected && (
                  <span className="text-[10px] font-medium uppercase tracking-wide text-primary">
                    Selected
                  </span>
                )}
              </div>
              <div className="font-medium">{label}</div>
              <div className="text-xs text-muted-foreground">{description}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
