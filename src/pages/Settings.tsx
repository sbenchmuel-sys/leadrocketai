import { GmailConnectionCard } from "@/components/gmail/GmailConnectionCard";
import { ZoomMeetingSyncCard } from "@/components/settings/ZoomMeetingSyncCard";
import { UnmatchedMeetingSummariesCard } from "@/components/settings/UnmatchedMeetingSummariesCard";
import { MatchedMeetingSummariesCard } from "@/components/settings/MatchedMeetingSummariesCard";
import { RepProfileCard } from "@/components/settings/RepProfileCard";
import { SignaturesCard } from "@/components/settings/SignaturesCard";
import { WorkspaceProfileCard } from "@/components/settings/WorkspaceProfileCard";
import { CadenceSettingsCard } from "@/components/settings/CadenceSettingsCard";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Building2, Clock, User, PenLine, Mail, Video, AlertCircle, ArrowRightLeft } from "lucide-react";

export default function Settings() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">Manage your account and integrations</p>
      </div>

      <Accordion type="multiple" defaultValue={["workspace"]} className="max-w-2xl space-y-2">
        <AccordionItem value="workspace" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Building2 className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Workspace Profile</div>
                <div className="text-sm text-muted-foreground font-normal">Company and product info for AI emails</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <WorkspaceProfileCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="cadence" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Email Cadence Settings</div>
                <div className="text-sm text-muted-foreground font-normal">Configure automation timing and rules</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <CadenceSettingsCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="profile" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <User className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Your Profile</div>
                <div className="text-sm text-muted-foreground font-normal">Your info for signatures and personalization</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <RepProfileCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="signatures" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <PenLine className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Email Signatures</div>
                <div className="text-sm text-muted-foreground font-normal">Create and manage email signatures</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <SignaturesCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="gmail" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Mail className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Gmail Integration</div>
                <div className="text-sm text-muted-foreground font-normal">Sync emails and send messages</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <GmailConnectionCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="zoom" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Video className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Zoom Meeting Sync</div>
                <div className="text-sm text-muted-foreground font-normal">Auto-detect Zoom meeting summary emails</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <ZoomMeetingSyncCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="unmatched" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Unmatched Meeting Summaries</div>
                <div className="text-sm text-muted-foreground font-normal">Match orphaned Zoom summaries to leads</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <UnmatchedMeetingSummariesCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="reassign" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <ArrowRightLeft className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Reassign Meeting Summaries</div>
                <div className="text-sm text-muted-foreground font-normal">Fix incorrectly matched summaries</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <MatchedMeetingSummariesCard />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
