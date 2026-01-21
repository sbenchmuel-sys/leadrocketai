import { GmailConnectionCard } from "@/components/gmail/GmailConnectionCard";
import { ZoomMeetingSyncCard } from "@/components/settings/ZoomMeetingSyncCard";
import { UnmatchedMeetingSummariesCard } from "@/components/settings/UnmatchedMeetingSummariesCard";
import { MatchedMeetingSummariesCard } from "@/components/settings/MatchedMeetingSummariesCard";
import { RepProfileCard } from "@/components/settings/RepProfileCard";
import { SignaturesCard } from "@/components/settings/SignaturesCard";

export default function Settings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">Manage your account and integrations</p>
      </div>

      <div className="grid gap-6 max-w-2xl">
        <RepProfileCard />
        <SignaturesCard />
        <GmailConnectionCard />
        <ZoomMeetingSyncCard />
        <UnmatchedMeetingSummariesCard />
        <MatchedMeetingSummariesCard />
      </div>
    </div>
  );
}
