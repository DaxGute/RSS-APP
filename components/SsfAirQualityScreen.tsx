import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ClarityRow, CurrentKrigingRow, DailySensorAqiRow, PurpleAirRow } from '../lib/database.types';
import type { FetchError } from '../lib/fetchAirQuality';
import {
  fetchDailySensorAqiCalendarRows,
  fetchDailySensorAqiCalendarRowsForMonth,
  fetchSensorReadingsBetweenRecordedTimes,
} from '../lib/fetchAirQuality';
import { pm25ToAqi } from '../lib/aqiUtils';
import { useAirQualityReminder } from '../hooks/useAirQualityReminder';
import { regionFromSensorData } from '../lib/mapRegionFromData';
import type { SensorPoint } from '../lib/sensorTypes';
import { AqiPanel } from './AqiPanel';
import { SsfMap } from './SsfMap';
import { TimeRangeModule } from './TimeRangeModule';
import { TimelineCalendarModal } from './TimelineCalendarModal';

const FILTER_MIN_YEAR = 2021;
const BOTTOM_TAB_BAR_RESERVE = 6;
const CALLOUT_WIDTH = 300;
const CALLOUT_HEIGHT_ESTIMATE = 210;
const CALLOUT_SCREEN_GUTTER = 12;
const TEN_MIN_MS = 10 * 60 * 1000;
/**
 * Max |reading − slot| for a bucket to use that reading. One full 10‑minute step
 * is needed so the earliest/latest rows in the window can still match the first
 * and last grid slots (the grid start is aligned down, up to ~10 min before the
 * first reading).
 */
const SLOT_READING_MATCH_MS = TEN_MIN_MS;

const TIME_FILTER_MAIN_IN_MS = 200;
const TIME_FILTER_SUB_IN_MS = 220;
const TIME_FILTER_SUB_OUT_MS = 170;
const TIME_FILTER_MAIN_OUT_MS = 190;
const TIME_FILTER_MAIN_ENTER_OFFSET_Y = -10;
/** Submenu sits left of Day/Month; slide in from the right (+x) and exit back that way. */
const TIME_FILTER_SUB_SLIDE_OFFSET_X = 16;
const TIME_FILTER_SUB_SWITCH_OUT_MS = 140;
const TIME_FILTER_SUB_SWITCH_IN_MS = 190;

function resolveRowAqi(row: DailySensorAqiRow): number | null {
  if (row.aqi != null && Number.isFinite(row.aqi)) return row.aqi;
  if (row.pm25 != null && Number.isFinite(row.pm25)) {
    const derived = pm25ToAqi(row.pm25);
    return derived != null && Number.isFinite(derived) ? derived : null;
  }
  return null;
}

function dateKeyLocal(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function monthKeyLocal(date: Date): string {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabelToStartDate(label: string): Date {
  const now = new Date();
  if (label === 'This Month') return new Date(now.getFullYear(), now.getMonth(), 1);
  const m = label.match(/^([A-Za-z]{3}) '(\d{2})$/);
  if (!m) return new Date(now.getFullYear(), now.getMonth(), 1);
  const monthIdx = MONTH_LABELS.findIndex((mm) => mm === m[1]);
  const y = 2000 + Number.parseInt(m[2], 10);
  return new Date(y, Math.max(0, monthIdx), 1);
}

function dayOffsetFromRelativeLabel(label: string): number | null {
  if (label === 'Today') return 0;
  if (label === 'Yesterday') return 1;
  const m = label.match(/^(\d+) Days Ago$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function localDayBoundsForOffset(daysAgo: number): { startIso: string; endIso: string; dayKey: string } {
  const start = new Date();
  start.setDate(start.getDate() - daysAgo);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dayKey: dateKeyLocal(start),
  };
}

function buildAverageAqiTimeseriesFromFeeds(
  purpleAir: PurpleAirRow[] | null | undefined,
  clarity: ClarityRow[] | null | undefined,
): Array<{ time: string; avgAqi: number }> {
  const sums = new Map<string, { total: number; count: number }>();
  const addRow = (time: string | null | undefined, pm25: number | null | undefined) => {
    if (!time || pm25 == null || !Number.isFinite(pm25)) return;
    const aqi = pm25ToAqi(pm25);
    if (aqi == null || !Number.isFinite(aqi)) return;
    const curr = sums.get(time) ?? { total: 0, count: 0 };
    curr.total += aqi;
    curr.count += 1;
    sums.set(time, curr);
  };
  for (const row of purpleAir ?? []) addRow(row.time, row.pm25);
  for (const row of clarity ?? []) addRow(row.time, row.pm25);
  return Array.from(sums.entries())
    .map(([time, v]) => ({ time, avgAqi: v.count > 0 ? v.total / v.count : 0 }))
    .filter((r) => Number.isFinite(new Date(r.time).getTime()))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}

function alignLocalMsDownToTenMin(ms: number): number {
  const d = new Date(ms);
  d.setSeconds(0, 0);
  d.setMilliseconds(0);
  const minutes = d.getMinutes();
  d.setMinutes(minutes - (minutes % 10), 0, 0);
  return d.getTime();
}

/**
 * 10-minute slot ISOs for the rolling "Today" chart only.
 * Uses a strict last-24h floor and `min(now, latest reading)` so we do not
 * render empty buckets in the future or before the true 24h cutoff (fetch
 * buffers must not widen the visible axis).
 */
function generateRolling24hTenMinuteSlotIsos(
  averagePairs: Array<{ time: string; avgAqi: number }>,
): string[] {
  const nowMs = Date.now();
  const strictStart = nowMs - 24 * 60 * 60 * 1000;
  let t = alignLocalMsDownToTenMin(strictStart);

  let maxDataMs = -Infinity;
  for (const p of averagePairs) {
    const x = new Date(p.time).getTime();
    if (Number.isFinite(x)) maxDataMs = Math.max(maxDataMs, x);
  }
  const rawEnd = maxDataMs === -Infinity ? nowMs : maxDataMs;
  const slotEndBound = Math.max(strictStart, Math.min(nowMs, rawEnd));
  const lastSlotStart = alignLocalMsDownToTenMin(slotEndBound);
  const lastAxisSlot = alignLocalMsDownToTenMin(nowMs);

  const out: string[] = [];
  while (t <= lastSlotStart && t <= lastAxisSlot) {
    out.push(new Date(t).toISOString());
    t += TEN_MIN_MS;
  }
  return out;
}

function generateLocalCalendarDayTenMinuteSlotIsos(dayKey: string): string[] {
  const parts = dayKey.split('-').map((x) => Number.parseInt(x, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return [];
  const [y, mo, da] = parts;
  let t = new Date(y, mo - 1, da, 0, 0, 0, 0).getTime();
  const last = new Date(y, mo - 1, da, 23, 59, 59, 999).getTime();
  const out: string[] = [];
  while (t <= last) {
    out.push(new Date(t).toISOString());
    t += TEN_MIN_MS;
  }
  return out;
}

function matchReadingToTenMinuteSlot(
  slotIso: string,
  pairs: Array<{ time: string; avgAqi: number }>,
): { avgAqi: number; selectableTime: string | null } {
  const slotMs = new Date(slotIso).getTime();
  if (!Number.isFinite(slotMs)) return { avgAqi: 0, selectableTime: null };
  let best: { time: string; avgAqi: number; dist: number } | null = null;
  for (const p of pairs) {
    const pm = new Date(p.time).getTime();
    if (!Number.isFinite(pm)) continue;
    const dist = Math.abs(pm - slotMs);
    if (dist > SLOT_READING_MATCH_MS) continue;
    if (!best || dist < best.dist || (dist === best.dist && p.time < best.time)) {
      best = { time: p.time, avgAqi: p.avgAqi, dist };
    }
  }
  if (best && Number.isFinite(best.avgAqi)) {
    return { avgAqi: best.avgAqi, selectableTime: best.time };
  }
  return { avgAqi: 0, selectableTime: null };
}

function buildTimelineChartFromDenseSlots(
  slotIsos: string[],
  averagePairs: Array<{ time: string; avgAqi: number }>,
  selectedTimeIsoForUi: string | null,
): {
  points: Array<{ time: string; avgAqi: number; position: number; selectableTime: string | null }>;
  ticks: Array<{ position: number; label: string }>;
  selectedPosition: number | null;
} {
  const sortedSlots = [...slotIsos]
    .filter((iso) => Number.isFinite(new Date(iso).getTime()))
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  const n = Math.max(1, sortedSlots.length);
  const pts = sortedSlots.map((iso, i) => {
    const { avgAqi, selectableTime } = matchReadingToTenMinuteSlot(iso, averagePairs);
    return {
      time: iso,
      avgAqi: Number.isFinite(avgAqi) ? avgAqi : 0,
      position: n <= 1 ? 0 : i / (n - 1),
      selectableTime,
    };
  });
  const hourTickTargets: Array<{ hour: number; label: string }> = [
    { hour: 6, label: '6a' },
    { hour: 0, label: '12a' },
    { hour: 18, label: '6p' },
    { hour: 12, label: '12p' },
  ];
  const ticks = hourTickTargets
    .map(({ hour, label }) => {
      if (sortedSlots.length === 0) return null;
      let bestIdx = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < sortedSlots.length; i += 1) {
        const d = new Date(sortedSlots[i]);
        if (!Number.isFinite(d.getTime())) continue;
        const dist = Math.abs(d.getHours() - hour);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      return {
        idx: bestIdx,
        position: n <= 1 ? 0 : bestIdx / (n - 1),
        label,
      };
    })
    .filter((tick): tick is { idx: number; position: number; label: string } => tick != null)
    .sort((a, b) => a.position - b.position)
    .filter((tick, idx, arr) => idx === 0 || tick.idx !== arr[idx - 1].idx)
    .map(({ position, label }) => ({ position, label }));

  let selectedIndex = -1;
  if (selectedTimeIsoForUi && sortedSlots.length > 0) {
    const selMs = new Date(selectedTimeIsoForUi).getTime();
    if (Number.isFinite(selMs)) {
      let bestI = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < sortedSlots.length; i += 1) {
        const d = Math.abs(new Date(sortedSlots[i]).getTime() - selMs);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      const exact = sortedSlots.findIndex((iso) => iso === selectedTimeIsoForUi);
      selectedIndex = exact >= 0 ? exact : bestI;
    }
  }

  return {
    points: pts,
    ticks,
    selectedPosition:
      sortedSlots.length <= 1 ? 0 : selectedIndex >= 0 ? selectedIndex / (sortedSlots.length - 1) : 1,
  };
}

export type SsfAirQualityScreenProps = {
  sensors: SensorPoint[];
  kriging: CurrentKrigingRow[];
  loading: boolean;
  error: FetchError | null;
  timelineTimesAsc: string[];
  timelineIndex: number;
  onTimelineIndexChange: (index: number) => void;
  onSelectRecordedTime: (recordedTime: string) => void;
  viewingLive: boolean;
  timelineLoading: boolean;
  insufficientData: boolean;
  liveAverageAqi: number | null;
  averageAqiTimeseries: Array<{ time: string; avgAqi: number }>;
};

export function SsfAirQualityScreen({
  sensors,
  kriging,
  loading,
  error,
  timelineTimesAsc,
  timelineIndex,
  onTimelineIndexChange,
  onSelectRecordedTime,
  viewingLive,
  timelineLoading,
  insufficientData,
  liveAverageAqi,
  averageAqiTimeseries,
}: SsfAirQualityScreenProps) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();

  const [selected, setSelected] = useState<{
    lat: number;
    lon: number;
    label: string | null;
    screenPointX: number | null;
    screenPointY: number | null;
    sensorIndex?: number;
    sensorSource?: string;
  } | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [timeFilterMenuOpen, setTimeFilterMenuOpen] = useState(false);
  const [timeFilterMode, setTimeFilterMode] = useState<'Day' | 'Month'>('Day');
  const [dayMenuOpen, setDayMenuOpen] = useState(false);
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);
  const [selectedDayLabel, setSelectedDayLabel] = useState('Today');
  const [selectedMonthLabel, setSelectedMonthLabel] = useState('This Month');
  const [calendarRows, setCalendarRows] = useState<DailySensorAqiRow[]>([]);
  const [monthRowsLoading, setMonthRowsLoading] = useState(false);
  const [dayPastRowsLoading, setDayPastRowsLoading] = useState(false);
  const [pastDayAverageAqiTimeseries, setPastDayAverageAqiTimeseries] = useState<Array<{ time: string; avgAqi: number }>>(
    [],
  );
  // Tracks a scrub landing on a chart bucket with no underlying readings (its
  // `selectableTime` is null). We keep the marker visible at that position and
  // render a blank map + overlay without touching the live timeline state.
  const [pendingNoDataBucketTime, setPendingNoDataBucketTime] = useState<string | null>(null);
  const dayLoadGenRef = useRef(0);

  const mainDropdownOpacity = useRef(new Animated.Value(0)).current;
  const mainDropdownTranslateY = useRef(new Animated.Value(0)).current;
  const subDropdownOpacity = useRef(new Animated.Value(0)).current;
  const subDropdownTranslateX = useRef(new Animated.Value(0)).current;
  const timeFilterRunningAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const timeFilterCloseTokenRef = useRef(0);
  const timeFilterSwitchTokenRef = useRef(0);
  const dayMenuOpenRef = useRef(dayMenuOpen);
  const monthMenuOpenRef = useRef(monthMenuOpen);
  const timeFilterMenuOpenRef = useRef(timeFilterMenuOpen);
  const closeTimeFilterMenuRef = useRef<(afterClose?: () => void) => void>(() => {});
  dayMenuOpenRef.current = dayMenuOpen;
  monthMenuOpenRef.current = monthMenuOpen;
  timeFilterMenuOpenRef.current = timeFilterMenuOpen;
  const prevTimeFilterMenuOpenRef = useRef(false);

  const mapRegion = useMemo(() => regionFromSensorData(sensors, kriging), [sensors, kriging]);
  const selectedTimeIsoForUi = useMemo(
    () => timelineTimesAsc[timelineIndex] ?? (timelineTimesAsc.length === 0 ? new Date().toISOString() : null),
    [timelineIndex, timelineTimesAsc],
  );
  const isSelectedDateToday = useMemo(() => {
    if (!selectedTimeIsoForUi) return true;
    const selectedDate = new Date(selectedTimeIsoForUi);
    if (!Number.isFinite(selectedDate.getTime())) return true;
    return dateKeyLocal(selectedDate) === dateKeyLocal(new Date());
  }, [selectedTimeIsoForUi]);
  const todayTimelineTimesAsc = useMemo(() => {
    const todayKey = dateKeyLocal(new Date());
    return timelineTimesAsc
      .filter((iso) => {
        const d = new Date(iso);
        if (!Number.isFinite(d.getTime())) return false;
        return dateKeyLocal(d) === todayKey;
      })
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  }, [timelineTimesAsc]);
  const prevIsSelectedDateTodayRef = useRef(isSelectedDateToday);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchDailySensorAqiCalendarRows();
      if (cancelled || res.error || !res.data) return;
      setCalendarRows(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const wasToday = prevIsSelectedDateTodayRef.current;
    if (!wasToday && isSelectedDateToday && timelineTimesAsc.length > 0) {
      const latestTodayIso = todayTimelineTimesAsc[todayTimelineTimesAsc.length - 1];
      if (latestTodayIso) {
        const latestTodaySourceIndex = timelineTimesAsc.findIndex((iso) => iso === latestTodayIso);
        if (latestTodaySourceIndex >= 0 && latestTodaySourceIndex !== timelineIndex) {
          onTimelineIndexChange(latestTodaySourceIndex);
        }
      }
    }
    prevIsSelectedDateTodayRef.current = isSelectedDateToday;
  }, [isSelectedDateToday, onTimelineIndexChange, timelineIndex, timelineTimesAsc, todayTimelineTimesAsc]);

  const { reminder, setReminder, clearReminder, isReminderForCoordinate } = useAirQualityReminder(
    sensors,
    kriging,
    viewingLive,
  );

  const onSelectCoordinate = useCallback(
    (
      lat: number,
      lon: number,
      detail: {
        touchInBottomBand: boolean;
        screenPointX?: number | null;
        screenPointY?: number | null;
        sensorIndex?: number;
        sensorSource?: string;
        sensorName?: string | null;
      },
    ) => {
      if (timeFilterMenuOpenRef.current) {
        closeTimeFilterMenuRef.current();
      }
      const matchedSensor =
        detail.sensorIndex != null
          ? sensors.find(
              (s) =>
                s.sensorIndex === detail.sensorIndex &&
                (detail.sensorSource == null || s.source === detail.sensorSource),
            ) ?? sensors.find((s) => s.sensorIndex === detail.sensorIndex)
          : undefined;
      const sensorName = detail.sensorName ?? matchedSensor?.name ?? null;
      setSelected({
        lat,
        lon,
        label: sensorName,
        screenPointX: detail.screenPointX ?? null,
        screenPointY: detail.screenPointY ?? null,
        sensorIndex: matchedSensor?.sensorIndex,
        sensorSource: matchedSensor?.source,
      });
    },
    [sensors],
  );

  const clearSelection = useCallback(() => {
    setSelected(null);
  }, []);

  const playTimeFilterOpenAnimation = useCallback(() => {
    timeFilterRunningAnimRef.current?.stop();
    const hasSub = dayMenuOpenRef.current || monthMenuOpenRef.current;
    const easingOut = Easing.out(Easing.cubic);

    mainDropdownOpacity.setValue(0);
    mainDropdownTranslateY.setValue(TIME_FILTER_MAIN_ENTER_OFFSET_Y);
    if (hasSub) {
      subDropdownOpacity.setValue(0);
      subDropdownTranslateX.setValue(TIME_FILTER_SUB_SLIDE_OFFSET_X);
    } else {
      subDropdownOpacity.setValue(1);
      subDropdownTranslateX.setValue(0);
    }

    const mainEnter = Animated.parallel([
      Animated.timing(mainDropdownOpacity, {
        toValue: 1,
        duration: TIME_FILTER_MAIN_IN_MS,
        easing: easingOut,
        useNativeDriver: true,
      }),
      Animated.timing(mainDropdownTranslateY, {
        toValue: 0,
        duration: TIME_FILTER_MAIN_IN_MS,
        easing: easingOut,
        useNativeDriver: true,
      }),
    ]);

    const composite: Animated.CompositeAnimation = hasSub
      ? Animated.sequence([
          mainEnter,
          Animated.parallel([
            Animated.timing(subDropdownOpacity, {
              toValue: 1,
              duration: TIME_FILTER_SUB_IN_MS,
              easing: easingOut,
              useNativeDriver: true,
            }),
            Animated.timing(subDropdownTranslateX, {
              toValue: 0,
              duration: TIME_FILTER_SUB_IN_MS,
              easing: easingOut,
              useNativeDriver: true,
            }),
          ]),
        ])
      : mainEnter;

    timeFilterRunningAnimRef.current = composite;
    composite.start(({ finished }) => {
      if (timeFilterRunningAnimRef.current === composite) timeFilterRunningAnimRef.current = null;
    });
  }, [mainDropdownOpacity, mainDropdownTranslateY, subDropdownOpacity, subDropdownTranslateX]);

  const closeTimeFilterMenu = useCallback(
    (afterClose?: () => void) => {
      timeFilterRunningAnimRef.current?.stop();
      timeFilterSwitchTokenRef.current += 1;
      const closeToken = (timeFilterCloseTokenRef.current += 1);
      const hasSub = dayMenuOpenRef.current || monthMenuOpenRef.current;
      const easingIn = Easing.in(Easing.cubic);

      const subOut = Animated.parallel([
        Animated.timing(subDropdownOpacity, {
          toValue: 0,
          duration: TIME_FILTER_SUB_OUT_MS,
          easing: easingIn,
          useNativeDriver: true,
        }),
        Animated.timing(subDropdownTranslateX, {
          toValue: TIME_FILTER_SUB_SLIDE_OFFSET_X,
          duration: TIME_FILTER_SUB_OUT_MS,
          easing: easingIn,
          useNativeDriver: true,
        }),
      ]);
      const mainOut = Animated.parallel([
        Animated.timing(mainDropdownOpacity, {
          toValue: 0,
          duration: TIME_FILTER_MAIN_OUT_MS,
          easing: easingIn,
          useNativeDriver: true,
        }),
        Animated.timing(mainDropdownTranslateY, {
          toValue: TIME_FILTER_MAIN_ENTER_OFFSET_Y,
          duration: TIME_FILTER_MAIN_OUT_MS,
          easing: easingIn,
          useNativeDriver: true,
        }),
      ]);

      const closeAnim = hasSub ? Animated.sequence([subOut, mainOut]) : mainOut;
      timeFilterRunningAnimRef.current = closeAnim;
      closeAnim.start(({ finished }) => {
        if (!finished || closeToken !== timeFilterCloseTokenRef.current) return;
        if (timeFilterRunningAnimRef.current === closeAnim) timeFilterRunningAnimRef.current = null;
        setTimeFilterMenuOpen(false);
        setDayMenuOpen(false);
        setMonthMenuOpen(false);
        afterClose?.();
      });
    },
    [mainDropdownOpacity, mainDropdownTranslateY, subDropdownOpacity, subDropdownTranslateX],
  );
  closeTimeFilterMenuRef.current = closeTimeFilterMenu;

  const dismissTimeFilterIfOpen = useCallback(() => {
    if (timeFilterMenuOpenRef.current) {
      closeTimeFilterMenuRef.current();
    }
  }, []);

  const switchInnerTimeFilterSubmenu = useCallback(
    (apply: () => void) => {
      timeFilterRunningAnimRef.current?.stop();
      const switchToken = (timeFilterSwitchTokenRef.current += 1);
      const easingIn = Easing.in(Easing.cubic);
      const easingOut = Easing.out(Easing.cubic);

      const subOut = Animated.parallel([
        Animated.timing(subDropdownOpacity, {
          toValue: 0,
          duration: TIME_FILTER_SUB_SWITCH_OUT_MS,
          easing: easingIn,
          useNativeDriver: true,
        }),
        Animated.timing(subDropdownTranslateX, {
          toValue: TIME_FILTER_SUB_SLIDE_OFFSET_X,
          duration: TIME_FILTER_SUB_SWITCH_OUT_MS,
          easing: easingIn,
          useNativeDriver: true,
        }),
      ]);

      subOut.start(({ finished }) => {
        if (!finished || switchToken !== timeFilterSwitchTokenRef.current) return;
        if (timeFilterRunningAnimRef.current === subOut) timeFilterRunningAnimRef.current = null;
        const runSwapAndIn = () => {
          if (switchToken !== timeFilterSwitchTokenRef.current) return;
          apply();
          subDropdownOpacity.setValue(0);
          subDropdownTranslateX.setValue(TIME_FILTER_SUB_SLIDE_OFFSET_X);

          const subIn = Animated.parallel([
            Animated.timing(subDropdownOpacity, {
              toValue: 1,
              duration: TIME_FILTER_SUB_SWITCH_IN_MS,
              easing: easingOut,
              useNativeDriver: true,
            }),
            Animated.timing(subDropdownTranslateX, {
              toValue: 0,
              duration: TIME_FILTER_SUB_SWITCH_IN_MS,
              easing: easingOut,
              useNativeDriver: true,
            }),
          ]);
          timeFilterRunningAnimRef.current = subIn;
          subIn.start(({ finished: fin }) => {
            if (!fin || switchToken !== timeFilterSwitchTokenRef.current) return;
            if (timeFilterRunningAnimRef.current === subIn) timeFilterRunningAnimRef.current = null;
          });
        };
        requestAnimationFrame(() => {
          requestAnimationFrame(runSwapAndIn);
        });
      });
      timeFilterRunningAnimRef.current = subOut;
    },
    [subDropdownOpacity, subDropdownTranslateX],
  );

  useEffect(() => {
    if (timeFilterMenuOpen && !prevTimeFilterMenuOpenRef.current) {
      playTimeFilterOpenAnimation();
    }
    prevTimeFilterMenuOpenRef.current = timeFilterMenuOpen;
  }, [timeFilterMenuOpen, playTimeFilterOpenAnimation]);

  const selectedCalloutPlacement = useMemo<'above' | 'below'>(() => {
    if (!selected?.screenPointY) return 'above';
    const requiredTopSpace = CALLOUT_HEIGHT_ESTIMATE + 24;
    return selected.screenPointY - requiredTopSpace >= insets.top ? 'above' : 'below';
  }, [insets.top, selected?.screenPointY]);

  const selectedCalloutShiftX = useMemo(() => {
    const x = selected?.screenPointX;
    if (x == null) return 0;
    const halfW = CALLOUT_WIDTH / 2;
    const minLeft = CALLOUT_SCREEN_GUTTER;
    const maxRight = windowWidth - CALLOUT_SCREEN_GUTTER;
    const left = x - halfW;
    const right = x + halfW;
    if (left < minLeft) return minLeft - left;
    if (right > maxRight) return maxRight - right;
    return 0;
  }, [selected?.screenPointX, windowWidth]);

  const monthOptions = useMemo(() => {
    const now = new Date();
    const out: string[] = ['This Month'];
    // From last month backwards to Jan 2021.
    let d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    while (d.getFullYear() >= FILTER_MIN_YEAR) {
      const yy = `${d.getFullYear()}`.slice(-2);
      out.push(`${MONTH_LABELS[d.getMonth()]} '${yy}`);
      d = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    }
    return out;
  }, []);

  const dayOptions = useMemo(() => {
    const out: string[] = ['Today', 'Yesterday'];
    for (let i = 2; i <= 7; i += 1) out.push(`${i} Days Ago`);
    return out;
  }, []);

  const chartData = useMemo(() => {
    if (timeFilterMode === 'Day' && selectedDayLabel === 'Today') {
      const slots = generateRolling24hTenMinuteSlotIsos(averageAqiTimeseries);
      return buildTimelineChartFromDenseSlots(slots, averageAqiTimeseries, selectedTimeIsoForUi);
    }

    if (timeFilterMode === 'Day' && selectedDayLabel !== 'Today') {
      const offset = dayOffsetFromRelativeLabel(selectedDayLabel);
      const slots =
        offset == null ? [] : generateLocalCalendarDayTenMinuteSlotIsos(localDayBoundsForOffset(offset).dayKey);
      return buildTimelineChartFromDenseSlots(slots, pastDayAverageAqiTimeseries, selectedTimeIsoForUi);
    }

    if (timeFilterMode === 'Month') {
      if (selectedMonthLabel === 'This Month') {
        const end = new Date();
        end.setDate(end.getDate() - 1);
        end.setHours(23, 59, 59, 999);
        const start = new Date(end);
        start.setDate(start.getDate() - 29);
        start.setHours(0, 0, 0, 0);
        const endMs = end.getTime();
        const startMs = start.getTime();
        const byDay = new Map<string, { sum: number; count: number; latest: string | null }>();
        for (const r of calendarRows) {
          const d = new Date(r.time);
          const ts = d.getTime();
          if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
          const key = dateKeyLocal(d);
          const curr = byDay.get(key) ?? { sum: 0, count: 0, latest: null };
          const rowAqi = resolveRowAqi(r);
          if (rowAqi != null) {
            curr.sum += rowAqi;
            curr.count += 1;
          }
          if (!curr.latest || ts > new Date(curr.latest).getTime()) curr.latest = r.time;
          byDay.set(key, curr);
        }

        const points = Array.from({ length: 30 }, (_, i) => {
          const day = new Date(start);
          day.setDate(start.getDate() + i);
          const key = dateKeyLocal(day);
          const bucket = byDay.get(key);
          const normalized = i / 29;
          return {
            time: day.toISOString(),
            avgAqi: bucket && bucket.count > 0 ? bucket.sum / bucket.count : 0,
            // "This Month" should advance forward in time as position increases.
            position: normalized,
            selectableTime: bucket?.latest ?? null,
          };
        });

        const findLatestDayIndex = (dayOfMonth: number): number => {
          for (let i = points.length - 1; i >= 0; i -= 1) {
            if (new Date(points[i].time).getDate() === dayOfMonth) return i;
          }
          return -1;
        };
        const firstIdx = findLatestDayIndex(1);
        const fifteenthIdx = findLatestDayIndex(15);
        const selectedDayKey = selectedTimeIsoForUi ? dateKeyLocal(new Date(selectedTimeIsoForUi)) : null;
        const selectedPosition =
          selectedDayKey == null
            ? null
            : points.find((p) => dateKeyLocal(new Date(p.time)) === selectedDayKey)?.position ?? null;
        const buildTickLabel = (index: number, suffix: '1st' | '15th') => {
          const d = new Date(points[index].time);
          return `${MONTH_LABELS[d.getMonth()]} ${suffix}`;
        };
        const ticks = [
          firstIdx >= 0 ? { position: points[firstIdx].position, label: buildTickLabel(firstIdx, '1st') } : null,
          fifteenthIdx >= 0 ? { position: points[fifteenthIdx].position, label: buildTickLabel(fifteenthIdx, '15th') } : null,
        ].filter((tick): tick is { position: number; label: string } => tick != null);

        return {
          points,
          ticks,
          selectedPosition,
        };
      }

      const target = monthLabelToStartDate(selectedMonthLabel);
      const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      const rows = calendarRows.filter((r) => {
        const d = new Date(r.time);
        return Number.isFinite(d.getTime()) && monthKeyLocal(d) === monthKeyLocal(target);
      });
      const byDay = new Map<number, { sum: number; count: number; latest: string | null }>();
      for (const r of rows) {
        const d = new Date(r.time);
        if (!Number.isFinite(d.getTime())) continue;
        const day = d.getDate();
        const curr = byDay.get(day) ?? { sum: 0, count: 0, latest: null };
        const rowAqi = resolveRowAqi(r);
        if (rowAqi != null) {
          curr.sum += rowAqi;
          curr.count += 1;
        }
        if (!curr.latest || new Date(r.time).getTime() > new Date(curr.latest).getTime()) curr.latest = r.time;
        byDay.set(day, curr);
      }
      const points = Array.from({ length: daysInMonth }, (_, i) => {
        const day = i + 1;
        const bucket = byDay.get(day);
        const avgAqi = bucket && bucket.count > 0 ? bucket.sum / bucket.count : 0;
        const iso = new Date(target.getFullYear(), target.getMonth(), day).toISOString();
        const normalized = daysInMonth <= 1 ? 0 : i / (daysInMonth - 1);
        return {
          time: iso,
          avgAqi,
          // Month view should advance forward in time as position increases.
          position: normalized,
          selectableTime: bucket?.latest ?? null,
        };
      });
      const selectedDayKey = selectedTimeIsoForUi ? dateKeyLocal(new Date(selectedTimeIsoForUi)) : null;
      return {
        points,
        ticks: [
          { position: 0, label: '1' },
          { position: 0.25, label: `${Math.max(1, Math.round(daysInMonth * 0.25))}` },
          { position: 0.5, label: `${Math.max(1, Math.round(daysInMonth * 0.5))}` },
          { position: 0.75, label: `${Math.max(1, Math.round(daysInMonth * 0.75))}` },
        ],
        selectedPosition:
          selectedDayKey == null
            ? null
            : points.find((p) => dateKeyLocal(new Date(p.time)) === selectedDayKey)?.position ?? null,
      };
    }

    return { points: [], ticks: [], selectedPosition: null };
  }, [
    calendarRows,
    pastDayAverageAqiTimeseries,
    averageAqiTimeseries,
    selectedDayLabel,
    selectedMonthLabel,
    selectedTimeIsoForUi,
    timelineIndex,
    timelineTimesAsc,
    timeFilterMode,
  ]);

  const timeFilterButtonLabel = useMemo(() => {
    if (timeFilterMode === 'Day') return selectedDayLabel;
    return selectedMonthLabel;
  }, [selectedDayLabel, selectedMonthLabel, timeFilterMode]);
  const scrubMarkerLabel = useMemo(() => {
    // Prefer the no-data bucket while one is pinned so the marker reflects
    // exactly where the user landed.
    const iso = pendingNoDataBucketTime ?? selectedTimeIsoForUi;
    if (!iso) return null;
    const selectedDate = new Date(iso);
    if (!Number.isFinite(selectedDate.getTime())) return null;
    if (timeFilterMode === 'Day') {
      return selectedDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return selectedDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
  }, [pendingNoDataBucketTime, selectedTimeIsoForUi, timeFilterMode]);

  const effectiveSelectedPosition = useMemo(() => {
    if (pendingNoDataBucketTime != null) {
      const match = chartData.points.find((p) => p.time === pendingNoDataBucketTime);
      if (match) return match.position;
    }
    return chartData.selectedPosition;
  }, [chartData.points, chartData.selectedPosition, pendingNoDataBucketTime]);

  const showInsufficientOverlay = pendingNoDataBucketTime != null || (!viewingLive && insufficientData);
  const mapSensors = showInsufficientOverlay ? [] : sensors;
  const mapKriging = showInsufficientOverlay ? [] : kriging;

  // Drop any open sensor callout when entering an empty-map state, since the
  // pin it referenced is no longer on screen.
  useEffect(() => {
    if (showInsufficientOverlay && selected != null) setSelected(null);
  }, [selected, showInsufficientOverlay]);

  const lastAppliedSwitchKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const switchKey = `${timeFilterMode}:${
      timeFilterMode === 'Month' ? selectedMonthLabel : timeFilterMode === 'Day' ? selectedDayLabel : ''
    }`;
    if (lastAppliedSwitchKeyRef.current === switchKey) return;
    lastAppliedSwitchKeyRef.current = switchKey;
    // Switching filters invalidates any bucket the user had landed on.
    setPendingNoDataBucketTime(null);

    if (timeFilterMode === 'Day' && selectedDayLabel !== 'Today') {
      return;
    }

    if (timeFilterMode === 'Day' && selectedDayLabel === 'Today') {
      if (timelineTimesAsc.length > 0) {
        const latestTimelineIso = [...timelineTimesAsc]
          .filter((iso) => Number.isFinite(new Date(iso).getTime()))
          .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
          .at(-1);
        if (latestTimelineIso) {
          const latestSourceIndex = timelineTimesAsc.findIndex((iso) => iso === latestTimelineIso);
          if (latestSourceIndex >= 0) onTimelineIndexChange(latestSourceIndex);
        }
      }
      return;
    }

    const topSelectableTime = [...chartData.points]
      .sort((a, b) => a.position - b.position)
      .find((p) => p.selectableTime)?.selectableTime;
    if (topSelectableTime) onSelectRecordedTime(topSelectableTime);
  }, [
    chartData.points,
    onSelectRecordedTime,
    onTimelineIndexChange,
    selectedDayLabel,
    selectedMonthLabel,
    timeFilterMode,
    timelineTimesAsc,
  ]);

  const applyScrubRecordedTime = useCallback(
    (recordedTime: string, { isCommit }: { isCommit: boolean }) => {
      // TimeRangeModule emits a bucket `time` (with `selectableTime == null`)
      // when the user scrubs onto a chart bucket that has no underlying
      // readings. Detect that case so we can show a blank map + overlay rather
      // than driving the live timeline.
      const noDataBucket = chartData.points.find(
        (p) => p.time === recordedTime && p.selectableTime == null,
      );
      if (noDataBucket) {
        if (pendingNoDataBucketTime !== recordedTime) {
          setPendingNoDataBucketTime(recordedTime);
        }
        return;
      }

      if (pendingNoDataBucketTime != null) setPendingNoDataBucketTime(null);

      const sourceIndex = timelineTimesAsc.findIndex((iso) => iso === recordedTime);
      if (sourceIndex >= 0) {
        if (sourceIndex !== timelineIndex) onTimelineIndexChange(sourceIndex);
        return;
      }
      const dayPastMode = timeFilterMode === 'Day' && selectedDayLabel !== 'Today';
      if (isCommit || timeFilterMode === 'Month' || dayPastMode) onSelectRecordedTime(recordedTime);
    },
    [
      chartData.points,
      onSelectRecordedTime,
      onTimelineIndexChange,
      pendingNoDataBucketTime,
      selectedDayLabel,
      timeFilterMode,
      timelineIndex,
      timelineTimesAsc,
    ],
  );

  return (
    <View style={styles.screenRoot}>
      <View style={styles.screenContent}>
        <View style={styles.main}>
          <View style={styles.mapCol}>
            <SsfMap
              sensors={mapSensors}
              kriging={mapKriging}
              mapRegion={mapRegion}
              selected={selected ? { latitude: selected.lat, longitude: selected.lon } : null}
              selectedCalloutPlacement={selectedCalloutPlacement}
              selectedCalloutShiftX={selectedCalloutShiftX}
              selectedCallout={
                selected ? (
                  <AqiPanel
                    selected={selected}
                    selectedLabel={selected.label}
                    selectedSensor={
                      selected.sensorIndex != null
                        ? {
                            sensorIndex: selected.sensorIndex,
                            source: selected.sensorSource,
                          }
                        : null
                    }
                    loading={loading}
                    error={error}
                    sensors={sensors}
                    kriging={kriging}
                    mapRegion={mapRegion}
                    onClose={clearSelection}
                    sheetMode
                    sheetDocked
                    healthTooltipPlacement="above"
                    reminderBellActive={isReminderForCoordinate(selected)}
                    onReminderPickThreshold={async (categoryIndex, cooldownMinutes) => {
                      if (selected == null) return;
                      try {
                        await setReminder(selected.lat, selected.lon, categoryIndex, cooldownMinutes);
                      } catch {
                        Alert.alert(
                          'Check your connection',
                          'We could not save your reminder. Check your connection.',
                        );
                      }
                    }}
                    onReminderCooldownChange={async (cooldownMinutes) => {
                      if (reminder == null) return;
                      try {
                        await setReminder(
                          reminder.lat,
                          reminder.lon,
                          reminder.categoryIndex,
                          cooldownMinutes,
                        );
                      } catch {
                        Alert.alert(
                          'Check your connection',
                          'We could not save your reminder. Check your connection.',
                        );
                      }
                    }}
                    onReminderClear={clearReminder}
                    savedReminderCategoryIndex={reminder?.categoryIndex ?? null}
                    savedReminderCooldownMinutes={reminder?.cooldownMinutes ?? null}
                  />
                ) : null
              }
              reminderLocation={
                reminder ? { latitude: reminder.lat, longitude: reminder.lon } : null
              }
              onSelectCoordinate={onSelectCoordinate}
            />
            {showInsufficientOverlay ? (
              <View style={styles.insufficientWrap} pointerEvents="none">
                <View style={styles.insufficientCard}>
                  <View style={styles.insufficientIconWrap}>
                    <Ionicons name="cloud-offline-outline" size={22} color="#475569" />
                  </View>
                  <Text style={styles.insufficientTitle}>Insufficient Data</Text>
                  <Text style={styles.insufficientSubtitle}>No sensor readings for this time.</Text>
                </View>
              </View>
            ) : null}
          </View>

          <View
            style={[
              styles.calendarBtnWrap,
              {
                top: Math.max(insets.top, 6),
                right: Math.max(insets.right + 8, 8),
              },
            ]}
          >
            {timelineLoading || monthRowsLoading || dayPastRowsLoading ? (
              <ActivityIndicator size="small" color="#475569" style={styles.calendarSpinner} />
            ) : null}
            <Pressable
              onPress={() => {
                const nextOpen = !timeFilterMenuOpen;
                if (nextOpen) {
                  setTimeFilterMenuOpen(true);
                  if (timeFilterMode === 'Month') {
                    setMonthMenuOpen(true);
                    setDayMenuOpen(false);
                  } else if (timeFilterMode === 'Day') {
                    setDayMenuOpen(true);
                    setMonthMenuOpen(false);
                  } else {
                    setMonthMenuOpen(false);
                    setDayMenuOpen(false);
                  }
                } else {
                  closeTimeFilterMenu();
                }
              }}
              style={({ pressed }) => [styles.calendarButton, pressed && styles.calendarButtonPressed]}
              accessibilityRole="button"
              accessibilityLabel="Open time filter menu"
            >
              <Ionicons name="calendar-outline" size={18} color="#1f2937" />
              <Text style={styles.calendarButtonText} numberOfLines={1}>
                {timeFilterButtonLabel}
              </Text>
              <Ionicons name={timeFilterMenuOpen ? 'chevron-up' : 'chevron-down'} size={16} color="#334155" />
            </Pressable>
            {timeFilterMenuOpen ? (
              <Animated.View
                style={[
                  styles.mainDropdown,
                  {
                    opacity: mainDropdownOpacity,
                    transform: [{ translateY: mainDropdownTranslateY }],
                  },
                ]}
              >
                {(['Day', 'Month'] as const).map((option) => (
                  <Pressable
                    key={option}
                    onPress={() => {
                      if (option === 'Day') {
                        if (timeFilterMode === 'Day' && dayMenuOpen) return;
                        if (timeFilterMenuOpen && timeFilterMode === 'Month' && monthMenuOpen) {
                          switchInnerTimeFilterSubmenu(() => {
                            setTimeFilterMode('Day');
                            setMonthMenuOpen(false);
                            setDayMenuOpen(true);
                            setSelectedDayLabel('Today');
                            setPastDayAverageAqiTimeseries([]);
                          });
                          return;
                        }
                        setTimeFilterMode('Day');
                        setMonthMenuOpen(false);
                        setDayMenuOpen(true);
                        setTimeFilterMenuOpen(true);
                        if (timeFilterMode === 'Month') {
                          setSelectedDayLabel('Today');
                          setPastDayAverageAqiTimeseries([]);
                        }
                        return;
                      }
                      if (option === 'Month') {
                        if (timeFilterMode === 'Month' && monthMenuOpen) return;
                        if (timeFilterMenuOpen && timeFilterMode === 'Day' && dayMenuOpen) {
                          switchInnerTimeFilterSubmenu(() => {
                            setTimeFilterMode('Month');
                            setDayMenuOpen(false);
                            setMonthMenuOpen(true);
                          });
                          return;
                        }
                        setTimeFilterMode('Month');
                        setDayMenuOpen(false);
                        setMonthMenuOpen(true);
                        setTimeFilterMenuOpen(true);
                        return;
                      }
                    }}
                    style={({ pressed }) => [
                      styles.dropdownItem,
                      timeFilterMode === option && styles.dropdownItemSelected,
                      pressed && styles.dropdownItemPressed,
                    ]}
                  >
                    <Text style={styles.dropdownItemText}>{option}</Text>
                    {option === 'Day' || option === 'Month' ? (
                      <Ionicons name="chevron-back" size={14} color="#475569" />
                    ) : null}
                  </Pressable>
                ))}
              </Animated.View>
            ) : null}
            {dayMenuOpen || monthMenuOpen ? (
              <Animated.View
                collapsable={false}
                needsOffscreenAlphaCompositing={Platform.OS === 'ios'}
                style={[
                  styles.subDropdownLeft,
                  {
                    opacity: subDropdownOpacity,
                    transform: [{ translateX: subDropdownTranslateX }],
                  },
                ]}
              >
                <View style={styles.subDropdownInnerStack}>
                  <View
                    collapsable={false}
                    pointerEvents={dayMenuOpen ? 'auto' : 'none'}
                    style={[
                      styles.subDropdownLayerBase,
                      dayMenuOpen ? styles.subDropdownLayerActive : styles.subDropdownLayerInactive,
                    ]}
                  >
                    <ScrollView
                      style={styles.subDropdownScroll}
                      contentContainerStyle={styles.subDropdownScrollContent}
                      showsVerticalScrollIndicator
                      nestedScrollEnabled
                      removeClippedSubviews={false}
                    >
                      {dayOptions.map((day) => (
                        <Pressable
                          key={`day-${day}`}
                          onPress={() => {
                            const picked = day;
                            closeTimeFilterMenu(() => {
                              void (async () => {
                                setSelectedDayLabel(picked);
                                if (picked === 'Today') {
                                  dayLoadGenRef.current += 1;
                                  setPastDayAverageAqiTimeseries([]);
                                  setDayPastRowsLoading(false);
                                  if (timelineTimesAsc.length > 0) {
                                    const latestTimelineIso = [...timelineTimesAsc]
                                      .filter((iso) => Number.isFinite(new Date(iso).getTime()))
                                      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
                                      .at(-1);
                                    if (latestTimelineIso) {
                                      const latestSourceIndex = timelineTimesAsc.findIndex(
                                        (iso) => iso === latestTimelineIso,
                                      );
                                      if (latestSourceIndex >= 0) onTimelineIndexChange(latestSourceIndex);
                                    }
                                  }
                                  return;
                                }
                                const offset = dayOffsetFromRelativeLabel(picked);
                                if (offset == null) return;
                                const gen = (dayLoadGenRef.current += 1);
                                setDayPastRowsLoading(true);
                                try {
                                  const { startIso, endIso, dayKey } = localDayBoundsForOffset(offset);
                                  const res = await fetchSensorReadingsBetweenRecordedTimes(startIso, endIso);
                                  if (gen !== dayLoadGenRef.current) return;
                                  if (res.error) {
                                    setPastDayAverageAqiTimeseries([]);
                                    return;
                                  }
                                  const seriesAll = buildAverageAqiTimeseriesFromFeeds(res.purpleAir, res.clarity);
                                  const series = seriesAll.filter((p) => dateKeyLocal(new Date(p.time)) === dayKey);
                                  const timesAsc = series
                                    .map((p) => p.time)
                                    .filter((t) => Number.isFinite(new Date(t).getTime()))
                                    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
                                  setPastDayAverageAqiTimeseries(series);
                                  const latest = timesAsc.at(-1);
                                  if (latest) onSelectRecordedTime(latest);
                                } finally {
                                  if (gen === dayLoadGenRef.current) setDayPastRowsLoading(false);
                                }
                              })();
                            });
                          }}
                          style={({ pressed }) => [
                            styles.dropdownItem,
                            selectedDayLabel === day && styles.dropdownItemSelected,
                            pressed && styles.dropdownItemPressed,
                          ]}
                        >
                          <Text style={styles.dropdownItemText}>{day}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                  <View
                    collapsable={false}
                    pointerEvents={monthMenuOpen ? 'auto' : 'none'}
                    style={[
                      styles.subDropdownLayerBase,
                      monthMenuOpen ? styles.subDropdownLayerActive : styles.subDropdownLayerInactive,
                    ]}
                  >
                    <ScrollView
                      style={styles.subDropdownScroll}
                      contentContainerStyle={styles.subDropdownScrollContent}
                      showsVerticalScrollIndicator
                      nestedScrollEnabled
                      removeClippedSubviews={false}
                    >
                      {monthOptions.map((month) => (
                        <Pressable
                          key={`month-${month}`}
                          onPress={() => {
                            const picked = month;
                            closeTimeFilterMenu(() => {
                              void (async () => {
                                setSelectedMonthLabel(picked);
                                setMonthRowsLoading(true);
                                const monthStart = monthLabelToStartDate(picked);
                                const monthEnd = new Date(
                                  monthStart.getFullYear(),
                                  monthStart.getMonth() + 1,
                                  0,
                                  23,
                                  59,
                                  59,
                                  999,
                                );
                                const res =
                                  picked === 'This Month'
                                    ? await fetchDailySensorAqiCalendarRows()
                                    : await fetchDailySensorAqiCalendarRowsForMonth(
                                        monthStart.toISOString(),
                                        monthEnd.toISOString(),
                                      );
                                if (!res.error && res.data) setCalendarRows(res.data);
                                setMonthRowsLoading(false);
                              })();
                            });
                          }}
                          style={({ pressed }) => [
                            styles.dropdownItem,
                            selectedMonthLabel === month && styles.dropdownItemSelected,
                            pressed && styles.dropdownItemPressed,
                          ]}
                        >
                          <Text style={styles.dropdownItemText}>{month}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                </View>
              </Animated.View>
            ) : null}
          </View>

          <View
            style={[
              styles.timeOfDayWrap,
              {
                left: 8,
                right: Math.max(insets.right + 8, 8),
                bottom: BOTTOM_TAB_BAR_RESERVE,
              },
            ]}
            pointerEvents="auto"
          >
            <TimeRangeModule
              key={`${timeFilterMode}:${selectedMonthLabel}:${selectedDayLabel}`}
              points={chartData.points}
              active
              loading={timelineLoading || monthRowsLoading || dayPastRowsLoading}
              selectedPosition={effectiveSelectedPosition}
              ticks={chartData.ticks}
              markerLabel={scrubMarkerLabel}
              onScrubBegin={dismissTimeFilterIfOpen}
              topLabel={
                timeFilterMode === 'Month'
                  ? selectedMonthLabel === 'This Month'
                    ? 'yesterday'
                    : null
                  : timeFilterMode === 'Day' && selectedDayLabel === 'Today'
                    ? 'now'
                    : null
              }
              graphOnly
              onPreviewTime={(recordedTime) => {
                applyScrubRecordedTime(recordedTime, { isCommit: false });
              }}
              onCommitTime={(recordedTime) => {
                applyScrubRecordedTime(recordedTime, { isCommit: true });
              }}
            />
          </View>
        </View>
      </View>
      <TimelineCalendarModal
        visible={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        timelineTimesAsc={timelineTimesAsc}
        timelineIndex={timelineIndex}
        onPickRecordedTime={(recordedTime) => {
          setCalendarOpen(false);
          onSelectRecordedTime(recordedTime);
        }}
        liveAverageAqi={liveAverageAqi}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screenRoot: { flex: 1, backgroundColor: '#e8f0fe' },
  screenContent: { flex: 1, position: 'relative' },
  main: { flex: 1, minHeight: 0 },
  mapCol: { flex: 1, minHeight: 0, zIndex: 0 },
  calendarBtnWrap: {
    position: 'absolute',
    right: 10,
    zIndex: 31,
    backgroundColor: 'transparent',
  },
  calendarSpinner: {
    position: 'absolute',
    top: 10,
    right: 10,
  },
  calendarButton: {
    minHeight: 42,
    width: 154,
    paddingHorizontal: 16,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    shadowColor: '#1e293b',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  calendarButtonPressed: {
    opacity: 0.88,
    transform: [{ translateY: 0.5 }],
  },
  calendarButtonText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.2,
    color: '#334155',
    textAlign: 'center',
  },
  mainDropdown: {
    marginTop: 6,
    alignSelf: 'flex-end',
    minWidth: 136,
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingVertical: 4,
    shadowColor: '#0f172a',
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  subDropdownLeft: {
    position: 'absolute',
    right: 146,
    top: 48,
    minWidth: 120,
    maxHeight: 220,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingVertical: 4,
    shadowColor: '#0f172a',
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  subDropdownInnerStack: {
    position: 'relative',
    width: '100%',
    overflow: 'hidden',
  },
  subDropdownLayerBase: {
    width: '100%',
  },
  subDropdownLayerActive: {
    position: 'relative',
    zIndex: 2,
    opacity: 1,
  },
  subDropdownLayerInactive: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    zIndex: 0,
    opacity: 0,
  },
  subDropdownScroll: {
    maxHeight: 220,
  },
  subDropdownScrollContent: {
    paddingVertical: 4,
  },
  dropdownItem: {
    minHeight: 34,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownItemSelected: {
    backgroundColor: 'rgba(37,99,235,0.1)',
  },
  dropdownItemPressed: {
    backgroundColor: 'rgba(226,232,240,0.8)',
  },
  dropdownItemText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
  },
  timeOfDayWrap: {
    position: 'absolute',
    zIndex: 30,
    elevation: 30,
    overflow: 'visible',
  },
  insufficientWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 3,
  },
  insufficientCard: {
    minWidth: 220,
    maxWidth: 320,
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 16,
    alignItems: 'center',
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.45)',
    shadowColor: '#0f172a',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  insufficientIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(226,232,240,0.85)',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.5)',
    marginBottom: 8,
  },
  insufficientTitle: {
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.3,
    color: '#0f172a',
    textAlign: 'center',
  },
  insufficientSubtitle: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'center',
    letterSpacing: 0.15,
  },
});
