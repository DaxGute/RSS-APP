/**
 * Align these types with your Supabase column names and types.
 * Regenerate from the dashboard (Settings → API → Generate types) when the schema changes.
 */

export interface PurpleAirRow {
  sensor_index: number;
  latitude: number;
  longitude: number;
  pm25: number | null;
  aqi: number | null;
  humidity: number | null;
  temperature: number | null;
  /** When the sensor last reported (ISO 8601). */
  last_seen: string;
  /** When the pipeline recorded this row (ISO 8601). */
  time: string;
}

export interface ClarityRow {
  sensor_index: number;
  latitude: number;
  longitude: number;
  pm25: number | null;
  aqi: number | null;
  humidity: number | null;
  temperature: number | null;
  last_seen: string;
  time: string;
}

export interface CurrentKrigingRow {
  latitude: number;
  longitude: number;
  pm25: number | null;
  aqi: number | null;
  /** Kriging prediction variance (column name must match your table). */
  kriging_variance: number | null;
  /** When this grid cell was generated (ISO 8601). */
  time: string;
}

export interface DailySensorAqiRow {
  source: string;
  sensor_index: number;
  name: string | null;
  latitude: number;
  longitude: number;
  pm25: number | null;
  aqi: number | null;
  time: string;
  reading_count: number | null;
}

/** Supabase client generic: maps public table names to Row types. */
export interface Database {
  public: {
    Tables: {
      purple_air: {
        Row: PurpleAirRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      clarity: {
        Row: ClarityRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      current_kriging: {
        Row: CurrentKrigingRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      daily_sensor_aqi: {
        Row: DailySensorAqiRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      user_notification_settings: {
        Row: {
          user_id: string;
          notification_on: boolean;
          notification_lat: number;
          notification_lng: number;
          notification_threshold: number;
          /** Minutes between notifications (matches app `cooldownMinutes`). */
          notification_cooldown: number;
          expo_push_token: string;
        };
        Insert: {
          user_id: string;
          notification_on: boolean;
          notification_lat: number;
          notification_lng: number;
          notification_threshold: number;
          notification_cooldown: number;
          expo_push_token: string;
        };
        Update: Partial<{
          notification_on: boolean;
          notification_lat: number;
          notification_lng: number;
          notification_threshold: number;
          notification_cooldown: number;
          expo_push_token: string;
        }>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
