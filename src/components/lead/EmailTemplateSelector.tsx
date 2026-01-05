import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { FileText, ChevronRight, ArrowLeft } from "lucide-react";
import { 
  EMAIL_TEMPLATES, 
  TEMPLATE_CATEGORIES, 
  EmailTemplate, 
  TemplateCategory,
  fillTemplatePlaceholders 
} from "@/data/emailTemplates";

interface Lead {
  id: string;
  name: string;
  company: string;
  email: string;
  meeting_link?: string | null;
  strategy: string;
}

interface EmailTemplateSelectorProps {
  lead: Lead;
  onSelectTemplate: (subject: string, body: string) => void;
}

export function EmailTemplateSelector({ lead, onSelectTemplate }: EmailTemplateSelectorProps) {
  const [open, setOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<TemplateCategory | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);

  const handleSelectTemplate = (template: EmailTemplate) => {
    setSelectedTemplate(template);
  };

  const handleUseTemplate = () => {
    if (!selectedTemplate) return;

    const values: Record<string, string> = {
      LEAD_NAME: lead.name.split(' ')[0], // First name
      COMPANY: lead.company,
      MEETING_LINK: lead.meeting_link || '[Your meeting link]',
      SENDER_NAME: '[Your name]'
    };

    const { subject, body } = fillTemplatePlaceholders(selectedTemplate, values);
    onSelectTemplate(subject, body);
    setOpen(false);
    setSelectedCategory(null);
    setSelectedTemplate(null);
  };

  const handleBack = () => {
    if (selectedTemplate) {
      setSelectedTemplate(null);
    } else if (selectedCategory) {
      setSelectedCategory(null);
    }
  };

  const getStrategyBadgeVariant = (strategy: string) => {
    switch (strategy) {
      case 'fast': return 'default';
      case 'nurture': return 'secondary';
      default: return 'outline';
    }
  };

  const templatesInCategory = selectedCategory 
    ? EMAIL_TEMPLATES.filter(t => t.category === selectedCategory)
    : [];

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (!isOpen) {
        setSelectedCategory(null);
        setSelectedTemplate(null);
      }
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileText className="h-4 w-4 mr-2" />
          Use Template
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {(selectedCategory || selectedTemplate) && (
              <Button variant="ghost" size="icon" onClick={handleBack} className="h-8 w-8">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <DialogTitle>
              {selectedTemplate 
                ? selectedTemplate.name 
                : selectedCategory 
                  ? TEMPLATE_CATEGORIES[selectedCategory].label
                  : 'Email Templates'}
            </DialogTitle>
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[400px] pr-4">
          {!selectedCategory && !selectedTemplate && (
            <div className="space-y-2">
              {(Object.entries(TEMPLATE_CATEGORIES) as [TemplateCategory, { label: string; description: string }][]).map(
                ([key, { label, description }]) => {
                  const count = EMAIL_TEMPLATES.filter(t => t.category === key).length;
                  return (
                    <button
                      key={key}
                      onClick={() => setSelectedCategory(key)}
                      className="w-full flex items-center justify-between p-3 rounded-lg border border-border hover:bg-accent transition-colors text-left"
                    >
                      <div>
                        <div className="font-medium">{label}</div>
                        <div className="text-sm text-muted-foreground">{description}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{count}</Badge>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </button>
                  );
                }
              )}
            </div>
          )}

          {selectedCategory && !selectedTemplate && (
            <div className="space-y-2">
              {templatesInCategory.map((template) => (
                <button
                  key={template.id}
                  onClick={() => handleSelectTemplate(template)}
                  className="w-full flex items-center justify-between p-3 rounded-lg border border-border hover:bg-accent transition-colors text-left"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{template.name}</span>
                      <Badge variant={getStrategyBadgeVariant(template.strategy)} className="text-xs">
                        {template.strategy}
                      </Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">{template.description}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                </button>
              ))}
            </div>
          )}

          {selectedTemplate && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Badge variant={getStrategyBadgeVariant(selectedTemplate.strategy)}>
                  {selectedTemplate.strategy} strategy
                </Badge>
              </div>
              
              <div>
                <label className="text-sm font-medium text-muted-foreground">Subject</label>
                <div className="mt-1 p-2 bg-muted rounded-md text-sm">
                  {fillTemplatePlaceholders(selectedTemplate, {
                    LEAD_NAME: lead.name.split(' ')[0],
                    COMPANY: lead.company,
                    MEETING_LINK: lead.meeting_link || '[Your meeting link]',
                    SENDER_NAME: '[Your name]'
                  }).subject}
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-muted-foreground">Body Preview</label>
                <div className="mt-1 p-3 bg-muted rounded-md text-sm whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                  {fillTemplatePlaceholders(selectedTemplate, {
                    LEAD_NAME: lead.name.split(' ')[0],
                    COMPANY: lead.company,
                    MEETING_LINK: lead.meeting_link || '[Your meeting link]',
                    SENDER_NAME: '[Your name]'
                  }).body}
                </div>
              </div>

              <Button onClick={handleUseTemplate} className="w-full">
                Use This Template
              </Button>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
