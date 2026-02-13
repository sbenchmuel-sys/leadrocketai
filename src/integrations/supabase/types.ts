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
          notes?: string | null
          status?: Database["public"]["Enums"]["contact_status"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
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
      gmail_connections: {
        Row: {
          access_token: string
          created_at: string
          gmail_email: string
          id: string
          last_sync_at: string | null
          refresh_token: string
          token_expires_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string
          gmail_email: string
          id?: string
          last_sync_at?: string | null
          refresh_token: string
          token_expires_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string
          gmail_email?: string
          id?: string
          last_sync_at?: string | null
          refresh_token?: string
          token_expires_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      integrations: {
        Row: {
          created_at: string
          credentials_encrypted: string | null
          id: string
          is_active: boolean
          last_sync_at: string | null
          provider_account_id: string | null
          type: Database["public"]["Enums"]["integration_type"]
          updated_at: string
          user_id: string
          webhook_verify_token: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          credentials_encrypted?: string | null
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          provider_account_id?: string | null
          type: Database["public"]["Enums"]["integration_type"]
          updated_at?: string
          user_id: string
          webhook_verify_token?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          credentials_encrypted?: string | null
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
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
          created_at: string
          document_id: string | null
          embedding: string | null
          id: string
          lead_id: string | null
          owner_user_id: string | null
          processing_status: string | null
          source: string | null
          title: string | null
        }
        Insert: {
          allowed_customer_facing?: boolean
          chunk_index?: number | null
          content: string
          created_at?: string
          document_id?: string | null
          embedding?: string | null
          id?: string
          lead_id?: string | null
          owner_user_id?: string | null
          processing_status?: string | null
          source?: string | null
          title?: string | null
        }
        Update: {
          allowed_customer_facing?: boolean
          chunk_index?: number | null
          content?: string
          created_at?: string
          document_id?: string | null
          embedding?: string | null
          id?: string
          lead_id?: string | null
          owner_user_id?: string | null
          processing_status?: string | null
          source?: string | null
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
      leads: {
        Row: {
          action_dismissed_at: string | null
          action_instructions: string | null
          action_reason_code: string | null
          auto_nurture_eligible: boolean | null
          company: string
          country: string | null
          created_at: string
          deal_factors_json: Json | null
          deal_outlook: string | null
          eligible_at: string | null
          email: string
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
          owner_user_id: string
          personal_notes: string | null
          phone: string | null
          pref_email_drafts: boolean
          pref_linkedin_drafts: boolean
          risks_json: Json | null
          source_type: string
          stage: string
          status: string
          strategy: string
        }
        Insert: {
          action_dismissed_at?: string | null
          action_instructions?: string | null
          action_reason_code?: string | null
          auto_nurture_eligible?: boolean | null
          company: string
          country?: string | null
          created_at?: string
          deal_factors_json?: Json | null
          deal_outlook?: string | null
          eligible_at?: string | null
          email: string
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
          owner_user_id: string
          personal_notes?: string | null
          phone?: string | null
          pref_email_drafts?: boolean
          pref_linkedin_drafts?: boolean
          risks_json?: Json | null
          source_type?: string
          stage?: string
          status?: string
          strategy: string
        }
        Update: {
          action_dismissed_at?: string | null
          action_instructions?: string | null
          action_reason_code?: string | null
          auto_nurture_eligible?: boolean | null
          company?: string
          country?: string | null
          created_at?: string
          deal_factors_json?: Json | null
          deal_outlook?: string | null
          eligible_at?: string | null
          email?: string
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
          owner_user_id?: string
          personal_notes?: string | null
          phone?: string | null
          pref_email_drafts?: boolean
          pref_linkedin_drafts?: boolean
          risks_json?: Json | null
          source_type?: string
          stage?: string
          status?: string
          strategy?: string
        }
        Relationships: []
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
      messages: {
        Row: {
          body_ciphertext: string | null
          conversation_id: string
          created_at: string
          direction: Database["public"]["Enums"]["message_direction"]
          expires_at: string
          id: string
          media_type: string | null
          provider_message_id: string | null
          sender_identity_id: string | null
          workspace_id: string
        }
        Insert: {
          body_ciphertext?: string | null
          conversation_id: string
          created_at?: string
          direction: Database["public"]["Enums"]["message_direction"]
          expires_at?: string
          id?: string
          media_type?: string | null
          provider_message_id?: string | null
          sender_identity_id?: string | null
          workspace_id: string
        }
        Update: {
          body_ciphertext?: string | null
          conversation_id?: string
          created_at?: string
          direction?: Database["public"]["Enums"]["message_direction"]
          expires_at?: string
          id?: string
          media_type?: string | null
          provider_message_id?: string | null
          sender_identity_id?: string | null
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
          message_count: number | null
          owner_user_id: string | null
          status: string | null
          workspace_id: string | null
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
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
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
