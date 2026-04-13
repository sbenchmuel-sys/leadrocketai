UPDATE public.call_settings
SET supported_languages = ARRAY['en-US', 'es-US', 'fr-CA', 'he-IL'],
    updated_at = now();