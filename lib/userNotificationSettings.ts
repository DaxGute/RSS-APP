import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from './database.types';
import { supabase } from './supabase';

type UserNotificationSettingsTable =
  Database['public']['Tables']['user_notification_settings'];

/** Narrow DB shape so PostgREST `Insert`/`Update` generics resolve (multi-table `Database` unions break inference). */
type NotificationSettingsDb = {
  public: {
    Tables: {
      user_notification_settings: UserNotificationSettingsTable;
    };
    Views: Database['public']['Views'];
    Functions: Database['public']['Functions'];
  };
};

const notificationDb = supabase as SupabaseClient<NotificationSettingsDb>;

export type UserNotificationSettingsInsert = UserNotificationSettingsTable['Insert'];

/** Insert or replace the signed-in user’s alert row (create + update). */
export async function upsertUserNotificationSettings(
  payload: UserNotificationSettingsInsert,
): Promise<UserNotificationSettingsTable['Row'][]> {
  const { data, error } = await notificationDb
    .from('user_notification_settings')
    .upsert(payload, { onConflict: 'user_id' })
    .select();

  if (error) throw error;
  return data ?? [];
}

/** Remove the signed-in user’s alert row from the database. */
export async function deleteUserNotificationSettings(userId: string): Promise<void> {
  const { error } = await notificationDb
    .from('user_notification_settings')
    .delete()
    .eq('user_id', userId);
  if (error) throw error;
}
