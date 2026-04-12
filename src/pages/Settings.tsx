import { GmailConnectionCard } from "@/components/gmail/GmailConnectionCard";
import { ZoomMeetingSyncCard } from "@/components/settings/ZoomMeetingSyncCard";
import { WhatsAppConnectionCard } from "@/components/settings/WhatsAppConnectionCard";
import { WhatsAppAutomationCard } from "@/components/settings/WhatsAppAutomationCard";
import { RepProfileCard } from "@/components/settings/RepProfileCard";
import { SignaturesCard } from "@/components/settings/SignaturesCard";
import { WorkspaceProfileCard } from "@/components/settings/WorkspaceProfileCard";
import { CadenceSettingsCard } from "@/components/settings/CadenceSettingsCard";
import { OutlookConnectionCard } from "@/components/settings/OutlookConnectionCard";
import { WorkspaceMembersCard } from "@/components/settings/WorkspaceMembersCard";
import { SmsSettingsCard } from "@/components/settings/SmsSettingsCard";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CallSettingsCard } from "@/components/settings/CallSettingsCard";
import { Building2, Clock, User, Mail, Video, MessageSquare, Plug, Zap, Info, Phone, Users } from "lucide-react";

export default function Settings() {
  const { workspaceId } = useWorkspace();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">Manage your account and integrations</p>
      </div>

      <Accordion type="multiple" defaultValue={[]} className="max-w-2xl space-y-2">
        <AccordionItem value="team" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Users className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Workspace & Team</div>
                <div className="text-sm text-muted-foreground font-normal">Manage members, roles, and invitations</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <WorkspaceMembersCard />
          </AccordionContent>
        </AccordionItem>

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
          <AccordionContent>
            <Accordion type="multiple" defaultValue={[]} className="space-y-2">
              <AccordionItem value="gmail" className="border rounded-lg px-4">
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">Gmail</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <GmailConnectionCard />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="outlook" className="border rounded-lg px-4">
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">Outlook</span>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 border-yellow-500/60 text-yellow-700 dark:text-yellow-400 cursor-help ml-1"
                          >
                            <Info className="h-2.5 w-2.5 mr-0.5" />
                            Beta
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[220px] text-xs">
                          Outlook integration is in beta. Multi-mailbox supported. Shared mailboxes not yet supported.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <OutlookConnectionCard />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="whatsapp" className="border rounded-lg px-4">
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">WhatsApp</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <WhatsAppConnectionCard />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="zoom" className="border rounded-lg px-4">
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center gap-2">
                    <Video className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">Zoom Meeting Sync</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <ZoomMeetingSyncCard />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="wa-automation" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Zap className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">WhatsApp Automation Policy</div>
                <div className="text-sm text-muted-foreground font-normal">Control when AI auto-sends WhatsApp replies workspace-wide</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <WhatsAppAutomationCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="sms" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Phone className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">SMS</div>
                <div className="text-sm text-muted-foreground font-normal">Enable SMS outreach via Twilio</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <SmsSettingsCard />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="calls" className="border rounded-lg px-4">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Phone className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <div className="font-semibold">Calls / Voice</div>
                <div className="text-sm text-muted-foreground font-normal">Configure call recording, transcription, and analysis settings</div>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <CallSettingsCard workspaceId={workspaceId ?? undefined} />
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
