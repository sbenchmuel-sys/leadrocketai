import { GmailConnectionCard } from "@/components/gmail/GmailConnectionCard";
import { ZoomMeetingSyncCard } from "@/components/settings/ZoomMeetingSyncCard";
import { UnmatchedMeetingSummariesCard } from "@/components/settings/UnmatchedMeetingSummariesCard";

export default function Settings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">Manage your account and integrations</p>
      </div>

      <div className="grid gap-6 max-w-2xl">
        <GmailConnectionCard />
        <ZoomMeetingSyncCard />
        <UnmatchedMeetingSummariesCard />
      </div>
    </div>
  );
}
