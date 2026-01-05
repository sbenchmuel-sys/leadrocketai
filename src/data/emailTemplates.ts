export type TemplateCategory = 
  | 'initial_outreach' 
  | 'followup' 
  | 'meeting' 
  | 'objection' 
  | 'deal_progression';

export type TemplateStrategy = 'fast' | 'nurture' | 'both';

export interface EmailTemplate {
  id: string;
  category: TemplateCategory;
  name: string;
  description: string;
  subject: string;
  body: string;
  placeholders: string[];
  strategy: TemplateStrategy;
}

export const TEMPLATE_CATEGORIES: Record<TemplateCategory, { label: string; description: string }> = {
  initial_outreach: {
    label: 'Initial Outreach',
    description: 'First contact with new prospects'
  },
  followup: {
    label: 'Follow-up',
    description: 'Re-engage after no response'
  },
  meeting: {
    label: 'Meeting',
    description: 'Scheduling and meeting-related'
  },
  objection: {
    label: 'Objection Handling',
    description: 'Address common concerns'
  },
  deal_progression: {
    label: 'Deal Progression',
    description: 'Move deals forward'
  }
};

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  // Initial Outreach
  {
    id: 'cold-outreach-fast',
    category: 'initial_outreach',
    name: 'Direct Cold Outreach',
    description: 'Concise, direct introduction with clear CTA',
    subject: 'Quick question for {{COMPANY}}',
    body: `Hi {{LEAD_NAME}},

I noticed {{COMPANY}} and wanted to reach out directly.

We help companies like yours streamline their operations and I believe there's a specific way we could help you achieve similar results.

Would you have 15 minutes this week for a quick call to explore if there's a fit?

{{MEETING_LINK}}

Best,
{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'MEETING_LINK', 'SENDER_NAME'],
    strategy: 'fast'
  },
  {
    id: 'warm-intro',
    category: 'initial_outreach',
    name: 'Warm Introduction',
    description: 'Referral-based outreach with mutual connection',
    subject: 'Introduction via mutual connection',
    body: `Hi {{LEAD_NAME}},

I hope this message finds you well. [Mutual connection name] suggested I reach out to you regarding [specific topic].

They mentioned that {{COMPANY}} is currently exploring [area of focus], and I thought there might be some interesting synergies to discuss.

I'd love to learn more about your current initiatives and share how we've helped similar organizations. Would you be open to a brief conversation?

Looking forward to connecting,
{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'nurture'
  },
  {
    id: 'event-followup',
    category: 'initial_outreach',
    name: 'Event/Conference Follow-up',
    description: 'Follow up after meeting at an event',
    subject: 'Great meeting you at [Event Name]',
    body: `Hi {{LEAD_NAME}},

It was great connecting with you at [Event Name] yesterday. I really enjoyed our conversation about [topic discussed].

As promised, I wanted to follow up and continue our discussion about how we might be able to help {{COMPANY}} with [specific area].

Would you have time for a quick call this week to dive deeper?

{{MEETING_LINK}}

Best regards,
{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'MEETING_LINK', 'SENDER_NAME'],
    strategy: 'fast'
  },

  // Follow-up
  {
    id: 'quick-checkin',
    category: 'followup',
    name: 'Quick Check-in',
    description: 'Gentle follow-up after no response',
    subject: 'Following up',
    body: `Hi {{LEAD_NAME}},

I wanted to follow up on my previous message. I understand you're busy, so I'll keep this brief.

I'm still interested in exploring how we could help {{COMPANY}}. Would a quick 10-minute call work for you this week?

If timing isn't right, just let me know and I'm happy to reconnect when it makes more sense.

Best,
{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'fast'
  },
  {
    id: 'value-add-followup',
    category: 'followup',
    name: 'Value-Add Follow-up',
    description: 'Share useful content or insight',
    subject: 'Thought you might find this useful',
    body: `Hi {{LEAD_NAME}},

I came across this [article/report/case study] about [relevant topic] and immediately thought of our conversation about {{COMPANY}}'s goals.

[Brief summary of the resource and why it's relevant]

Here's the link: [Resource URL]

No pressure to respond—just wanted to share something I thought could be valuable. If you'd ever like to discuss how this applies to your situation, I'm always happy to chat.

Best,
{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'nurture'
  },
  {
    id: 'breakup-email',
    category: 'followup',
    name: 'Breakup Email',
    description: 'Final attempt before closing the loop',
    subject: 'Should I close your file?',
    body: `Hi {{LEAD_NAME}},

I've tried reaching out a few times but haven't heard back, which tells me one of three things:

1. You're swamped and this isn't a priority right now
2. You've gone with another solution
3. You're being chased by a bear and can't respond

If it's #1 or #2, no worries at all—I completely understand. Just let me know and I'll close your file on my end.

If it's #3, please let me know if you're okay!

Either way, I wish you and {{COMPANY}} all the best.

{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'both'
  },

  // Meeting
  {
    id: 'meeting-confirmation',
    category: 'meeting',
    name: 'Meeting Confirmation',
    description: 'Confirm upcoming meeting details',
    subject: 'Confirmed: Our call on [Date/Time]',
    body: `Hi {{LEAD_NAME}},

Looking forward to our call on [Date] at [Time].

Here are the details:
- Duration: 30 minutes
- Link: {{MEETING_LINK}}
- Agenda: [Brief agenda points]

Please let me know if you need to reschedule or have any questions beforehand.

See you soon!
{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'MEETING_LINK', 'SENDER_NAME'],
    strategy: 'both'
  },
  {
    id: 'meeting-reminder',
    category: 'meeting',
    name: 'Meeting Reminder (24h)',
    description: 'Reminder one day before meeting',
    subject: 'Reminder: Our call tomorrow',
    body: `Hi {{LEAD_NAME}},

Just a friendly reminder about our call tomorrow at [Time].

Here's the meeting link: {{MEETING_LINK}}

Looking forward to speaking with you!

{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'MEETING_LINK', 'SENDER_NAME'],
    strategy: 'both'
  },
  {
    id: 'meeting-reschedule',
    category: 'meeting',
    name: 'Reschedule Request',
    description: 'Request to reschedule a meeting',
    subject: 'Can we reschedule our call?',
    body: `Hi {{LEAD_NAME}},

I apologize, but something has come up and I need to reschedule our call originally planned for [Original Date/Time].

Would any of these times work for you instead?
- [Option 1]
- [Option 2]
- [Option 3]

Or feel free to pick a time that works best: {{MEETING_LINK}}

Again, my apologies for any inconvenience.

Best,
{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'MEETING_LINK', 'SENDER_NAME'],
    strategy: 'both'
  },
  {
    id: 'post-meeting-thankyou',
    category: 'meeting',
    name: 'Post-Meeting Thank You',
    description: 'Thank you and next steps after meeting',
    subject: 'Great speaking with you today',
    body: `Hi {{LEAD_NAME}},

Thank you for taking the time to meet today. I really enjoyed learning more about {{COMPANY}} and your goals.

As discussed, here are the next steps:
- [Next step 1]
- [Next step 2]
- [Next step 3]

I'll [specific action you're taking] by [date]. In the meantime, feel free to reach out if any questions come up.

Looking forward to continuing our conversation!

Best,
{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'both'
  },

  // Objection Handling
  {
    id: 'objection-budget',
    category: 'objection',
    name: 'Budget Concerns',
    description: 'Address pricing/budget objections',
    subject: 'Re: Budget considerations',
    body: `Hi {{LEAD_NAME}},

I appreciate you being upfront about budget constraints—it's a common concern we hear.

A few thoughts:
1. We offer flexible payment options that might ease the initial investment
2. Our typical client sees ROI within [timeframe], which often justifies the spend
3. We could start with a smaller scope and expand as you see results

Would it help to walk through a quick ROI analysis for {{COMPANY}}? I can show you exactly how similar companies have justified the investment.

Let me know your thoughts.

{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'nurture'
  },
  {
    id: 'objection-timing',
    category: 'objection',
    name: 'Timing/Priority',
    description: 'When timing isn\'t right',
    subject: 'Re: Timing considerations',
    body: `Hi {{LEAD_NAME}},

Completely understand that timing is critical. A few quick questions to help me understand:

1. Is this something you'd like to revisit in Q[X]?
2. Are there specific milestones or triggers that would make this more timely?
3. Would it be helpful to have a high-level overview prepared for when the timing is right?

Happy to stay in touch and reconnect when it makes more sense for {{COMPANY}}.

Best,
{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'nurture'
  },
  {
    id: 'objection-existing-solution',
    category: 'objection',
    name: 'Already Have a Solution',
    description: 'When they use a competitor',
    subject: 'Re: Your current solution',
    body: `Hi {{LEAD_NAME}},

Thanks for letting me know you're already using [Competitor/Current Solution]. That's actually great—it means you already see the value in solving this problem.

Out of curiosity, how is it working for you? Most companies I talk to who use [Competitor] mention challenges with [common pain point].

I'm not here to convince you to switch, but it might be worth a quick conversation to compare notes. Sometimes a fresh perspective reveals opportunities.

Would you be open to a 15-minute chat?

{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'SENDER_NAME'],
    strategy: 'nurture'
  },

  // Deal Progression
  {
    id: 'proposal-followup',
    category: 'deal_progression',
    name: 'Proposal Follow-up',
    description: 'Follow up after sending a proposal',
    subject: 'Thoughts on the proposal?',
    body: `Hi {{LEAD_NAME}},

I wanted to check in and see if you've had a chance to review the proposal I sent over.

Happy to jump on a quick call to walk through any questions or discuss adjustments. Our goal is to make sure this works perfectly for {{COMPANY}}.

What questions can I answer?

{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'fast'
  },
  {
    id: 'contract-sent',
    category: 'deal_progression',
    name: 'Contract Sent Follow-up',
    description: 'After sending contract for signature',
    subject: 'Contract ready for review',
    body: `Hi {{LEAD_NAME}},

I've just sent over the contract for your review. You should receive it via [DocuSign/email/etc.] shortly.

Please take your time reviewing everything. If you have any questions or need any changes, just let me know—I'm happy to make adjustments.

Once signed, here's what happens next:
1. [Onboarding step 1]
2. [Onboarding step 2]
3. [Expected timeline]

Excited to officially get started with {{COMPANY}}!

{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'fast'
  },
  {
    id: 'decision-timeline',
    category: 'deal_progression',
    name: 'Decision Timeline Check-in',
    description: 'Understand their decision timeline',
    subject: 'Quick question about next steps',
    body: `Hi {{LEAD_NAME}},

I wanted to touch base and get a sense of {{COMPANY}}'s timeline for making a decision.

A few questions that would help me support you better:
1. What's your target date for having a solution in place?
2. Are there other stakeholders who need to be involved in the decision?
3. Is there anything else you need from me to move forward?

Just want to make sure I'm being helpful without being pushy.

Best,
{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'nurture'
  },
  {
    id: 'stakeholder-intro',
    category: 'deal_progression',
    name: 'Stakeholder Introduction Request',
    description: 'Ask to meet other decision makers',
    subject: 'Involving your team',
    body: `Hi {{LEAD_NAME}},

As we move forward, I want to make sure we're addressing everyone's priorities at {{COMPANY}}.

Would it make sense to include [other stakeholder role, e.g., your CTO, finance team] in our next conversation? I find that involving key stakeholders early helps ensure everyone's aligned and speeds up the overall process.

Happy to adjust my presentation to address their specific concerns.

Let me know your thoughts!

{{SENDER_NAME}}`,
    placeholders: ['LEAD_NAME', 'COMPANY', 'SENDER_NAME'],
    strategy: 'fast'
  }
];

export function getTemplatesByCategory(category: TemplateCategory): EmailTemplate[] {
  return EMAIL_TEMPLATES.filter(t => t.category === category);
}

export function getTemplatesByStrategy(strategy: TemplateStrategy): EmailTemplate[] {
  return EMAIL_TEMPLATES.filter(t => t.strategy === strategy || t.strategy === 'both');
}

export function fillTemplatePlaceholders(
  template: EmailTemplate,
  values: Record<string, string>
): { subject: string; body: string } {
  let subject = template.subject;
  let body = template.body;

  for (const [key, value] of Object.entries(values)) {
    const placeholder = `{{${key}}}`;
    subject = subject.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
    body = body.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
  }

  return { subject, body };
}
