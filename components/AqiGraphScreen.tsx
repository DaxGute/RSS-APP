import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { aqiCategory } from '../lib/aqiUtils';
import { TimeRangeModule } from './TimeRangeModule';
import { TimelineCalendarModal } from './TimelineCalendarModal';

type AqiGraphScreenProps = {
  points: Array<{ time: string; avgAqi: number }>;
  timelineTimesAsc: string[];
  timelineIndex: number;
  selectedTimeIso: string | null;
  liveAverageAqi: number | null;
  loading: boolean;
  onSelectTime: (timeIso: string) => void;
  onSelectRecordedTime: (timeIso: string) => void;
};

function dateKeyLocal(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateButtonLabel(iso: string | null): string {
  if (!iso) return 'today';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'today';
  if (dateKeyLocal(date) === dateKeyLocal(new Date())) return 'today';
  const mm = `${date.getMonth() + 1}`.padStart(2, '0');
  const dd = `${date.getDate()}`.padStart(2, '0');
  const yy = `${date.getFullYear()}`.slice(-2);
  return `${mm}/${dd}/${yy}`;
}

export function AqiGraphScreen({
  points,
  timelineTimesAsc,
  timelineIndex,
  selectedTimeIso,
  liveAverageAqi,
  loading,
  onSelectTime,
  onSelectRecordedTime,
}: AqiGraphScreenProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const sortedPoints = useMemo(
    () =>
      points
        .filter((p) => Number.isFinite(p.avgAqi) && Number.isFinite(new Date(p.time).getTime()))
        .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()),
    [points],
  );

  const latestPoint = sortedPoints[sortedPoints.length - 1] ?? null;
  const selectedPoint =
    sortedPoints.find((p) => p.time === selectedTimeIso) ?? latestPoint;

  const summary = useMemo(() => {
    if (sortedPoints.length === 0) {
      return { avg: null as number | null, peak: null as { aqi: number; time: string } | null, above100: 0, above150: 0 };
    }
    let total = 0;
    let peak = sortedPoints[0];
    let above100 = 0;
    let above150 = 0;
    for (const p of sortedPoints) {
      total += p.avgAqi;
      if (p.avgAqi > peak.avgAqi) peak = p;
      if (p.avgAqi >= 100) above100 += 1;
      if (p.avgAqi >= 150) above150 += 1;
    }
    return {
      avg: total / sortedPoints.length,
      peak: { aqi: peak.avgAqi, time: peak.time },
      above100,
      above150,
    };
  }, [sortedPoints]);

  const hourlyAverages = useMemo(() => {
    const buckets = new Map<number, { total: number; count: number }>();
    for (const p of sortedPoints) {
      const hour = new Date(p.time).getHours();
      const curr = buckets.get(hour) ?? { total: 0, count: 0 };
      curr.total += p.avgAqi;
      curr.count += 1;
      buckets.set(hour, curr);
    }
    return Array.from({ length: 24 }, (_, hour) => {
      const entry = buckets.get(hour);
      const avg = entry && entry.count > 0 ? entry.total / entry.count : null;
      return { hour, avg };
    });
  }, [sortedPoints]);

  const hourlyMax = useMemo(
    () =>
      Math.max(
        50,
        ...hourlyAverages.map((h) => h.avg ?? 0),
      ),
    [hourlyAverages],
  );

  const heatmap = useMemo(() => {
    const grid: Array<Array<number | null>> = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => null),
    );
    const bucket = new Map<string, { total: number; count: number }>();
    for (const p of sortedPoints) {
      const d = new Date(p.time);
      const dow = d.getDay();
      const hour = d.getHours();
      const key = `${dow}-${hour}`;
      const curr = bucket.get(key) ?? { total: 0, count: 0 };
      curr.total += p.avgAqi;
      curr.count += 1;
      bucket.set(key, curr);
    }
    for (let dow = 0; dow < 7; dow += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const entry = bucket.get(`${dow}-${hour}`);
        grid[dow][hour] = entry && entry.count > 0 ? entry.total / entry.count : null;
      }
    }
    return grid;
  }, [sortedPoints]);

  const notableEvents = useMemo(
    () =>
      sortedPoints
        .filter((p) => p.avgAqi >= 100)
        .sort((a, b) => b.avgAqi - a.avgAqi)
        .slice(0, 5),
    [sortedPoints],
  );

  const topHours = useMemo(
    () =>
      hourlyAverages
        .filter((h) => h.avg != null)
        .sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0))
        .slice(0, 3),
    [hourlyAverages],
  );

  const selectedCategory = selectedPoint ? aqiCategory(selectedPoint.avgAqi) : null;
  const selectedDateButtonLabel = useMemo(() => formatDateButtonLabel(selectedTimeIso), [selectedTimeIso]);
  const timeRangePoints = useMemo(() => {
    if (sortedPoints.length === 0) return [];
    if (sortedPoints.length === 1) {
      const only = sortedPoints[0];
      return [{ ...only, position: 1, selectableTime: only.time }];
    }
    const denom = sortedPoints.length - 1;
    return sortedPoints.map((p, index) => ({
      ...p,
      position: index / denom,
      selectableTime: p.time,
    }));
  }, [sortedPoints]);

  const selectedDateFacts = useMemo(() => {
    if (!selectedTimeIso) {
      return { count: 0, avg: null as number | null, peak: null as { aqi: number; time: string } | null, above100: 0 };
    }
    const dayKey = dateKeyLocal(new Date(selectedTimeIso));
    const dayPoints = sortedPoints.filter((p) => dateKeyLocal(new Date(p.time)) === dayKey);
    if (dayPoints.length === 0) {
      return { count: 0, avg: null as number | null, peak: null as { aqi: number; time: string } | null, above100: 0 };
    }
    let total = 0;
    let peak = dayPoints[0];
    let above100 = 0;
    for (const p of dayPoints) {
      total += p.avgAqi;
      if (p.avgAqi > peak.avgAqi) peak = p;
      if (p.avgAqi >= 100) above100 += 1;
    }
    return {
      count: dayPoints.length,
      avg: total / dayPoints.length,
      peak: { aqi: peak.avgAqi, time: peak.time },
      above100,
    };
  }, [selectedTimeIso, sortedPoints]);

  return (
    <View style={styles.screenRoot}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>AQI Dashboard</Text>
        <Text style={styles.subtitle}>Ported graph modules using your live pipeline data</Text>
        <View style={styles.calendarRow}>
          {loading ? <Text style={styles.loadingText}>Loading...</Text> : null}
          <Pressable
            onPress={() => setCalendarOpen(true)}
            style={({ pressed }) => [styles.calendarButton, pressed && styles.calendarButtonPressed]}
            accessibilityRole="button"
            accessibilityLabel="Open AQI date calendar"
          >
            <Ionicons name="calendar-outline" size={18} color="#1f2937" />
            <Text style={styles.calendarButtonText}>{selectedDateButtonLabel}</Text>
          </Pressable>
        </View>

        <View style={styles.chartCard}>
          <Text style={styles.sectionTitle}>Daily AQI timeline</Text>
          <Text style={styles.sectionSub}>Avg AQI across sensors (10 min cadence)</Text>
          <TimeRangeModule
            points={timeRangePoints}
            active
            loading={loading}
            selectedTimeIso={selectedTimeIso}
            onPreviewTime={onSelectTime}
            onCommitTime={onSelectTime}
            graphOnly
          />
        </View>

        <View style={styles.statsRow}>
          <StatCard label="Current AQI" value={selectedPoint ? `${Math.round(selectedPoint.avgAqi)}` : '--'} />
          <StatCard label="24h Avg AQI" value={summary.avg != null ? `${Math.round(summary.avg)}` : '--'} />
        </View>
        <View style={styles.statsRow}>
          <StatCard label="Readings >=100" value={`${summary.above100}`} />
          <StatCard label="Readings >=150" value={`${summary.above150}`} />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Selected date facts</Text>
          {selectedDateFacts.count === 0 ? (
            <Text style={styles.emptyText}>No data for this date in current graph window.</Text>
          ) : (
            <>
              <Text style={styles.eventText}>Readings: {selectedDateFacts.count}</Text>
              <Text style={styles.eventText}>Average AQI: {Math.round(selectedDateFacts.avg ?? 0)}</Text>
              <Text style={styles.eventText}>Readings above 100: {selectedDateFacts.above100}</Text>
              <Text style={styles.eventText}>
                Peak AQI: {selectedDateFacts.peak ? `${Math.round(selectedDateFacts.peak.aqi)} at ${new Date(selectedDateFacts.peak.time).toLocaleTimeString()}` : 'No data'}
              </Text>
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Average AQI by hour of day</Text>
          <View style={styles.hourlyChart}>
            {hourlyAverages.map((entry) => {
              const barH = entry.avg == null ? 2 : Math.max(4, (entry.avg / hourlyMax) * 88);
              return (
                <View key={`h-${entry.hour}`} style={styles.hourBarWrap}>
                  <View
                    style={[
                      styles.hourBar,
                      {
                        height: barH,
                        backgroundColor: entry.avg == null ? '#cbd5e1' : aqiCategory(entry.avg).bg,
                      },
                    ]}
                  />
                  {entry.hour % 6 === 0 ? (
                    <Text style={styles.hourLabel}>{entry.hour === 0 ? '12a' : entry.hour === 12 ? '12p' : entry.hour < 12 ? `${entry.hour}a` : `${entry.hour - 12}p`}</Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>AQI by day of week and hour</Text>
          <Text style={styles.sectionSub}>Heatmap-style view from available rolling data</Text>
          <View style={styles.heatmap}>
            {heatmap.map((row, dow) => (
              <View key={`dow-${dow}`} style={styles.heatmapRow}>
                <Text style={styles.heatmapYLabel}>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow]}</Text>
                <View style={styles.heatmapCells}>
                  {row.map((value, hour) => (
                    <View
                      key={`cell-${dow}-${hour}`}
                      style={[
                        styles.heatCell,
                        { backgroundColor: value == null ? '#e2e8f0' : aqiCategory(value).bg },
                      ]}
                    />
                  ))}
                </View>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Notable pollution events</Text>
          {notableEvents.length === 0 ? (
            <Text style={styles.emptyText}>No readings above AQI 100 in this data window.</Text>
          ) : (
            notableEvents.map((event) => (
              <Text key={event.time} style={styles.eventText}>
                {new Date(event.time).toLocaleString()}: AQI {Math.round(event.avgAqi)}
              </Text>
            ))
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Advocacy snapshot</Text>
          <Text style={styles.eventText}>
            Peak reading: {summary.peak ? `AQI ${Math.round(summary.peak.aqi)} at ${new Date(summary.peak.time).toLocaleTimeString()}` : 'No data'}
          </Text>
          <Text style={styles.eventText}>
            Highest average hours: {topHours.length > 0 ? topHours.map((h) => `${h.hour}:00 (${Math.round(h.avg ?? 0)})`).join(', ') : 'No data'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Health impact</Text>
          <Text style={styles.sectionSub}>
            Current status: {selectedCategory ? `${selectedCategory.label} (AQI ${Math.round(selectedPoint?.avgAqi ?? 0)})` : 'No data'}
          </Text>
          <Text style={styles.healthText}>{healthGuidanceForAqi(selectedPoint?.avgAqi ?? null)}</Text>
        </View>
      </ScrollView>
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

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function healthGuidanceForAqi(aqi: number | null): string {
  if (aqi == null) return 'No AQI data available yet.';
  if (aqi <= 50) return 'Good: outdoor activity is generally safe for everyone.';
  if (aqi <= 100) return 'Moderate: unusually sensitive people should monitor symptoms.';
  if (aqi <= 150) return 'Unhealthy for sensitive groups: reduce prolonged outdoor exertion.';
  if (aqi <= 200) return 'Unhealthy: everyone should limit outdoor time and consider masking.';
  if (aqi <= 300) return 'Very unhealthy: stay indoors when possible and run HEPA filtration.';
  return 'Hazardous: avoid outdoor exposure and treat as an air-quality emergency.';
}

const styles = StyleSheet.create({
  screenRoot: {
    flex: 1,
    backgroundColor: '#e8f0fe',
  },
  content: {
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 110,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0f172a',
    paddingHorizontal: 16,
  },
  subtitle: {
    marginTop: 4,
    marginBottom: 12,
    fontSize: 13,
    color: '#475569',
    fontWeight: '600',
  },
  calendarRow: {
    marginBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '700',
  },
  calendarButton: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  calendarButtonPressed: {
    opacity: 0.88,
  },
  calendarButtonText: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.2,
    color: '#334155',
  },
  chartCard: {
    width: '100%',
    padding: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.93)',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 4,
  },
  sectionSub: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
    marginBottom: 8,
  },
  statsRow: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 10,
  },
  statCard: {
    flex: 1,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    padding: 10,
  },
  statValue: {
    fontSize: 24,
    fontWeight: '900',
    color: '#0f172a',
  },
  statLabel: {
    marginTop: 2,
    fontSize: 12,
    color: '#64748b',
    fontWeight: '700',
  },
  card: {
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    padding: 10,
  },
  hourlyChart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    height: 106,
  },
  hourBarWrap: {
    width: 10,
    alignItems: 'center',
    justifyContent: 'flex-end',
    height: '100%',
  },
  hourBar: {
    width: 8,
    borderRadius: 4,
  },
  hourLabel: {
    marginTop: 4,
    fontSize: 9,
    color: '#64748b',
    fontWeight: '700',
  },
  heatmap: {
    gap: 4,
  },
  heatmapRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  heatmapYLabel: {
    width: 28,
    fontSize: 9,
    color: '#475569',
    fontWeight: '700',
  },
  heatmapCells: {
    flex: 1,
    flexDirection: 'row',
    gap: 2,
  },
  heatCell: {
    flex: 1,
    height: 10,
    borderRadius: 2,
  },
  emptyText: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '600',
  },
  eventText: {
    fontSize: 13,
    color: '#334155',
    fontWeight: '600',
    marginBottom: 4,
  },
  healthText: {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '600',
  },
});
