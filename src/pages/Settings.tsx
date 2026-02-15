import { GmailConnectionCard } from "@/components/gmail/GmailConnectionCard";
import { ZoomMeetingSyncCard } from "@/components/settings/ZoomMeetingSyncCard";
import { WhatsAppConnectionCard } from "@/components/settings/WhatsAppConnectionCard";
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
import { Building2, Clock, User, Mail, Video, MessageSquare, Plug } from "lucide-react";

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

        <AccordionItem value="profile" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <User className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Your Profile</div>
                <div className="text-sm text-muted-foreground font-normal">Your info, signatures, and personalization</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-6">
            <RepProfileCard />
            <SignaturesCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="integrations" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Plug className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Integrations</div>
                <div className="text-sm text-muted-foreground font-normal">Connect email, messaging, and meeting tools</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-4">
            <GmailConnectionCard />
            <WhatsAppConnectionCard />
            <ZoomMeetingSyncCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="cadence" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Sequence & Cadence Settings</div>
                <div className="text-sm text-muted-foreground font-normal">Configure Email & WhatsApp timing and sequence rules</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <CadenceSettingsCard />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
