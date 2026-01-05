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
      drafts: {
        Row: {
          body_text: string
          channel: string
          created_at: string
          created_by: string | null
          draft_type: string
          id: string
          lead_id: string
          status: string
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
          status?: string
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
          status?: string
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
      interactions: {
        Row: {
          ai_intent: string | null
          ai_reply_worthy: boolean | null
          ai_summary: string | null
          body_text: string
          from_email: string | null
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
          from_email?: string | null
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
          from_email?: string | null
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
          content: string
          created_at: string
          id: string
          source: string | null
          title: string | null
        }
        Insert: {
          allowed_customer_facing?: boolean
          content: string
          created_at?: string
          id?: string
          source?: string | null
          title?: string | null
        }
        Update: {
          allowed_customer_facing?: boolean
          content?: string
          created_at?: string
          id?: string
          source?: string | null
          title?: string | null
        }
        Relationships: []
      }
      leads: {
        Row: {
          company: string
          created_at: string
          deal_factors_json: Json | null
          deal_outlook: string | null
          email: string
          id: string
          last_activity_at: string
          last_ai_run_at: string | null
          meeting_link: string | null
          milestones_json: Json | null
          name: string
          next_step: string | null
          next_step_reason: string | null
          owner_user_id: string
          personal_notes: string | null
          pref_email_drafts: boolean
          pref_linkedin_drafts: boolean
          risks_json: Json | null
          status: string
          strategy: string
        }
        Insert: {
          company: string
          created_at?: string
          deal_factors_json?: Json | null
          deal_outlook?: string | null
          email: string
          id?: string
          last_activity_at?: string
          last_ai_run_at?: string | null
          meeting_link?: string | null
          milestones_json?: Json | null
          name: string
          next_step?: string | null
          next_step_reason?: string | null
          owner_user_id: string
          personal_notes?: string | null
          pref_email_drafts?: boolean
          pref_linkedin_drafts?: boolean
          risks_json?: Json | null
          status?: string
          strategy: string
        }
        Update: {
          company?: string
          created_at?: string
          deal_factors_json?: Json | null
          deal_outlook?: string | null
          email?: string
          id?: string
          last_activity_at?: string
          last_ai_run_at?: string | null
          meeting_link?: string | null
          milestones_json?: Json | null
          name?: string
          next_step?: string | null
          next_step_reason?: string | null
          owner_user_id?: string
          personal_notes?: string | null
          pref_email_drafts?: boolean
          pref_linkedin_drafts?: boolean
          risks_json?: Json | null
          status?: string
          strategy?: string
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "sales"
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
    },
  },
} as const
