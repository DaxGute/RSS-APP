import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CurrentKrigingRow } from '../lib/database.types';
import type { DailySensorAqiRow } from '../lib/database.types';
import type { FetchError } from '../lib/fetchAirQuality';
import { fetchDailySensorAqiCalendarRows, fetchDailySensorAqiCalendarRowsForMonth } from '../lib/fetchAirQuality';
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
  const [timeFilterMode, setTimeFilterMode] = useState<'Today' | 'Month'>('Today');
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);
  const [selectedMonthLabel, setSelectedMonthLabel] = useState('This Month');
  const [calendarRows, setCalendarRows] = useState<DailySensorAqiRow[]>([]);
  const [monthRowsLoading, setMonthRowsLoading] = useState(false);

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
  const timelineTimesForUi = useMemo(() => {
    if (!selectedTimeIsoForUi) return todayTimelineTimesAsc;
    if (!isSelectedDateToday) return [selectedTimeIsoForUi];
    return todayTimelineTimesAsc.length > 0 ? todayTimelineTimesAsc : [selectedTimeIsoForUi];
  }, [isSelectedDateToday, selectedTimeIsoForUi, todayTimelineTimesAsc]);
  const timelineIndexForUi = useMemo(
    () => {
      if (timelineTimesForUi.length === 0) return 0;
      if (!selectedTimeIsoForUi) return Math.max(0, timelineTimesForUi.length - 1);
      const indexInUi = timelineTimesForUi.findIndex((iso) => iso === selectedTimeIsoForUi);
      if (indexInUi >= 0) return indexInUi;
      return Math.max(0, timelineTimesForUi.length - 1);
    },
    [selectedTimeIsoForUi, timelineTimesForUi],
  );
  const todayAverageAqiTimeseries = useMemo(() => {
    const selectedKey = selectedTimeIsoForUi ? dateKeyLocal(new Date(selectedTimeIsoForUi)) : dateKeyLocal(new Date());
    return averageAqiTimeseries.filter((p) => {
      const d = new Date(p.time);
      if (!Number.isFinite(d.getTime())) return false;
      return dateKeyLocal(d) === selectedKey;
    });
  }, [averageAqiTimeseries, selectedTimeIsoForUi]);
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

  const chartData = useMemo(() => {
    if (timeFilterMode === 'Today') {
      // Restore scrub behavior: one point per real timeline timestamp (rolling 24h).
      const aqiByTime = new Map<string, number>();
      for (const p of averageAqiTimeseries) {
        if (Number.isFinite(p.avgAqi)) aqiByTime.set(p.time, p.avgAqi);
      }
      const sortedTimelineTimes = [...timelineTimesAsc]
        .filter((iso) => Number.isFinite(new Date(iso).getTime()))
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
      const n = Math.max(1, sortedTimelineTimes.length);
      const pts = sortedTimelineTimes.map((iso, i) => ({
        time: iso,
        avgAqi: aqiByTime.get(iso) ?? 0,
        position: n <= 1 ? 0 : i / (n - 1),
        selectableTime: iso,
      }));
      const hourTickTargets: Array<{ hour: number; label: string }> = [
        { hour: 6, label: '6a' },
        { hour: 0, label: '12a' },
        { hour: 18, label: '6p' },
        { hour: 12, label: '12p' },
      ];
      const ticks = hourTickTargets
        .map(({ hour, label }) => {
          if (sortedTimelineTimes.length === 0) return null;
          let bestIdx = 0;
          let bestDist = Number.POSITIVE_INFINITY;
          for (let i = 0; i < sortedTimelineTimes.length; i += 1) {
            const d = new Date(sortedTimelineTimes[i]);
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
      const selectedIndex = selectedTimeIsoForUi
        ? sortedTimelineTimes.findIndex((iso) => iso === selectedTimeIsoForUi)
        : -1;
      return {
        points: pts,
        ticks,
        selectedPosition:
          sortedTimelineTimes.length <= 1
            ? 0
            : selectedIndex >= 0
              ? selectedIndex / (sortedTimelineTimes.length - 1)
              : 1,
      };
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
    selectedMonthLabel,
    selectedTimeIsoForUi,
    timelineIndex,
    timelineTimesAsc,
    timeFilterMode,
    averageAqiTimeseries,
    todayAverageAqiTimeseries,
  ]);

  const timeFilterButtonLabel = useMemo(() => {
    if (timeFilterMode === 'Today') return 'Today';
    return selectedMonthLabel;
  }, [selectedMonthLabel, timeFilterMode]);
  const scrubMarkerLabel = useMemo(() => {
    if (!selectedTimeIsoForUi) return null;
    const selectedDate = new Date(selectedTimeIsoForUi);
    if (!Number.isFinite(selectedDate.getTime())) return null;
    if (timeFilterMode === 'Today') {
      return selectedDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return selectedDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
  }, [selectedTimeIsoForUi, timeFilterMode]);

  const lastAppliedSwitchKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const switchKey = `${timeFilterMode}:${timeFilterMode === 'Month' ? selectedMonthLabel : ''}`;
    if (lastAppliedSwitchKeyRef.current === switchKey) return;
    lastAppliedSwitchKeyRef.current = switchKey;

    // Always reset to the top position when switching filter context.
    if (timeFilterMode === 'Today') {
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
    selectedMonthLabel,
    timeFilterMode,
    timelineTimesAsc,
  ]);

  const applyScrubRecordedTime = useCallback(
    (recordedTime: string, { isCommit }: { isCommit: boolean }) => {
      const sourceIndex = timelineTimesAsc.findIndex((iso) => iso === recordedTime);
      if (sourceIndex >= 0) {
        if (sourceIndex !== timelineIndex) onTimelineIndexChange(sourceIndex);
        return;
      }
      // Month buckets can point to historical timestamps outside the rolling
      // timeline list; route through recorded-time selection so scrub loads data.
      if (isCommit || timeFilterMode !== 'Today') onSelectRecordedTime(recordedTime);
    },
    [onSelectRecordedTime, onTimelineIndexChange, timeFilterMode, timelineIndex, timelineTimesAsc],
  );

  return (
    <View style={styles.screenRoot}>
      <View style={styles.screenContent}>
        <View style={styles.main}>
          <View style={styles.mapCol}>
            <SsfMap
              sensors={sensors}
              kriging={kriging}
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
            {!viewingLive && insufficientData ? (
              <View style={styles.insufficientWrap} pointerEvents="none">
                <Text style={styles.insufficientText}>Insufficient Data</Text>
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
            {timelineLoading ? (
              <ActivityIndicator size="small" color="#475569" style={styles.calendarSpinner} />
            ) : null}
            <Pressable
              onPress={() => {
                const nextOpen = !timeFilterMenuOpen;
                setTimeFilterMenuOpen(nextOpen);
                if (nextOpen) {
                  if (timeFilterMode === 'Month') setMonthMenuOpen(true);
                  else setMonthMenuOpen(false);
                } else {
                  setMonthMenuOpen(false);
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
              <View style={styles.mainDropdown}>
                {(['Today', 'Month'] as const).map((option) => (
                  <Pressable
                    key={option}
                    onPress={() => {
                      setTimeFilterMode(option);
                      if (option === 'Today') {
                        setMonthMenuOpen(false);
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
                        setTimeFilterMenuOpen(false);
                        return;
                      }
                      if (option === 'Month') {
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
                    {option === 'Month' ? (
                      <Ionicons name="chevron-back" size={14} color="#475569" />
                    ) : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
            {monthMenuOpen ? (
              <View style={styles.subDropdownLeft}>
                <ScrollView
                  style={styles.subDropdownScroll}
                  contentContainerStyle={styles.subDropdownScrollContent}
                  showsVerticalScrollIndicator
                  nestedScrollEnabled
                >
                  {monthOptions.map((month) => (
                    <Pressable
                      key={`month-${month}`}
                      onPress={() => {
                        void (async () => {
                          setSelectedMonthLabel(month);
                          setMonthMenuOpen(false);
                          setTimeFilterMenuOpen(false);
                          setMonthRowsLoading(true);
                          const monthStart = monthLabelToStartDate(month);
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
                            month === 'This Month'
                              ? await fetchDailySensorAqiCalendarRows()
                              : await fetchDailySensorAqiCalendarRowsForMonth(
                                  monthStart.toISOString(),
                                  monthEnd.toISOString(),
                                );
                          if (!res.error && res.data) setCalendarRows(res.data);
                          setMonthRowsLoading(false);
                        })();
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
              key={`${timeFilterMode}:${selectedMonthLabel}`}
              points={chartData.points}
              active
              loading={timelineLoading || monthRowsLoading}
              selectedPosition={chartData.selectedPosition}
              ticks={chartData.ticks}
              markerLabel={scrubMarkerLabel}
              topLabel={
                timeFilterMode === 'Month'
                  ? selectedMonthLabel === 'This Month'
                    ? 'yesterday'
                    : null
                  : 'now'
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
  insufficientText: {
    color: '#dc2626',
    fontSize: 22,
    fontWeight: '800',
    textShadowColor: 'rgba(255,255,255,0.95)',
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 0 },
  },
});
