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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      activity_logs: {
        Row: {
          created_at: string
          device: string | null
          device_id: string | null
          event: string | null
          id: string
          message: string | null
          meta: Json | null
          occupancy: string | null
          session_id: string | null
          slot: number | null
          ts: string
          type: string | null
        }
        Insert: {
          created_at?: string
          device?: string | null
          device_id?: string | null
          event?: string | null
          id?: string
          message?: string | null
          meta?: Json | null
          occupancy?: string | null
          session_id?: string | null
          slot?: number | null
          ts?: string
          type?: string | null
        }
        Update: {
          created_at?: string
          device?: string | null
          device_id?: string | null
          event?: string | null
          id?: string
          message?: string | null
          meta?: Json | null
          occupancy?: string | null
          session_id?: string | null
          slot?: number | null
          ts?: string
          type?: string | null
        }
        Relationships: []
      }
      api_rate_limits: {
        Row: {
          count: number
          key: string
          window_start: string
        }
        Insert: {
          count?: number
          key: string
          window_start?: string
        }
        Update: {
          count?: number
          key?: string
          window_start?: string
        }
        Relationships: []
      }
      device_commands: {
        Row: {
          command: string
          consumed_at: string | null
          created_at: string
          device_id: string
          id: string
        }
        Insert: {
          command: string
          consumed_at?: string | null
          created_at?: string
          device_id: string
          id?: string
        }
        Update: {
          command?: string
          consumed_at?: string | null
          created_at?: string
          device_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_commands_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
        ]
      }
      device_telemetry: {
        Row: {
          device_id: string
          dist_cm: number | null
          entry_state: number | null
          id: string
          occupancy: string | null
          rssi: number | null
          ts: string
        }
        Insert: {
          device_id: string
          dist_cm?: number | null
          entry_state?: number | null
          id?: string
          occupancy?: string | null
          rssi?: number | null
          ts?: string
        }
        Update: {
          device_id?: string
          dist_cm?: number | null
          entry_state?: number | null
          id?: string
          occupancy?: string | null
          rssi?: number | null
          ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_telemetry_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          boot_at: string | null
          entry_state: number
          exit_open: boolean
          id: string
          last_seen: string | null
          rssi: number | null
          uptime_s: number | null
        }
        Insert: {
          boot_at?: string | null
          entry_state?: number
          exit_open?: boolean
          id: string
          last_seen?: string | null
          rssi?: number | null
          uptime_s?: number | null
        }
        Update: {
          boot_at?: string | null
          entry_state?: number
          exit_open?: boolean
          id?: string
          last_seen?: string | null
          rssi?: number | null
          uptime_s?: number | null
        }
        Relationships: []
      }
      parking_operators: {
        Row: {
          user_id: string
        }
        Insert: {
          user_id: string
        }
        Update: {
          user_id?: string
        }
        Relationships: []
      }
      parking_sessions: {
        Row: {
          amount_inr: number
          created_at: string
          id: string
          paid_at: string | null
          payment_link_id: string | null
          short_url: string | null
          slot: number
          status: string
        }
        Insert: {
          amount_inr: number
          created_at?: string
          id?: string
          paid_at?: string | null
          payment_link_id?: string | null
          short_url?: string | null
          slot: number
          status?: string
        }
        Update: {
          amount_inr?: number
          created_at?: string
          id?: string
          paid_at?: string | null
          payment_link_id?: string | null
          short_url?: string | null
          slot?: number
          status?: string
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount_paise: number
          created_at: string
          duration_min: number
          id: string
          kind: string
          razorpay_order_id: string
          razorpay_payment_id: string | null
          session_id: string
          status: string
        }
        Insert: {
          amount_paise: number
          created_at?: string
          duration_min: number
          id?: string
          kind: string
          razorpay_order_id: string
          razorpay_payment_id?: string | null
          session_id: string
          status?: string
        }
        Update: {
          amount_paise?: number
          created_at?: string
          duration_min?: number
          id?: string
          kind?: string
          razorpay_order_id?: string
          razorpay_payment_id?: string | null
          session_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          amount_paise: number
          code: string
          contact_email: string | null
          contact_phone: string | null
          created_at: string
          device_id: string | null
          duration_min: number
          end_time: string | null
          entered_at: string | null
          exit_signalled_at: string | null
          expires_at: string
          id: string
          paid_at: string | null
          reminder_sent: boolean
          slot: number
          start_time: string | null
          status: Database["public"]["Enums"]["parking_session_status"]
          vehicle_no: string | null
        }
        Insert: {
          amount_paise?: number
          code: string
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          device_id?: string | null
          duration_min?: number
          end_time?: string | null
          entered_at?: string | null
          exit_signalled_at?: string | null
          expires_at?: string
          id?: string
          paid_at?: string | null
          reminder_sent?: boolean
          slot: number
          start_time?: string | null
          status?: Database["public"]["Enums"]["parking_session_status"]
          vehicle_no?: string | null
        }
        Update: {
          amount_paise?: number
          code?: string
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          device_id?: string | null
          duration_min?: number
          end_time?: string | null
          entered_at?: string | null
          exit_signalled_at?: string | null
          expires_at?: string
          id?: string
          paid_at?: string | null
          reminder_sent?: boolean
          slot?: number
          start_time?: string | null
          status?: Database["public"]["Enums"]["parking_session_status"]
          vehicle_no?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sessions_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_slot_fkey"
            columns: ["slot"]
            isOneToOne: false
            referencedRelation: "slots"
            referencedColumns: ["slot"]
          },
        ]
      }
      settings: {
        Row: {
          duration_options: number[]
          exit_open_seconds: number
          id: boolean
          offline_after_s: number
          price_per_hour: number
          reminder_min: number
          telemetry_cleanup_at: string
        }
        Insert: {
          duration_options?: number[]
          exit_open_seconds?: number
          id?: boolean
          offline_after_s?: number
          price_per_hour?: number
          reminder_min?: number
          telemetry_cleanup_at?: string
        }
        Update: {
          duration_options?: number[]
          exit_open_seconds?: number
          id?: boolean
          offline_after_s?: number
          price_per_hour?: number
          reminder_min?: number
          telemetry_cleanup_at?: string
        }
        Relationships: []
      }
      slots: {
        Row: {
          occupied: boolean
          slot: number
          updated_at: string
        }
        Insert: {
          occupied?: boolean
          slot: number
          updated_at?: string
        }
        Update: {
          occupied?: boolean
          slot?: number
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      check_rate_limit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: boolean
      }
      consume_parking_session: { Args: { p_id: string }; Returns: string }
      create_device_session: {
        Args: { p_code: string; p_device: string; p_slot: number }
        Returns: {
          amount_paise: number
          code: string
          contact_email: string | null
          contact_phone: string | null
          created_at: string
          device_id: string | null
          duration_min: number
          end_time: string | null
          entered_at: string | null
          exit_signalled_at: string | null
          expires_at: string
          id: string
          paid_at: string | null
          reminder_sent: boolean
          slot: number
          start_time: string | null
          status: Database["public"]["Enums"]["parking_session_status"]
          vehicle_no: string | null
        }
        SetofOptions: {
          from: "*"
          to: "sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      device_due: {
        Args: { p_device: string; p_reminder_min: number }
        Returns: {
          exit_open: boolean
          warn_slots: number[]
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      mark_paid: {
        Args: { p_amount: number; p_order_id: string; p_payment_id: string }
        Returns: string
      }
      mark_session_entered: {
        Args: { p_session: string }
        Returns: {
          amount_paise: number
          code: string
          contact_email: string | null
          contact_phone: string | null
          created_at: string
          device_id: string | null
          duration_min: number
          end_time: string | null
          entered_at: string | null
          exit_signalled_at: string | null
          expires_at: string
          id: string
          paid_at: string | null
          reminder_sent: boolean
          slot: number
          start_time: string | null
          status: Database["public"]["Enums"]["parking_session_status"]
          vehicle_no: string | null
        }
        SetofOptions: {
          from: "*"
          to: "sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      app_role: "admin"
      parking_session_status:
        | "pending"
        | "paid"
        | "active"
        | "completed"
        | "expired"
        | "cancelled"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      app_role: ["admin"],
      parking_session_status: [
        "pending",
        "paid",
        "active",
        "completed",
        "expired",
        "cancelled",
      ],
    },
  },
} as const
