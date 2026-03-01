import { useEffect, useState } from "react";
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBrowserCall } from "./BrowserCallProvider";

export function ActiveCallBar() {
  const { status, leadName, toNumber, isMuted, startedAt, hangUp, toggleMute } = useBrowserCall();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status !== "on-call" || !startedAt) {
      setElapsed(0);
      return;
    }

    const tick = () => setElapsed(Math.floor((Date.now() - startedAt.getTime()) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status, startedAt]);

  if (status !== "connecting" && status !== "on-call") return null;

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = `${mins}:${secs.toString().padStart(2, "0")}`;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-primary text-primary-foreground px-4 py-2 flex items-center justify-between shadow-lg">
      <div className="flex items-center gap-3">
        <Phone className="h-4 w-4 animate-pulse" />
        <span className="text-sm font-medium">
          {status === "connecting" ? "Connecting…" : `On call with ${leadName ?? toNumber}`}
        </span>
        {status === "on-call" && (
          <span className="text-sm font-mono opacity-80">{timeStr}</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {status === "on-call" && (
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5"
            onClick={toggleMute}
          >
            {isMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            {isMuted ? "Unmute" : "Mute"}
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive"
          className="h-8 gap-1.5"
          onClick={hangUp}
        >
          <PhoneOff className="h-3.5 w-3.5" />
          End Call
        </Button>
      </div>
    </div>
  );
}
