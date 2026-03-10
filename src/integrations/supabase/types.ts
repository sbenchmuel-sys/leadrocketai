export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      automation_log: {
        Row: {
          action_key: string | null
          ai_task: string | null
          completed_at: string | null
          created_at: string
          error_message: string | null
          gmail_message_id: string | null
          id: string
          lead_id: string
          mail_account_id: string | null
          owner_user_id: string
          status: string
          subject: string | null
        }
        Insert: {
          action_key?: string | null
          ai_task?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          gmail_message_id?: string | null
          id?: string
          lead_id: string
          mail_account_id?: string | null
          owner_user_id: string
          status?: string
          subject?: string | null
        }
        Update: {
          action_key?: string | null
          ai_task?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          gmail_message_id?: string | null
          id?: string
          lead_id?: string
          mail_account_id?: string | null
          owner_user_id?: string
          status?: string
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "automation_log_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_log_mail_account_id_fkey"
            columns: ["mail_account_id"]
            isOneToOne: false
            referencedRelation: "mail_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_logs: {
        Row: {
          created_at: string
          decision: string
          id: string
          lead_id: string | null
          message_id: string | null
          reason: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          decision: string
          id?: string
          lead_id?: string | null
          message_id?: string | null
          reason?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          decision?: string
          id?: string
          lead_id?: string | null
          message_id?: string | null
          reason?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      call_analyses: {
        Row: {
          action_items_json: Json | null
          call_session_id: string
          created_at: string
          id: string
          model: string | null
          recommended_next_steps_json: Json | null
          signals_json: Json | null
          status: string
          summary_long: string | null
          summary_short: string | null
          updated_at: string
          version: string | null
        }
        Insert: {
          action_items_json?: Json | null
          call_session_id: string
          created_at?: string
          id?: string
          model?: string | null
          recommended_next_steps_json?: Json | null
          signals_json?: Json | null
          status?: string
          summary_long?: string | null
          summary_short?: string | null
          updated_at?: string
          version?: string | null
        }
        Update: {
          action_items_json?: Json | null
          call_session_id?: string
          created_at?: string
          id?: string
          model?: string | null
          recommended_next_steps_json?: Json | null
          signals_json?: Json | null
          status?: string
          summary_long?: string | null
          summary_short?: string | null
          updated_at?: string
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_analyses_call_session_id_fkey"
            columns: ["call_session_id"]
            isOneToOne: true
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      call_recordings: {
        Row: {
          call_session_id: string
          channels: number | null
          created_at: string
          downloaded_at: string | null
          duration_sec: number | null
          format: string | null
          id: string
          recording_sid: string
          sha256: string | null
          status: string
          storage_path: string | null
          storage_provider: string | null
          storage_url: string | null
          twilio_recording_url: string | null
          updated_at: string
        }
        Insert: {
          call_session_id: string
          channels?: number | null
          created_at?: string
          downloaded_at?: string | null
          duration_sec?: number | null
          format?: string | null
          id?: string
          recording_sid: string
          sha256?: string | null
          status?: string
          storage_path?: string | null
          storage_provider?: string | null
          storage_url?: string | null
          twilio_recording_url?: string | null
          updated_at?: string
        }
        Update: {
          call_session_id?: string
          channels?: number | null
          created_at?: string
          downloaded_at?: string | null
          duration_sec?: number | null
          format?: string | null
          id?: string
          recording_sid?: string
          sha256?: string | null
          status?: string
          storage_path?: string | null
          storage_provider?: string | null
          storage_url?: string | null
          twilio_recording_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_recordings_call_session_id_fkey"
            columns: ["call_session_id"]
            isOneToOne: false
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      call_sessions: {
        Row: {
          agent_user_id: string | null
          answered_at: string | null
          call_sid: string
          created_at: string
          customer_contact_id: string | null
          direction: string
          duration_sec: number | null
          ended_at: string | null
          from_number: string
          id: string
          lead_id: string | null
          recording_consent_mode: string
          started_at: string | null
          status: string
          to_number: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          agent_user_id?: string | null
          answered_at?: string | null
          call_sid: string
          created_at?: string
          customer_contact_id?: string | null
          direction: string
          duration_sec?: number | null
          ended_at?: string | null
          from_number: string
          id?: string
          lead_id?: string | null
          recording_consent_mode?: string
          started_at?: string | null
          status?: string
          to_number: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          agent_user_id?: string | null
          answered_at?: string | null
          call_sid?: string
          created_at?: string
          customer_contact_id?: string | null
          direction?: string
          duration_sec?: number | null
          ended_at?: string | null
          from_number?: string
          id?: string
          lead_id?: string | null
          recording_consent_mode?: string
          started_at?: string | null
          status?: string
          to_number?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_sessions_customer_contact_id_fkey"
            columns: ["customer_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_sessions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_sessions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      call_settings: {
        Row: {
          analyze_min_duration_sec: number
          audio_retention_days: number
          created_at: string
          default_language: string
          default_twilio_number: string | null
          id: string
          recording_notice_enabled: boolean
          recording_require_dtmf_consent: boolean
          supported_languages: string[]
          transcribe_min_duration_sec: number
          updated_at: string
          webhook_base_url: string | null
          workspace_id: string
        }
        Insert: {
          analyze_min_duration_sec?: number
          audio_retention_days?: number
          created_at?: string
          default_language?: string
          default_twilio_number?: string | null
          id?: string
          recording_notice_enabled?: boolean
          recording_require_dtmf_consent?: boolean
          supported_languages?: string[]
          transcribe_min_duration_sec?: number
          updated_at?: string
          webhook_base_url?: string | null
          workspace_id: string
        }
        Update: {
          analyze_min_duration_sec?: number
          audio_retention_days?: number
          created_at?: string
          default_language?: string
          default_twilio_number?: string | null
          id?: string
          recording_notice_enabled?: boolean
          recording_require_dtmf_consent?: boolean
          supported_languages?: string[]
          transcribe_min_duration_sec?: number
          updated_at?: string
          webhook_base_url?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      call_transcripts: {
        Row: {
          call_session_id: string
          clean_full_text: string | null
          confidence: number | null
          created_at: string
          full_text: string | null
          id: string
          language: string
          llm_formatted_text: string | null
          provider: string
          raw_full_text: string | null
          segments_json: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          call_session_id: string
          clean_full_text?: string | null
          confidence?: number | null
          created_at?: string
          full_text?: string | null
          id?: string
          language?: string
          llm_formatted_text?: string | null
          provider?: string
          raw_full_text?: string | null
          segments_json?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          call_session_id?: string
          clean_full_text?: string | null
          confidence?: number | null
          created_at?: string
          full_text?: string | null
          id?: string
          language?: string
          llm_formatted_text?: string | null
          provider?: string
          raw_full_text?: string | null
          segments_json?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_transcripts_call_session_id_fkey"
            columns: ["call_session_id"]
            isOneToOne: true
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      call_webhook_log: {
        Row: {
          call_sid: string | null
          created_at: string
          error_message: string | null
          event_type: string
          id: string
          payload: Json
          processed_at: string | null
        }
        Insert: {
          call_sid?: string | null
          created_at?: string
          error_message?: string | null
          event_type: string
          id?: string
          payload?: Json
          processed_at?: string | null
        }
        Update: {
          call_sid?: string | null
          created_at?: string
          error_message?: string | null
          event_type?: string
          id?: string
          payload?: Json
          processed_at?: string | null
        }
        Relationships: []
      }
      channel_events: {
        Row: {
          attempts: number
          channel: string
          created_at: string
          event_type: string
          id: string
          last_error: string | null
          payload_normalized: Json
          payload_raw: Json
          processed_at: string | null
          provider: string
          provider_event_id: string
          workspace_id: string | null
        }
        Insert: {
          attempts?: number
          channel?: string
          created_at?: string
          event_type: string
          id?: string
          last_error?: string | null
          payload_normalized?: Json
          payload_raw?: Json
          processed_at?: string | null
          provider?: string
          provider_event_id: string
          workspace_id?: string | null
        }
        Update: {
          attempts?: number
          channel?: string
          created_at?: string
          event_type?: string
          id?: string
          last_error?: string | null
          payload_normalized?: Json
          payload_raw?: Json
          processed_at?: string | null
          provider?: string
          provider_event_id?: string
          workspace_id?: string | null
        }
        Relationships: []
      }
      contact_identities: {
        Row: {
          contact_id: string
          created_at: string
          id: string
          is_primary: boolean
          type: Database["public"]["Enums"]["identity_type"]
          value: string
          workspace_id: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          id?: string
          is_primary?: boolean
          type: Database["public"]["Enums"]["identity_type"]
          value: string
          workspace_id: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          id?: string
          is_primary?: boolean
          type?: Database["public"]["Enums"]["identity_type"]
          value?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_identities_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_identities_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          assigned_rep_user_id: string | null
          company: string | null
          created_at: string
          display_name: string | null
          id: string
          last_activity_at: string
          lead_id: string | null
          notes: string | null
          status: Database["public"]["Enums"]["contact_status"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          assigned_rep_user_id?: string | null
          company?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          last_activity_at?: string
          lead_id?: string | null
          notes?: string | null
          status?: Database["public"]["Enums"]["contact_status"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          assigned_rep_user_id?: string | null
          company?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          last_activity_at?: string
          lead_id?: string | null
          notes?: string | null
          status?: Database["public"]["Enums"]["contact_status"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_analysis: {
        Row: {
          contact_id: string
          conversation_id: string
          created_at: string
          embedding: string | null
          extracted_features: Json
          id: string
          message_window_end: string | null
          message_window_start: string | null
          model_used: string | null
          recommended_reply_channel: string | null
          sentiment: string | null
          summary_short: string | null
          summary_text: string | null
          topics: string[] | null
          urgency: string | null
          workspace_id: string
        }
        Insert: {
          contact_id: string
          conversation_id: string
          created_at?: string
          embedding?: string | null
          extracted_features?: Json
          id?: string
          message_window_end?: string | null
          message_window_start?: string | null
          model_used?: string | null
          recommended_reply_channel?: string | null
          sentiment?: string | null
          summary_short?: string | null
          summary_text?: string | null
          topics?: string[] | null
          urgency?: string | null
          workspace_id: string
        }
        Update: {
          contact_id?: string
          conversation_id?: string
          created_at?: string
          embedding?: string | null
          extracted_features?: Json
          id?: string
          message_window_end?: string | null
          message_window_start?: string | null
          model_used?: string | null
          recommended_reply_channel?: string | null
          sentiment?: string | null
          summary_short?: string | null
          summary_text?: string | null
          topics?: string[] | null
          urgency?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_analysis_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_analysis_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_analysis_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "manager_conversation_metrics"
            referencedColumns: ["conversation_id"]
          },
          {
            foreignKeyName: "conversation_analysis_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          channel: Database["public"]["Enums"]["integration_type"]
          contact_id: string
          created_at: string
          id: string
          integration_id: string | null
          last_message_at: string
          message_count: number
          owner_user_id: string
          provider_thread_id: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          channel?: Database["public"]["Enums"]["integration_type"]
          contact_id: string
          created_at?: string
          id?: string
          integration_id?: string | null
          last_message_at?: string
          message_count?: number
          owner_user_id: string
          provider_thread_id?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["integration_type"]
          contact_id?: string
          created_at?: string
          id?: string
          integration_id?: string | null
          last_message_at?: string
          message_count?: number
          owner_user_id?: string
          provider_thread_id?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      drafts: {
        Row: {
          body_text: string
          channel: string
          created_at: string
          created_by: string | null
          draft_type: string
          id: string
          lead_id: string
          nurture_cadence: string | null
          nurture_theme: string | null
          status: string
          step_key: string | null
          subject: string | null
          to_recipient: string | null
        }
        Insert: {
          body_text: string
          channel: string
          created_at?: string
          created_by?: string | null
          draft_type: string
          id?: string
          lead_id: string
          nurture_cadence?: string | null
          nurture_theme?: string | null
          status?: string
          step_key?: string | null
          subject?: string | null
          to_recipient?: string | null
        }
        Update: {
          body_text?: string
          channel?: string
          created_at?: string
          created_by?: string | null
          draft_type?: string
          id?: string
          lead_id?: string
          nurture_cadence?: string | null
          nurture_theme?: string | null
          status?: string
          step_key?: string | null
          subject?: string | null
          to_recipient?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "drafts_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_enrichment: {
        Row: {
          company: string
          created_at: string
          expires_at: string
          id: string
          lead_id: string | null
          provider: string
          query: string
          requested_by_user_id: string | null
          results: Json
          signals: Json
          workspace_id: string
        }
        Insert: {
          company: string
          created_at?: string
          expires_at?: string
          id?: string
          lead_id?: string | null
          provider?: string
          query: string
          requested_by_user_id?: string | null
          results?: Json
          signals?: Json
          workspace_id: string
        }
        Update: {
          company?: string
          created_at?: string
          expires_at?: string
          id?: string
          lead_id?: string | null
          provider?: string
          query?: string
          requested_by_user_id?: string | null
          results?: Json
          signals?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "entity_enrichment_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      gmail_connections: {
        Row: {
          access_token_encrypted: string | null
          created_at: string
          gmail_email: string
          id: string
          last_sync_at: string | null
          refresh_token_encrypted: string | null
          token_expires_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_encrypted?: string | null
          created_at?: string
          gmail_email: string
          id?: string
          last_sync_at?: string | null
          refresh_token_encrypted?: string | null
          token_expires_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token_encrypted?: string | null
          created_at?: string
          gmail_email?: string
          id?: string
          last_sync_at?: string | null
          refresh_token_encrypted?: string | null
          token_expires_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      integrations: {
        Row: {
          app_secret_encrypted: string | null
          created_at: string
          credentials_encrypted: string | null
          id: string
          is_active: boolean
          last_sync_at: string | null
          provider: string
          provider_account_id: string | null
          type: Database["public"]["Enums"]["integration_type"]
          updated_at: string
          user_id: string
          webhook_verify_token: string | null
          workspace_id: string
        }
        Insert: {
          app_secret_encrypted?: string | null
          created_at?: string
          credentials_encrypted?: string | null
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          provider?: string
          provider_account_id?: string | null
          type: Database["public"]["Enums"]["integration_type"]
          updated_at?: string
          user_id: string
          webhook_verify_token?: string | null
          workspace_id: string
        }
        Update: {
          app_secret_encrypted?: string | null
          created_at?: string
          credentials_encrypted?: string | null
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          provider?: string
          provider_account_id?: string | null
          type?: Database["public"]["Enums"]["integration_type"]
          updated_at?: string
          user_id?: string
          webhook_verify_token?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      interactions: {
        Row: {
          ai_intent: string | null
          ai_reply_worthy: boolean | null
          ai_summary: string | null
          body_text: string
          direction: string | null
          from_email: string | null
          gmail_message_id: string | null
          gmail_thread_id: string | null
          hidden: boolean
          id: string
          lead_id: string
          occurred_at: string
          source: string
          subject: string | null
          to_email: string | null
          type: string
        }
        Insert: {
          ai_intent?: string | null
          ai_reply_worthy?: boolean | null
          ai_summary?: string | null
          body_text: string
          direction?: string | null
          from_email?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          hidden?: boolean
          id?: string
          lead_id: string
          occurred_at?: string
          source?: string
          subject?: string | null
          to_email?: string | null
          type: string
        }
        Update: {
          ai_intent?: string | null
          ai_reply_worthy?: boolean | null
          ai_summary?: string | null
          body_text?: string
          direction?: string | null
          from_email?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          hidden?: boolean
          id?: string
          lead_id?: string
          occurred_at?: string
          source?: string
          subject?: string | null
          to_email?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "interactions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_chunks: {
        Row: {
          allowed_customer_facing: boolean
          chunk_index: number | null
          content: string
          content_type: string
          created_at: string
          document_id: string | null
          embedding: string | null
          id: string
          lead_id: string | null
          owner_user_id: string | null
          priority: number
          processing_status: string | null
          segment: string | null
          source: string | null
          tags: string[] | null
          title: string | null
        }
        Insert: {
          allowed_customer_facing?: boolean
          chunk_index?: number | null
          content: string
          content_type?: string
          created_at?: string
          document_id?: string | null
          embedding?: string | null
          id?: string
          lead_id?: string | null
          owner_user_id?: string | null
          priority?: number
          processing_status?: string | null
          segment?: string | null
          source?: string | null
          tags?: string[] | null
          title?: string | null
        }
        Update: {
          allowed_customer_facing?: boolean
          chunk_index?: number | null
          content?: string
          content_type?: string
          created_at?: string
          document_id?: string | null
          embedding?: string | null
          id?: string
          lead_id?: string | null
          owner_user_id?: string | null
          priority?: number
          processing_status?: string | null
          segment?: string | null
          source?: string | null
          tags?: string[] | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "kb_chunks_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_context_cache: {
        Row: {
          context_json: Json
          created_at: string
          id: string
          last_generated_at: string
          lead_id: string
          workspace_id: string
        }
        Insert: {
          context_json?: Json
          created_at?: string
          id?: string
          last_generated_at?: string
          lead_id: string
          workspace_id: string
        }
        Update: {
          context_json?: Json
          created_at?: string
          id?: string
          last_generated_at?: string
          lead_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_context_cache_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_context_cache_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_signals: {
        Row: {
          confidence_score: number | null
          created_at: string
          detected_at: string
          id: string
          lead_id: string
          signal_description: string
          signal_type: string
          source_url: string | null
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          detected_at?: string
          id?: string
          lead_id: string
          signal_description: string
          signal_type: string
          source_url?: string | null
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          detected_at?: string
          id?: string
          lead_id?: string
          signal_description?: string
          signal_type?: string
          source_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_signals_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          acceleration_until: string | null
          action_dismissed_at: string | null
          action_instructions: string | null
          action_reason_code: string | null
          auto_created: boolean
          auto_nurture_eligible: boolean | null
          automation_mode: string | null
          city: string | null
          company: string
          company_linkedin_url: string | null
          country: string | null
          created_at: string
          deal_factors_json: Json | null
          deal_outlook: string | null
          eligible_at: string | null
          email: string
          engagement_score: number
          first_outbound_at: string | null
          has_future_meeting: boolean
          id: string
          industry: string | null
          initial_message: string | null
          job_title: string | null
          last_activity_at: string
          last_ai_run_at: string | null
          last_inbound_at: string | null
          last_nurture_outbound_at: string | null
          last_outbound_at: string | null
          last_read_at: string | null
          linkedin_url: string | null
          meeting_link: string | null
          meeting_summary_count: number
          milestones_json: Json | null
          mode_changed_at: string | null
          motion: string
          name: string
          needs_action: boolean
          next_action_key: string | null
          next_action_label: string | null
          next_step: string | null
          next_step_reason: string | null
          nurture_cadence: string | null
          nurture_mode: string
          nurture_outbound_count: number
          nurture_status: string
          nurture_theme: string | null
          ooo_until: string | null
          owner_user_id: string
          personal_notes: string | null
          phone: string | null
          pref_email_drafts: boolean
          pref_linkedin_drafts: boolean
          risks_json: Json | null
          source_type: string
          stage: string
          state: string | null
          status: string
          strategy: string
          unsubscribed: boolean
          wa_opted_in: boolean
          website: string | null
          whatsapp_number: string | null
        }
        Insert: {
          acceleration_until?: string | null
          action_dismissed_at?: string | null
          action_instructions?: string | null
          action_reason_code?: string | null
          auto_created?: boolean
          auto_nurture_eligible?: boolean | null
          automation_mode?: string | null
          city?: string | null
          company: string
          company_linkedin_url?: string | null
          country?: string | null
          created_at?: string
          deal_factors_json?: Json | null
          deal_outlook?: string | null
          eligible_at?: string | null
          email: string
          engagement_score?: number
          first_outbound_at?: string | null
          has_future_meeting?: boolean
          id?: string
          industry?: string | null
          initial_message?: string | null
          job_title?: string | null
          last_activity_at?: string
          last_ai_run_at?: string | null
          last_inbound_at?: string | null
          last_nurture_outbound_at?: string | null
          last_outbound_at?: string | null
          last_read_at?: string | null
          linkedin_url?: string | null
          meeting_link?: string | null
          meeting_summary_count?: number
          milestones_json?: Json | null
          mode_changed_at?: string | null
          motion?: string
          name: string
          needs_action?: boolean
          next_action_key?: string | null
          next_action_label?: string | null
          next_step?: string | null
          next_step_reason?: string | null
          nurture_cadence?: string | null
          nurture_mode?: string
          nurture_outbound_count?: number
          nurture_status?: string
          nurture_theme?: string | null
          ooo_until?: string | null
          owner_user_id: string
          personal_notes?: string | null
          phone?: string | null
          pref_email_drafts?: boolean
          pref_linkedin_drafts?: boolean
          risks_json?: Json | null
          source_type?: string
          stage?: string
          state?: string | null
          status?: string
          strategy: string
          unsubscribed?: boolean
          wa_opted_in?: boolean
          website?: string | null
          whatsapp_number?: string | null
        }
        Update: {
          acceleration_until?: string | null
          action_dismissed_at?: string | null
          action_instructions?: string | null
          action_reason_code?: string | null
          auto_created?: boolean
          auto_nurture_eligible?: boolean | null
          automation_mode?: string | null
          city?: string | null
          company?: string
          company_linkedin_url?: string | null
          country?: string | null
          created_at?: string
          deal_factors_json?: Json | null
          deal_outlook?: string | null
          eligible_at?: string | null
          email?: string
          engagement_score?: number
          first_outbound_at?: string | null
          has_future_meeting?: boolean
          id?: string
          industry?: string | null
          initial_message?: string | null
          job_title?: string | null
          last_activity_at?: string
          last_ai_run_at?: string | null
          last_inbound_at?: string | null
          last_nurture_outbound_at?: string | null
          last_outbound_at?: string | null
          last_read_at?: string | null
          linkedin_url?: string | null
          meeting_link?: string | null
          meeting_summary_count?: number
          milestones_json?: Json | null
          mode_changed_at?: string | null
          motion?: string
          name?: string
          needs_action?: boolean
          next_action_key?: string | null
          next_action_label?: string | null
          next_step?: string | null
          next_step_reason?: string | null
          nurture_cadence?: string | null
          nurture_mode?: string
          nurture_outbound_count?: number
          nurture_status?: string
          nurture_theme?: string | null
          ooo_until?: string | null
          owner_user_id?: string
          personal_notes?: string | null
          phone?: string | null
          pref_email_drafts?: boolean
          pref_linkedin_drafts?: boolean
          risks_json?: Json | null
          source_type?: string
          stage?: string
          state?: string | null
          status?: string
          strategy?: string
          unsubscribed?: boolean
          wa_opted_in?: boolean
          website?: string | null
          whatsapp_number?: string | null
        }
        Relationships: []
      }
      mail_accounts: {
        Row: {
          access_token: string | null
          created_at: string
          display_name: string
          email_address: string
          error_reason: string | null
          external_user_id: string | null
          id: string
          is_default: boolean
          last_sync_at: string | null
          provider: string
          refresh_token: string | null
          status: string
          token_expires_at: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          access_token?: string | null
          created_at?: string
          display_name: string
          email_address: string
          error_reason?: string | null
          external_user_id?: string | null
          id?: string
          is_default?: boolean
          last_sync_at?: string | null
          provider: string
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          access_token?: string | null
          created_at?: string
          display_name?: string
          email_address?: string
          error_reason?: string | null
          external_user_id?: string | null
          id?: string
          is_default?: boolean
          last_sync_at?: string | null
          provider?: string
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mail_accounts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      mail_event_log: {
        Row: {
          event_type: string
          id: string
          mail_account_id: string | null
          payload: Json | null
          processed_at: string
          provider: string
          provider_message_id: string
        }
        Insert: {
          event_type?: string
          id?: string
          mail_account_id?: string | null
          payload?: Json | null
          processed_at?: string
          provider: string
          provider_message_id: string
        }
        Update: {
          event_type?: string
          id?: string
          mail_account_id?: string | null
          payload?: Json | null
          processed_at?: string
          provider?: string
          provider_message_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mail_event_log_mail_account_id_fkey"
            columns: ["mail_account_id"]
            isOneToOne: false
            referencedRelation: "mail_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      manager_views: {
        Row: {
          active_conversations: number | null
          avg_response_time_minutes: number | null
          channel_metrics: Json | null
          computed_at: string
          created_at: string
          ghost_risk_contacts: Json | null
          high_ghost_risk_count: number | null
          id: string
          median_response_time_minutes: number | null
          medium_ghost_risk_count: number | null
          needs_reply_count: number | null
          objection_frequency: Json | null
          rep_user_id: string
          sentiment_distribution: Json | null
          stage_distribution: Json | null
          top_topics: Json | null
          total_conversations: number | null
          total_messages_received: number | null
          total_messages_sent: number | null
          urgency_distribution: Json | null
          workspace_id: string
        }
        Insert: {
          active_conversations?: number | null
          avg_response_time_minutes?: number | null
          channel_metrics?: Json | null
          computed_at?: string
          created_at?: string
          ghost_risk_contacts?: Json | null
          high_ghost_risk_count?: number | null
          id?: string
          median_response_time_minutes?: number | null
          medium_ghost_risk_count?: number | null
          needs_reply_count?: number | null
          objection_frequency?: Json | null
          rep_user_id: string
          sentiment_distribution?: Json | null
          stage_distribution?: Json | null
          top_topics?: Json | null
          total_conversations?: number | null
          total_messages_received?: number | null
          total_messages_sent?: number | null
          urgency_distribution?: Json | null
          workspace_id: string
        }
        Update: {
          active_conversations?: number | null
          avg_response_time_minutes?: number | null
          channel_metrics?: Json | null
          computed_at?: string
          created_at?: string
          ghost_risk_contacts?: Json | null
          high_ghost_risk_count?: number | null
          id?: string
          median_response_time_minutes?: number | null
          medium_ghost_risk_count?: number | null
          needs_reply_count?: number | null
          objection_frequency?: Json | null
          rep_user_id?: string
          sentiment_distribution?: Json | null
          stage_distribution?: Json | null
          top_topics?: Json | null
          total_conversations?: number | null
          total_messages_received?: number | null
          total_messages_sent?: number | null
          urgency_distribution?: Json | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "manager_views_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_packs: {
        Row: {
          created_at: string
          email_saved_as_draft: boolean
          follow_up_email_body: string | null
          follow_up_email_subject: string | null
          id: string
          internal_recap_bullets: Json | null
          lead_id: string
          meeting_date: string | null
          milestones: Json | null
          milestones_saved_to_lead: boolean
          open_questions: Json | null
          owner_user_id: string
          raw_notes: string | null
          source_meeting_summary_id: string | null
          title: string | null
        }
        Insert: {
          created_at?: string
          email_saved_as_draft?: boolean
          follow_up_email_body?: string | null
          follow_up_email_subject?: string | null
          id?: string
          internal_recap_bullets?: Json | null
          lead_id: string
          meeting_date?: string | null
          milestones?: Json | null
          milestones_saved_to_lead?: boolean
          open_questions?: Json | null
          owner_user_id: string
          raw_notes?: string | null
          source_meeting_summary_id?: string | null
          title?: string | null
        }
        Update: {
          created_at?: string
          email_saved_as_draft?: boolean
          follow_up_email_body?: string | null
          follow_up_email_subject?: string | null
          id?: string
          internal_recap_bullets?: Json | null
          lead_id?: string
          meeting_date?: string | null
          milestones?: Json | null
          milestones_saved_to_lead?: boolean
          open_questions?: Json | null
          owner_user_id?: string
          raw_notes?: string | null
          source_meeting_summary_id?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meeting_packs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_packs_source_meeting_summary_id_fkey"
            columns: ["source_meeting_summary_id"]
            isOneToOne: false
            referencedRelation: "meeting_summaries"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_summaries: {
        Row: {
          created_at: string
          followup_generated: boolean
          gmail_message_id: string | null
          gmail_thread_id: string | null
          id: string
          lead_id: string | null
          meeting_title: string | null
          participants_emails: string[] | null
          processed_at: string | null
          sent_at: string
          source: string
          summary_text: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          followup_generated?: boolean
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          id?: string
          lead_id?: string | null
          meeting_title?: string | null
          participants_emails?: string[] | null
          processed_at?: string | null
          sent_at: string
          source?: string
          summary_text?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          followup_generated?: boolean
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          id?: string
          lead_id?: string | null
          meeting_title?: string | null
          participants_emails?: string[] | null
          processed_at?: string | null
          sent_at?: string
          source?: string
          summary_text?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meeting_summaries_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      message_generation_log: {
        Row: {
          campaign_id: string | null
          channel: string
          created_at: string
          cta_type: string
          generated_message: string
          id: string
          lead_id: string
          message_embedding: string | null
          opening_type: string
          primary_angle: string
          secondary_angle: string | null
          task_type: string
          tone: string
          workspace_id: string
        }
        Insert: {
          campaign_id?: string | null
          channel?: string
          created_at?: string
          cta_type?: string
          generated_message: string
          id?: string
          lead_id: string
          message_embedding?: string | null
          opening_type?: string
          primary_angle?: string
          secondary_angle?: string | null
          task_type: string
          tone?: string
          workspace_id: string
        }
        Update: {
          campaign_id?: string | null
          channel?: string
          created_at?: string
          cta_type?: string
          generated_message?: string
          id?: string
          lead_id?: string
          message_embedding?: string | null
          opening_type?: string
          primary_angle?: string
          secondary_angle?: string | null
          task_type?: string
          tone?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_generation_log_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_generation_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          ai_confidence: number | null
          body_ciphertext: string | null
          conversation_id: string
          created_at: string
          direction: Database["public"]["Enums"]["message_direction"]
          expires_at: string
          id: string
          intent: string | null
          is_automated: boolean
          media_type: string | null
          provider_message_id: string | null
          sender_identity_id: string | null
          status: string
          whatsapp_message_id: string | null
          workspace_id: string
        }
        Insert: {
          ai_confidence?: number | null
          body_ciphertext?: string | null
          conversation_id: string
          created_at?: string
          direction: Database["public"]["Enums"]["message_direction"]
          expires_at?: string
          id?: string
          intent?: string | null
          is_automated?: boolean
          media_type?: string | null
          provider_message_id?: string | null
          sender_identity_id?: string | null
          status?: string
          whatsapp_message_id?: string | null
          workspace_id: string
        }
        Update: {
          ai_confidence?: number | null
          body_ciphertext?: string | null
          conversation_id?: string
          created_at?: string
          direction?: Database["public"]["Enums"]["message_direction"]
          expires_at?: string
          id?: string
          intent?: string | null
          is_automated?: boolean
          media_type?: string | null
          provider_message_id?: string | null
          sender_identity_id?: string | null
          status?: string
          whatsapp_message_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "manager_conversation_metrics"
            referencedColumns: ["conversation_id"]
          },
          {
            foreignKeyName: "messages_sender_identity_id_fkey"
            columns: ["sender_identity_id"]
            isOneToOne: false
            referencedRelation: "contact_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_states: {
        Row: {
          created_at: string
          csrf_token: string
          expires_at: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          csrf_token: string
          expires_at: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          csrf_token?: string
          expires_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      onboarding_config: {
        Row: {
          automation_level: string | null
          completed: boolean
          created_at: string
          current_step: number
          extracted_kb: Json
          extraction_status: string | null
          id: string
          industry: string | null
          industry_pack: Json
          industry_playbook_id: string | null
          messaging_constraints: Json
          primary_goal: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          automation_level?: string | null
          completed?: boolean
          created_at?: string
          current_step?: number
          extracted_kb?: Json
          extraction_status?: string | null
          id?: string
          industry?: string | null
          industry_pack?: Json
          industry_playbook_id?: string | null
          messaging_constraints?: Json
          primary_goal?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          automation_level?: string | null
          completed?: boolean
          created_at?: string
          current_step?: number
          extracted_kb?: Json
          extraction_status?: string | null
          id?: string
          industry?: string | null
          industry_pack?: Json
          industry_playbook_id?: string | null
          messaging_constraints?: Json
          primary_goal?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      org_settings: {
        Row: {
          created_at: string
          id: string
          internal_email_domains: string[] | null
          updated_at: string
          user_id: string
          zoom_auto_generate_followups_enabled: boolean
          zoom_meeting_sync_enabled: boolean
        }
        Insert: {
          created_at?: string
          id?: string
          internal_email_domains?: string[] | null
          updated_at?: string
          user_id: string
          zoom_auto_generate_followups_enabled?: boolean
          zoom_meeting_sync_enabled?: boolean
        }
        Update: {
          created_at?: string
          id?: string
          internal_email_domains?: string[] | null
          updated_at?: string
          user_id?: string
          zoom_auto_generate_followups_enabled?: boolean
          zoom_meeting_sync_enabled?: boolean
        }
        Relationships: []
      }
      outlook_subscriptions: {
        Row: {
          change_types: string[]
          client_state: string | null
          created_at: string
          error_reason: string | null
          expiration_at: string
          id: string
          last_renewed_at: string | null
          mail_account_id: string
          notification_url: string | null
          resource: string
          status: string
          subscription_id: string
          updated_at: string
        }
        Insert: {
          change_types?: string[]
          client_state?: string | null
          created_at?: string
          error_reason?: string | null
          expiration_at: string
          id?: string
          last_renewed_at?: string | null
          mail_account_id: string
          notification_url?: string | null
          resource?: string
          status?: string
          subscription_id: string
          updated_at?: string
        }
        Update: {
          change_types?: string[]
          client_state?: string | null
          created_at?: string
          error_reason?: string | null
          expiration_at?: string
          id?: string
          last_renewed_at?: string | null
          mail_account_id?: string
          notification_url?: string | null
          resource?: string
          status?: string
          subscription_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outlook_subscriptions_mail_account_id_fkey"
            columns: ["mail_account_id"]
            isOneToOne: true
            referencedRelation: "mail_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          id: string
          onboarding_done: boolean
          onboarding_step: number
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          onboarding_done?: boolean
          onboarding_step?: number
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          onboarding_done?: boolean
          onboarding_step?: number
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      rep_profiles: {
        Row: {
          calendar_link: string | null
          company_name: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          job_title: string | null
          linkedin_url: string | null
          office_address: string | null
          phone: string | null
          twilio_phone_number: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          calendar_link?: string | null
          company_name?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          job_title?: string | null
          linkedin_url?: string | null
          office_address?: string | null
          phone?: string | null
          twilio_phone_number?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          calendar_link?: string | null
          company_name?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          job_title?: string | null
          linkedin_url?: string | null
          office_address?: string | null
          phone?: string | null
          twilio_phone_number?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      rep_signatures: {
        Row: {
          created_at: string
          id: string
          is_default: boolean
          name: string
          signature_text: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          signature_text: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          signature_text?: string
          user_id?: string
        }
        Relationships: []
      }
      unmatched_meeting_summaries: {
        Row: {
          created_at: string
          gmail_message_id: string
          gmail_thread_id: string | null
          id: string
          meeting_title: string | null
          participants_emails: string[] | null
          resolved_at: string | null
          resolved_lead_id: string | null
          sent_at: string
          suggested_leads: Json | null
          summary_text: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          gmail_message_id: string
          gmail_thread_id?: string | null
          id?: string
          meeting_title?: string | null
          participants_emails?: string[] | null
          resolved_at?: string | null
          resolved_lead_id?: string | null
          sent_at: string
          suggested_leads?: Json | null
          summary_text?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          gmail_message_id?: string
          gmail_thread_id?: string | null
          id?: string
          meeting_title?: string | null
          participants_emails?: string[] | null
          resolved_at?: string | null
          resolved_lead_id?: string | null
          sent_at?: string
          suggested_leads?: Json | null
          summary_text?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "unmatched_meeting_summaries_resolved_lead_id_fkey"
            columns: ["resolved_lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_event_queue: {
        Row: {
          attempts: number
          created_at: string
          error_message: string | null
          event_type: string
          id: string
          idempotency_key: string
          integration_id: string
          max_attempts: number
          processed_at: string | null
          provider: string
          raw_payload: Json
          status: string
          workspace_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error_message?: string | null
          event_type: string
          id?: string
          idempotency_key: string
          integration_id: string
          max_attempts?: number
          processed_at?: string | null
          provider?: string
          raw_payload: Json
          status?: string
          workspace_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error_message?: string | null
          event_type?: string
          id?: string
          idempotency_key?: string
          integration_id?: string
          max_attempts?: number
          processed_at?: string | null
          provider?: string
          raw_payload?: Json
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_event_queue_integration_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      winning_interactions: {
        Row: {
          channel: string
          created_at: string
          id: string
          lead_id: string
          message_content: string
          outcome_type: string
          promoted_to_kb: boolean
          workspace_id: string
        }
        Insert: {
          channel?: string
          created_at?: string
          id?: string
          lead_id: string
          message_content: string
          outcome_type: string
          promoted_to_kb?: boolean
          workspace_id: string
        }
        Update: {
          channel?: string
          created_at?: string
          id?: string
          lead_id?: string
          message_content?: string
          outcome_type?: string
          promoted_to_kb?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "winning_interactions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "winning_interactions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_automation_settings: {
        Row: {
          after_hours_auto: boolean
          blocked_keywords: Json
          blocked_stages: Json
          confidence_threshold: number
          created_at: string
          default_mode: string
          id: string
          updated_at: string
          weekend_auto: boolean
          workspace_id: string
        }
        Insert: {
          after_hours_auto?: boolean
          blocked_keywords?: Json
          blocked_stages?: Json
          confidence_threshold?: number
          created_at?: string
          default_mode?: string
          id?: string
          updated_at?: string
          weekend_auto?: boolean
          workspace_id: string
        }
        Update: {
          after_hours_auto?: boolean
          blocked_keywords?: Json
          blocked_stages?: Json
          confidence_threshold?: number
          created_at?: string
          default_mode?: string
          id?: string
          updated_at?: string
          weekend_auto?: boolean
          workspace_id?: string
        }
        Relationships: []
      }
      workspace_invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          id: string
          invited_by: string
          role: Database["public"]["Enums"]["workspace_role"]
          status: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          id?: string
          invited_by: string
          role?: Database["public"]["Enums"]["workspace_role"]
          status?: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          id?: string
          invited_by?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_profiles: {
        Row: {
          allowed_claims: string[] | null
          cadence_settings: Json
          company_kb: Json
          company_name: string | null
          created_at: string
          disallowed_topics: string[] | null
          id: string
          industry: string | null
          industry_pack: Json
          industry_playbook_id: string | null
          meeting_timezone: string | null
          pricing_policy: string
          primary_goal: string | null
          primary_value_props: string[] | null
          product_description: string | null
          product_name: string | null
          supported_use_cases: string[] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          allowed_claims?: string[] | null
          cadence_settings?: Json
          company_kb?: Json
          company_name?: string | null
          created_at?: string
          disallowed_topics?: string[] | null
          id?: string
          industry?: string | null
          industry_pack?: Json
          industry_playbook_id?: string | null
          meeting_timezone?: string | null
          pricing_policy?: string
          primary_goal?: string | null
          primary_value_props?: string[] | null
          product_description?: string | null
          product_name?: string | null
          supported_use_cases?: string[] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          allowed_claims?: string[] | null
          cadence_settings?: Json
          company_kb?: Json
          company_name?: string | null
          created_at?: string
          disallowed_topics?: string[] | null
          id?: string
          industry?: string | null
          industry_pack?: Json
          industry_playbook_id?: string | null
          meeting_timezone?: string | null
          pricing_policy?: string
          primary_goal?: string | null
          primary_value_props?: string[] | null
          product_description?: string | null
          product_name?: string | null
          supported_use_cases?: string[] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      workspaces: {
        Row: {
          billing_email: string | null
          created_at: string
          id: string
          name: string
          plan: string
          updated_at: string
        }
        Insert: {
          billing_email?: string | null
          created_at?: string
          id?: string
          name: string
          plan?: string
          updated_at?: string
        }
        Update: {
          billing_email?: string | null
          created_at?: string
          id?: string
          name?: string
          plan?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      manager_conversation_metrics: {
        Row: {
          channel: Database["public"]["Enums"]["integration_type"] | null
          contact_company: string | null
          contact_id: string | null
          contact_name: string | null
          contact_status: Database["public"]["Enums"]["contact_status"] | null
          conversation_id: string | null
          last_message_at: string | null
          latest_features: Json | null
          latest_sentiment: string | null
          latest_summary: string | null
          latest_topics: string[] | null
          lead_id: string | null
          message_count: number | null
          owner_user_id: string | null
          status: string | null
          workspace_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      decrypt_gmail_token: {
        Args: { encrypted_token: string; encryption_key: string }
        Returns: string
      }
      expire_old_messages: { Args: never; Returns: undefined }
      get_workspace_role: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: Database["public"]["Enums"]["workspace_role"]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_workspace_admin: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: boolean
      }
      is_workspace_member: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: boolean
      }
      match_knowledge_chunks:
        | {
            Args: {
              filter_customer_facing?: boolean
              match_count?: number
              match_threshold?: number
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              similarity: number
              source: string
              title: string
            }[]
          }
        | {
            Args: {
              filter_customer_facing?: boolean
              filter_lead_id?: string
              match_count?: number
              match_threshold?: number
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              similarity: number
              source: string
              title: string
            }[]
          }
        | {
            Args: {
              filter_customer_facing?: boolean
              filter_lead_id?: string
              match_count?: number
              match_threshold?: number
              p_owner_user_id?: string
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              similarity: number
              source: string
              title: string
            }[]
          }
      match_knowledge_chunks_v2: {
        Args: {
          filter_content_types?: string[]
          filter_customer_facing?: boolean
          filter_lead_id?: string
          match_count?: number
          match_threshold?: number
          p_owner_user_id: string
          query_embedding: string
        }
        Returns: {
          content: string
          content_type: string
          id: string
          segment: string
          similarity: number
          source: string
          tags: string[]
          title: string
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "sales"
      contact_status: "unclassified" | "lead" | "customer" | "blocked"
      identity_type: "phone" | "email" | "whatsapp"
      integration_type: "gmail" | "whatsapp"
      message_direction: "inbound" | "outbound"
      workspace_role: "admin" | "manager" | "rep"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "sales"],
      contact_status: ["unclassified", "lead", "customer", "blocked"],
      identity_type: ["phone", "email", "whatsapp"],
      integration_type: ["gmail", "whatsapp"],
      message_direction: ["inbound", "outbound"],
      workspace_role: ["admin", "manager", "rep"],
    },
  },
} as const
