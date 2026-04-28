import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Calendar } from 'react-native-calendars';

import { aqiCategory, pm25ToAqi } from '../lib/aqiUtils';
import { fetchDailySensorAqiCalendarRows, fetchDailySensorAqiCalendarRowsForMonth } from '../lib/fetchAirQuality';

type DaySummary = { dayAqi: number | null; bg: string; fg: string };
const DAY_FADE_DURATION_MS = 500;
const DAY_FADE_STAGGER_MS = 80;
const DAY_FADE_TICK_MS = 33;

export type TimelineCalendarModalProps = {
  visible: boolean;
  onClose: () => void;
  timelineTimesAsc: string[];
  timelineIndex: number;
  onPickRecordedTime: (recordedTime: string) => void;
  liveAverageAqi: number | null;
};

export function TimelineCalendarModal({
  visible,
  onClose,
  timelineTimesAsc,
  timelineIndex,
  onPickRecordedTime,
  liveAverageAqi,
}: TimelineCalendarModalProps) {
  const [loadingDayData, setLoadingDayData] = useState(false);
  const [daySummaries, setDaySummaries] = useState<Map<string, DaySummary>>(new Map());
  const [recordedTimeByDay, setRecordedTimeByDay] = useState<Map<string, string>>(new Map());
  const [visibleMonth, setVisibleMonth] = useState<string | null>(null);
  const [fadeRun, setFadeRun] = useState<{ monthKey: string; startedAtMs: number; nowMs: number } | null>(null);
  const monthCacheRef = useRef<Map<string, { summaries: Map<string, DaySummary>; byDayRecordedTime: Map<string, string> }>>(
    new Map(),
  );
  const dayAqiCacheRef = useRef<Map<string, DaySummary>>(new Map());
  const dayRecordedTimeCacheRef = useRef<Map<string, string>>(new Map());
  const fadeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const monthBlendOpacity = useRef(new Animated.Value(1)).current;

  const selectedIso = timelineTimesAsc[timelineIndex] ?? null;
  const selectedDateKey = useMemo(() => {
    if (!selectedIso) return null;
    if (isWithinPastDay(selectedIso)) return dateKeyLocal(new Date());
    return dateKeyFromIso(selectedIso);
  }, [selectedIso]);

  const timesByDay = useMemo(() => {
    const out = new Map<string, number[]>();
    for (let i = 0; i < timelineTimesAsc.length; i += 1) {
      const d = new Date(timelineTimesAsc[i]);
      if (!Number.isFinite(d.getTime())) continue;
      const key = dateKeyLocal(d);
      const prev = out.get(key);
      if (prev) prev.push(i);
      else out.set(key, [i]);
    }
    return out;
  }, [timelineTimesAsc]);

  const { maxDate, initialDate } = useMemo(() => {
    const now = new Date();
    const endOfCurrentMonth = dateKeyLocal(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    return {
      maxDate: endOfCurrentMonth,
      initialDate: selectedDateKey ?? dateKeyLocal(now),
    };
  }, [selectedDateKey]);

  const currentMonthKey = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}`;
  }, []);

  const activeMonthKey = visibleMonth ?? initialDate.slice(0, 7);
  const activeMonthDate = `${activeMonthKey}-01`;
  const loadingMonthLabel = useMemo(() => formatMonthLabel(activeMonthKey), [activeMonthKey]);

  const disableArrowRight = useMemo(() => {
    return activeMonthKey >= currentMonthKey;
  }, [activeMonthKey, currentMonthKey]);

  const activeMonthDays = useMemo(() => enumerateDaysInMonth(activeMonthKey), [activeMonthKey]);
  const todayKey = useMemo(() => dateKeyLocal(new Date()), []);
  const activeMonthDayIndex = useMemo(() => {
    const out = new Map<string, number>();
    activeMonthDays.forEach((day, index) => out.set(day, index));
    return out;
  }, [activeMonthDays]);

  const startMonthFadeAnimation = useCallback((monthKey: string) => {
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current);
      fadeIntervalRef.current = null;
    }
    const days = enumerateDaysInMonth(monthKey);
    const startedAtMs = Date.now();
    setFadeRun({ monthKey, startedAtMs, nowMs: startedAtMs });
    const totalDurationMs = Math.max(0, (days.length - 1) * DAY_FADE_STAGGER_MS + DAY_FADE_DURATION_MS);
    fadeIntervalRef.current = setInterval(() => {
      const nowMs = Date.now();
      setFadeRun((prev) => {
        if (!prev || prev.monthKey !== monthKey) return prev;
        return { ...prev, nowMs };
      });
      if (nowMs - startedAtMs >= totalDurationMs && fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current);
        fadeIntervalRef.current = null;
      }
    }, DAY_FADE_TICK_MS);
  }, []);

  const resetMonthFadeToHidden = useCallback((monthKey: string) => {
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current);
      fadeIntervalRef.current = null;
    }
    const nowMs = Date.now();
    setFadeRun({ monthKey, startedAtMs: nowMs, nowMs });
  }, []);

  const opacityForDay = useCallback(
    (day: string): number => {
      if (!fadeRun || fadeRun.monthKey !== activeMonthKey) return 1;
      const dayIndex = activeMonthDayIndex.get(day);
      if (dayIndex == null) return 1;
      const elapsed = fadeRun.nowMs - fadeRun.startedAtMs - dayIndex * DAY_FADE_STAGGER_MS;
      if (elapsed <= 0) return 0;
      if (elapsed >= DAY_FADE_DURATION_MS) return 1;
      return elapsed / DAY_FADE_DURATION_MS;
    },
    [activeMonthDayIndex, activeMonthKey, fadeRun],
  );

  const effectiveDaySummaries = useMemo(() => {
    const out = new Map(daySummaries);
    const todayKey = dateKeyLocal(new Date());
    if (liveAverageAqi != null && Number.isFinite(liveAverageAqi)) {
      const cat = aqiCategory(Math.round(liveAverageAqi));
      out.set(todayKey, { dayAqi: Math.round(liveAverageAqi), bg: cat.bg, fg: cat.fg });
    }
    return out;
  }, [daySummaries, liveAverageAqi]);

  const markedDates = useMemo(() => {
    const out: Record<
      string,
      {
        customStyles?: { container: object; text: object };
        disabled?: boolean;
        disableTouchEvent?: boolean;
      }
    > = {};
    for (const day of enumerateDaysInMonth(activeMonthKey)) {
      if (day > maxDate) {
        out[day] = {
          disabled: true,
          disableTouchEvent: true,
        };
        continue;
      }
      const summary = effectiveDaySummaries.get(day);
      const hasRecordedSnapshot = recordedTimeByDay.has(day) || timesByDay.has(day);
      const canSelectDay = hasRecordedSnapshot || (day === todayKey && timelineTimesAsc.length > 0);
      const isSelected = day === selectedDateKey;
      const dayOpacity = opacityForDay(day);
      if (summary) {
        out[day] = {
          disabled: false,
          disableTouchEvent: false,
          customStyles: {
            container: {
              backgroundColor: summary.bg,
              borderColor: isSelected ? '#111827' : summary.bg,
              borderWidth: isSelected ? 2 : 1,
              borderRadius: 8,
              opacity: dayOpacity,
            },
            text: {
              color: isSelected ? '#ffffff' : summary.fg,
              fontWeight: '700',
              opacity: dayOpacity,
            },
          },
        };
      } else if (canSelectDay) {
        out[day] = {
          disabled: false,
          disableTouchEvent: false,
          customStyles: {
            container: {
              backgroundColor: 'transparent',
              borderColor: isSelected ? '#111827' : 'transparent',
              borderWidth: isSelected ? 2 : 1,
              borderRadius: 8,
              opacity: dayOpacity,
            },
            text: {
              color: '#334155',
              fontWeight: '700',
              opacity: dayOpacity,
            },
          },
        };
      } else {
        out[day] = {
          disabled: true,
          disableTouchEvent: true,
          customStyles: {
            container: {
              backgroundColor: 'transparent',
              borderColor: 'transparent',
              borderWidth: 1,
              borderRadius: 8,
              opacity: dayOpacity,
            },
            text: {
              color: '#cbd5e1',
              fontWeight: '700',
              opacity: dayOpacity,
            },
          },
        };
      }
    }
    return out;
  }, [
    activeMonthKey,
    effectiveDaySummaries,
    maxDate,
    opacityForDay,
    recordedTimeByDay,
    selectedDateKey,
    timelineTimesAsc.length,
    timesByDay,
    todayKey,
  ]);

  useEffect(() => {
    if (!visible) return;
    setVisibleMonth(initialDate.slice(0, 7));
  }, [visible]);

  useEffect(() => {
    return () => {
      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current);
        fadeIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    monthBlendOpacity.setValue(0.5);
    Animated.timing(monthBlendOpacity, {
      toValue: 1,
      duration: 420,
      easing: Easing.inOut(Easing.sin),
      useNativeDriver: true,
    }).start();
  }, [activeMonthKey, monthBlendOpacity]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    resetMonthFadeToHidden(activeMonthKey);
    const cached = monthCacheRef.current.get(activeMonthKey);
    if (cached) {
      setDaySummaries(cached.summaries);
      setRecordedTimeByDay(cached.byDayRecordedTime);
      setFadeRun(null);
      setLoadingDayData(false);
      return;
    }

    setLoadingDayData(true);
    void (async () => {
      try {
        const data = await loadCalendarRowsForMonth(activeMonthKey);
        if (cancelled) return;
        const { summaries, byDayRecordedTime } = buildDaySummaries(data);
        for (const [dayKey, summary] of summaries) dayAqiCacheRef.current.set(dayKey, summary);
        for (const [dayKey, recordedIso] of byDayRecordedTime) dayRecordedTimeCacheRef.current.set(dayKey, recordedIso);

        const monthSummary = new Map<string, DaySummary>();
        const monthRecordedTimes = new Map<string, string>();
        for (const day of enumerateDaysInMonth(activeMonthKey)) {
          const summary = dayAqiCacheRef.current.get(day);
          if (summary) monthSummary.set(day, summary);
          const recordedIso = dayRecordedTimeCacheRef.current.get(day);
          if (recordedIso) monthRecordedTimes.set(day, recordedIso);
        }
        monthCacheRef.current.set(activeMonthKey, {
          summaries: monthSummary,
          byDayRecordedTime: monthRecordedTimes,
        });
        setDaySummaries(monthSummary);
        setRecordedTimeByDay(monthRecordedTimes);
        startMonthFadeAnimation(activeMonthKey);
      } finally {
        if (!cancelled) setLoadingDayData(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeMonthKey, resetMonthFadeToHidden, startMonthFadeAnimation, visible]);

  useEffect(() => {
    if (visible) return;
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current);
      fadeIntervalRef.current = null;
    }
    setFadeRun(null);
    setVisibleMonth(null);
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.calendarModalRoot}>
        <Pressable
          style={styles.calendarModalBackdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close calendar"
        />
        <View style={styles.calendarModalCard}>
          <View style={styles.calendarModalHead}>
            <Text style={styles.calendarModalTitle}>Select date</Text>
            <Pressable onPress={onClose} style={styles.calendarCloseBtn} accessibilityRole="button">
              <Ionicons name="close" size={18} color="#334155" />
            </Pressable>
          </View>
          <Text style={styles.calendarModalHint}>Only dates with data are selectable.</Text>

          <Animated.View style={[styles.calendarWrap, { opacity: monthBlendOpacity }]}>
            <Calendar
              key={activeMonthKey}
              current={activeMonthDate}
              maxDate={maxDate}
              hideExtraDays
              hideArrows={false}
              enableSwipeMonths={false}
              disableArrowRight={disableArrowRight}
              renderArrow={(direction) => (
                <Ionicons
                  name={direction === 'left' ? 'chevron-back' : 'chevron-forward'}
                  size={18}
                  color="#1e3a8a"
                  style={styles.calendarNavArrow}
                />
              )}
              disabledByDefault
              disableAllTouchEventsForDisabledDays
              markingType="custom"
              markedDates={markedDates}
              onMonthChange={(m) => setVisibleMonth(`${m.year}-${`${m.month}`.padStart(2, '0')}`)}
              onDayPress={(day) => {
                const dayKey = day.dateString;
                if (dayKey === todayKey && timelineTimesAsc.length > 0) {
                  const latestTimelineTime = timelineTimesAsc[timelineTimesAsc.length - 1] ?? null;
                  if (latestTimelineTime) {
                    onPickRecordedTime(latestTimelineTime);
                    onClose();
                  }
                  return;
                }
                const recordedFromCalendar = recordedTimeByDay.get(dayKey) ?? null;
                const recordedFromTimeline = (() => {
                  const candidates = timesByDay.get(dayKey);
                  if (!candidates || candidates.length === 0) return null;
                  return timelineTimesAsc[candidates[candidates.length - 1]] ?? null;
                })();
                const recordedFromTodayFallback =
                  dayKey === todayKey && timelineTimesAsc.length > 0
                    ? timelineTimesAsc[timelineTimesAsc.length - 1] ?? null
                    : null;
                const recordedTime = (() => {
                  if (recordedFromCalendar && recordedFromTimeline) {
                    const calendarMs = new Date(recordedFromCalendar).getTime();
                    const timelineMs = new Date(recordedFromTimeline).getTime();
                    if (Number.isFinite(calendarMs) && Number.isFinite(timelineMs)) {
                      return timelineMs >= calendarMs ? recordedFromTimeline : recordedFromCalendar;
                    }
                  }
                  return recordedFromTimeline ?? recordedFromCalendar ?? recordedFromTodayFallback;
                })();
                if (!recordedTime) return;
                onPickRecordedTime(recordedTime);
                onClose();
              }}
              theme={{
                calendarBackground: '#f8fafc',
                monthTextColor: '#0f172a',
                textSectionTitleColor: '#64748b',
                textDayFontWeight: '700',
                textMonthFontWeight: '800',
                textDayHeaderFontWeight: '600',
                arrowColor: '#1e3a8a',
                todayTextColor: '#1e3a8a',
                textDisabledColor: '#cbd5e1',
              }}
            />
            {loadingDayData ? (
              <View style={styles.calendarLoadingOverlay} pointerEvents="none">
                <ActivityIndicator size="large" color="#475569" />
              </View>
            ) : null}
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

function buildDaySummaries(
  rows: Array<{ aqi: number | null; pm25: number | null; time: string }>,
): { summaries: Map<string, DaySummary>; byDayRecordedTime: Map<string, string> } {
  const byDay = new Map<string, number[]>();
  const byDayRecordedTime = new Map<string, string>();
  for (const row of rows) {
    const dayKey = dateKeyFromIso(row.time);
    if (!dayKey) continue;
    const previousRecordedTime = byDayRecordedTime.get(dayKey);
    if (!previousRecordedTime) {
      byDayRecordedTime.set(dayKey, row.time);
    } else {
      const prevMs = new Date(previousRecordedTime).getTime();
      const nextMs = new Date(row.time).getTime();
      if (Number.isFinite(nextMs) && (!Number.isFinite(prevMs) || nextMs > prevMs)) {
        byDayRecordedTime.set(dayKey, row.time);
      }
    }
    const readingAqi = Number.isFinite(Number(row.aqi))
      ? Math.round(Number(row.aqi))
      : pm25ToAqi(row.pm25);
    if (readingAqi == null || !Number.isFinite(readingAqi)) continue;
    const prev = byDay.get(dayKey);
    if (prev) prev.push(readingAqi);
    else byDay.set(dayKey, [readingAqi]);
  }
  const out = new Map<string, DaySummary>();
  for (const [dayKey, values] of byDay) {
    if (values.length === 0) continue;
    const dayAqi = Math.round(values.reduce((acc, n) => acc + n, 0) / values.length);
    const cat = aqiCategory(dayAqi);
    out.set(dayKey, {
      dayAqi,
      bg: cat.bg,
      fg: cat.fg,
    });
  }
  return { summaries: out, byDayRecordedTime };
}

function dateKeyLocal(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function enumerateDaysInclusive(minDate: string, maxDate: string): string[] {
  const start = new Date(`${minDate}T00:00:00`);
  const end = new Date(`${maxDate}T00:00:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return [];
  const out: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    out.push(dateKeyLocal(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function enumerateDaysInMonth(monthKey: string): string[] {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = Number(yearStr);
  const monthOneBased = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(monthOneBased)) return [];
  const cursor = new Date(year, monthOneBased - 1, 1);
  if (!Number.isFinite(cursor.getTime())) return [];
  const out: string[] = [];
  while (cursor.getMonth() === monthOneBased - 1) {
    out.push(dateKeyLocal(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function monthBoundsToIsoRange(monthKey: string): { fromIso: string; toIso: string } {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = Number(yearStr);
  const monthOneBased = Number(monthStr);
  const start = new Date(Date.UTC(year, monthOneBased - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthOneBased, 0, 23, 59, 59, 999));
  return {
    fromIso: start.toISOString(),
    toIso: end.toISOString(),
  };
}

function dateKeyFromIso(iso: string): string | null {
  if (typeof iso === 'string' && iso.length >= 10) {
    const candidate = iso.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;
  }
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return dateKeyLocal(d);
}

function isWithinPastDay(iso: string): boolean {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  const now = Date.now();
  return t <= now && t >= now - 24 * 60 * 60 * 1000;
}

async function loadCalendarRowsForMonth(monthKey: string): Promise<Array<{ aqi: number | null; pm25: number | null; time: string }>> {
  const { fromIso, toIso } = monthBoundsToIsoRange(monthKey);
  const monthly = await fetchDailySensorAqiCalendarRowsForMonth(fromIso, toIso);
  const monthlyRows = (monthly.data ?? []).filter((row): row is { aqi: number | null; pm25: number | null; time: string } =>
    typeof row.time === 'string' && row.time.length >= 10,
  );
  if (monthlyRows.length > 0) return monthlyRows;

  // Fallback for deployments where time-range filtering behaves differently than expected.
  const allRowsRes = await fetchDailySensorAqiCalendarRows();
  const allRows = (allRowsRes.data ?? []).filter((row): row is { aqi: number | null; pm25: number | null; time: string } =>
    typeof row.time === 'string' && row.time.length >= 10,
  );
  return allRows.filter((row) => row.time.slice(0, 7) === monthKey);
}

function formatMonthLabel(monthKey: string): string {
  const parsed = new Date(`${monthKey}-01T00:00:00`);
  if (!Number.isFinite(parsed.getTime())) return 'this month';
  return parsed.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

const styles = StyleSheet.create({
  calendarModalRoot: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  calendarModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15,23,42,0.35)',
  },
  calendarModalCard: {
    width: '100%',
    maxWidth: 620,
    maxHeight: '82%',
    borderRadius: 16,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#dbe5f2',
    padding: 16,
    zIndex: 2,
  },
  calendarModalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  calendarModalTitle: { fontSize: 20, fontWeight: '800', color: '#0f172a' },
  calendarModalHint: { fontSize: 12, color: '#64748b', marginBottom: 10 },
  calendarCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eff6ff',
  },
  calendarWrap: {
    position: 'relative',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#dbe5f2',
    backgroundColor: '#f8fafc',
    height: 380,
  },
  calendarLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(248,250,252,0.72)',
  },
  calendarNavArrow: {
    paddingHorizontal: 4,
  },
});
