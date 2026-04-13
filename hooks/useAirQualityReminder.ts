import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { aqiMeetsReminderThreshold, pm25ToAqi, reminderBandToAqiThreshold } from '../lib/aqiUtils';
import { ensureAnonymousSession } from '../lib/ensureAnonymousSession';
import { supabase } from '../lib/supabase';
import {
  deleteUserNotificationSettings,
  upsertUserNotificationSettings,
} from '../lib/userNotificationSettings';
import type { CurrentKrigingRow } from '../lib/database.types';
import { computeSsfSelection } from '../lib/ssfSelection';
import type { SensorPoint } from '../lib/sensorTypes';

const STORAGE_KEY = '@rss_air_quality_reminder_v1';

export type AirQualityReminder = {
  lat: number;
  lon: number;
  /** Index into `EPA_AQI_CATEGORY_BANDS` (0–5). */
  categoryIndex: number;
  /** Minimum minutes between local alerts; default 60. */
  cooldownMinutes: number;
  /** Epoch ms of last local notification (for cooldown). */
  lastNotifiedAt?: number;
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function coordsMatch(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  eps = 1e-5,
): boolean {
  return Math.abs(a.lat - b.lat) < eps && Math.abs(a.lon - b.lon) < eps;
}

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('air-quality', {
    name: 'Air quality alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

async function requestNotifyPermission(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Persists the reminder for server-side Expo push (HTTPS → Expo Push API).
 * Flow: ensure anonymous Supabase auth (anon key + RLS) → permission already
 * granted by `setReminder` → Expo push token → upsert on `user_id` so edits
 * replace the same row.
 */
async function writeAlertToSupabase(
  lat: number,
  lon: number,
  categoryIndex: number,
  cooldownMinutes: number,
): Promise<void> {
  const user = await ensureAnonymousSession();
  const userId = user.id;
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

  let expoPushToken: string;
  try {
    const tokenData = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId: String(projectId) } : undefined,
    );
    expoPushToken = tokenData.data;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to get Expo push token: ${msg}`);
  }
  if (!expoPushToken) {
    throw new Error('Expo push token was empty — notifications may be unavailable on this device.');
  }

  const lng = lon;
  const threshold = reminderBandToAqiThreshold(categoryIndex);

  const payload = {
    user_id: userId,
    notification_on: true,
    notification_lat: lat,
    notification_lng: lng,
    notification_threshold: threshold,
    notification_cooldown: cooldownMinutes,
    expo_push_token: expoPushToken,
  };

  await upsertUserNotificationSettings(payload);
}

export function useAirQualityReminder(
  sensors: SensorPoint[],
  kriging: CurrentKrigingRow[],
  viewingLive: boolean,
) {
  const [reminder, setReminderState] = useState<AirQualityReminder | null>(null);
  const loadedRef = useRef(false);
  const thresholdCrossRef = useRef<{ key: string; wasAbove: boolean } | null>(null);

  useEffect(() => {
    void ensureAndroidChannel();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<AirQualityReminder>;
          if (
            typeof parsed.lat === 'number' &&
            typeof parsed.lon === 'number' &&
            typeof parsed.categoryIndex === 'number' &&
            parsed.categoryIndex >= 0 &&
            parsed.categoryIndex <= 5
          ) {
            const cooldownMinutes =
              typeof parsed.cooldownMinutes === 'number' &&
              parsed.cooldownMinutes >= 5 &&
              parsed.cooldownMinutes <= 10080
                ? Math.round(parsed.cooldownMinutes)
                : 60;
            const lastNotifiedAt =
              typeof parsed.lastNotifiedAt === 'number' && parsed.lastNotifiedAt > 0
                ? parsed.lastNotifiedAt
                : undefined;
            setReminderState({
              lat: parsed.lat,
              lon: parsed.lon,
              categoryIndex: parsed.categoryIndex,
              cooldownMinutes,
              lastNotifiedAt,
            });
          }
        }
      } finally {
        loadedRef.current = true;
      }
    })();
  }, []);

  const persist = useCallback(async (next: AirQualityReminder | null) => {
    if (next == null) {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } else {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  }, []);

  const setReminder = useCallback(
    async (lat: number, lon: number, categoryIndex: number, cooldownMinutes = 60) => {
      if (categoryIndex < 1 || categoryIndex > 5) {
        throw new Error('Invalid reminder threshold');
      }
      if (cooldownMinutes < 5 || cooldownMinutes > 10080) {
        throw new Error('Invalid cooldown');
      }

      const ok = await requestNotifyPermission();
      if (!ok) return;

      setReminderState((prev) => {
        const sameSpot =
          prev != null &&
          coordsMatch({ lat, lon }, prev) &&
          prev.categoryIndex === categoryIndex;
        const next: AirQualityReminder = {
          lat,
          lon,
          categoryIndex,
          cooldownMinutes: Math.round(cooldownMinutes),
          lastNotifiedAt: sameSpot ? prev.lastNotifiedAt : undefined,
        };
        void persist(next);
        return next;
      });
      thresholdCrossRef.current = null;

      try {
        await writeAlertToSupabase(lat, lon, categoryIndex, Math.round(cooldownMinutes));
      } catch (e) {
        console.error('SAVE FAILED:', e);
        setReminderState(null);
        await persist(null);
        thresholdCrossRef.current = null;
        throw e;
      }
    },
    [persist],
  );

  const clearReminder = useCallback(async () => {
    setReminderState(null);
    await persist(null);
    thresholdCrossRef.current = null;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData.session?.user?.id;
      if (uid) await deleteUserNotificationSettings(uid);
    } catch {
      /* ignore */
    }
  }, [persist]);

  useEffect(() => {
    if (!loadedRef.current || reminder == null || !viewingLive) return;

    const { predPm25 } = computeSsfSelection(reminder.lat, reminder.lon, sensors, kriging);
    const aqi = pm25ToAqi(predPm25);
    const above = aqiMeetsReminderThreshold(aqi, reminder.categoryIndex);
    const key = `${reminder.lat.toFixed(5)},${reminder.lon.toFixed(5)},${reminder.categoryIndex}`;
    const prev = thresholdCrossRef.current;

    if (prev?.key !== key) {
      thresholdCrossRef.current = { key, wasAbove: above };
      return;
    }

    if (above && !prev.wasAbove) {
      const cooldownMs = (reminder.cooldownMinutes ?? 60) * 60 * 1000;
      const last = reminder.lastNotifiedAt;
      const withinCooldown = last != null && Date.now() - last < cooldownMs;

      if (!withinCooldown) {
        void (async () => {
          try {
            await Notifications.scheduleNotificationAsync({
              content: {
                title: 'Air quality alert',
                body: 'The estimated AQI at your saved map spot reached your reminder threshold.',
                sound: true,
                ...(Platform.OS === 'android'
                  ? { android: { channelId: 'air-quality' } }
                  : {}),
              },
              trigger: null,
            });
            setReminderState((current) => {
              if (current == null) return current;
              const next: AirQualityReminder = { ...current, lastNotifiedAt: Date.now() };
              void persist(next);
              return next;
            });
          } catch {
            /* ignore */
          }
        })();
      }
    }

    thresholdCrossRef.current = { key, wasAbove: above };
  }, [reminder, sensors, kriging, viewingLive, persist]);

  const isReminderForCoordinate = useCallback(
    (coord: { lat: number; lon: number } | null) => {
      if (coord == null || reminder == null) return false;
      return coordsMatch(coord, reminder);
    },
    [reminder],
  );

  return {
    reminder,
    setReminder,
    clearReminder,
    isReminderForCoordinate,
  };
}
