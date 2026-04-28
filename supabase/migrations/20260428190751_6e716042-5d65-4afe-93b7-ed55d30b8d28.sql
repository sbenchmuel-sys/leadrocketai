UPDATE public.leads
SET next_action_key = 'reply_now',
    next_action_label = 'Reply'
WHERE next_action_key IN ('whatsapp_reply', 'whatsapp_failed')
   OR next_action_label ILIKE '%WhatsApp%';