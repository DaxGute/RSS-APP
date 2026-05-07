import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { POLL_INTERVAL_MS } from '../lib/constants/ssf';
import type { ClarityRow, CurrentKrigingRow, DailySensorAqiRow, PurpleAirRow } from '../lib/database.types';
import { pm25ToAqi } from '../lib/aqiUtils';
import {
  fetchDistinctPipelineTimes,
  fetchDailySensorAqiAtRecordedTime,
  fetchDailySensorAqiBetweenRecordedTimes,
  fetchSensorReadingsBetweenRecordedTimes,
  fetchSensorReadingsAtRecordedTime,
  type FetchError,
} from '../lib/fetchAirQuality';
import { recomputeKrigingFromSensors } from '../lib/recomputeKriging';
import type { SensorPoint } from '../lib/sensorTypes';

export type { SensorPoint, SensorSource } from '../lib/sensorTypes';

const TIMELINE_HOURS_BACK = 24;
const HISTORICAL_KRIGING_GRID_STEPS = 20;
const HISTORICAL_KRIGING_NEIGHBORS = 4;

export type SsfAirQualityState = {
  purpleAir: PurpleAirRow[];
  clarity: ClarityRow[];
  kriging: CurrentKrigingRow[];
  sensors: SensorPoint[];
  loading: boolean;
  /** Initial live load progress [0..1] for sensor + kriging bootstrap. */
  initialLoadProgress: number;
  error: FetchError | null;
  /** Oldest → newest pipeline `time` values for the timeline scrubber. */
  timelineTimesAsc: string[];
  timelineIndex: number;
  setTimelineIndex: (index: number) => void;
  selectRecordedTime: (recordedTime: string) => void;
  /** True when the scrubber is at the newest snapshot (uses live-polled data). */
  viewingLive: boolean;
  /** Loading a historical snapshot from Supabase (scrubber not at live end). */
  timelineLoading: boolean;
  insufficientData: boolean;
  liveAverageAqi: number | null;
  averageAqiTimeseries: Array<{ time: string; avgAqi: number }>;
};

function toSensorPoints(
  purple: PurpleAirRow[] | null,
  clarity: ClarityRow[] | null,
): SensorPoint[] {
  const out: SensorPoint[] = [];
  for (const r of purple ?? []) {
    if (r.pm25 == null || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
    out.push({
      sensorIndex: r.sensor_index,
      name: r.name ?? null,
      latitude: r.latitude,
      longitude: r.longitude,
      pm25: r.pm25,
      source: 'purple_air',
      time: r.time,
    });
  }
  for (const r of clarity ?? []) {
    if (r.pm25 == null || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
    out.push({
      sensorIndex: r.sensor_index,
      name: r.name ?? null,
      latitude: r.latitude,
      longitude: r.longitude,
      pm25: r.pm25,
      source: 'clarity',
      time: r.time,
    });
  }
  return out;
}

function toDailySensorPoints(rows: DailySensorAqiRow[] | null): SensorPoint[] {
  const out: SensorPoint[] = [];
  for (const r of rows ?? []) {
    if (r.pm25 == null || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
    out.push({
      sensorIndex: r.sensor_index,
      name: r.name ?? null,
      latitude: r.latitude,
      longitude: r.longitude,
      pm25: r.pm25,
      source: r.source ?? 'daily_sensor_aqi',
      time: r.time,
    });
  }
  return out;
}

function groupDailyRowsByTime(rows: DailySensorAqiRow[]): Map<string, DailySensorAqiRow[]> {
  const grouped = new Map<string, DailySensorAqiRow[]>();
  for (const row of rows) {
    const t = row.time;
    if (!t) continue;
    const curr = grouped.get(t);
    if (curr) curr.push(row);
    else grouped.set(t, [row]);
  }
  return grouped;
}

function groupSensorsByRecordedTime(
  purple: PurpleAirRow[] | null,
  clarity: ClarityRow[] | null,
): Map<string, SensorPoint[]> {
  const grouped = new Map<string, SensorPoint[]>();
  const append = (rows: SensorPoint[]) => {
    for (const row of rows) {
      if (!row.time) continue;
      const existing = grouped.get(row.time);
      if (existing) existing.push(row);
      else grouped.set(row.time, [row]);
    }
  };
  append(toSensorPoints(purple, null));
  append(toSensorPoints(null, clarity));
  return grouped;
}

function mergeTimesAsc(prev: string[], additions: readonly string[]): string[] {
  const s = new Set(prev);
  for (const a of additions) {
    if (a) s.add(a);
  }
  return Array.from(s).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
}

function buildAverageAqiTimeseries(
  purple: PurpleAirRow[] | null,
  clarity: ClarityRow[] | null,
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
  for (const row of purple ?? []) addRow(row.time, row.pm25);
  for (const row of clarity ?? []) addRow(row.time, row.pm25);
  return Array.from(sums.entries())
    .map(([time, v]) => ({ time, avgAqi: v.count > 0 ? v.total / v.count : 0 }))
    .filter((r) => Number.isFinite(new Date(r.time).getTime()))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}

function trimTimesToRollingDay(timesAsc: string[], preserveIso?: string | null): string[] {
  const now = Date.now();
  const floor = now - TIMELINE_HOURS_BACK * 60 * 60 * 1000;
  const trimmed = timesAsc.filter((iso) => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= floor && t <= now;
  });
  if (preserveIso && timesAsc.includes(preserveIso) && !trimmed.includes(preserveIso)) {
    return mergeTimesAsc(trimmed, [preserveIso]);
  }
  return trimmed;
}

type HistoricalSnapshot = { sensors: SensorPoint[]; kriging: CurrentKrigingRow[]; insufficientData: boolean };

export function useSsfAirQuality(): SsfAirQualityState & { refresh: () => Promise<void> } {
  const [purpleAir, setPurpleAir] = useState<PurpleAirRow[]>([]);
  const [clarity, setClarity] = useState<ClarityRow[]>([]);
  const [kriging, setKriging] = useState<CurrentKrigingRow[]>([]);
  const [sensors, setSensors] = useState<SensorPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialLoadProgress, setInitialLoadProgress] = useState(0);
  const [error, setError] = useState<FetchError | null>(null);

  const [timelineTimesAsc, setTimelineTimesAsc] = useState<string[]>([]);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [historicalDisplay, setHistoricalDisplay] = useState<HistoricalSnapshot | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [insufficientData, setInsufficientData] = useState(false);

  const historicalCacheRef = useRef<Map<string, HistoricalSnapshot>>(new Map());
  const latestKrigingRef = useRef<CurrentKrigingRow[]>([]);
  const timelineInitRef = useRef(false);
  const pinnedHistoricalTimeRef = useRef<string | null>(null);
  const mounted = useRef(true);

  const recomputeHistoricalKriging = useCallback((sensorRows: SensorPoint[], recordedTime: string) => {
    if (sensorRows.length === 0) return [];
    return recomputeKrigingFromSensors(sensorRows, recordedTime, {
      latSteps: HISTORICAL_KRIGING_GRID_STEPS,
      lonSteps: HISTORICAL_KRIGING_GRID_STEPS,
      maxNeighbors: HISTORICAL_KRIGING_NEIGHBORS,
    });
  }, []);

  useEffect(() => {
    latestKrigingRef.current = kriging;
  }, [kriging]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const { times, error: tErr } = await fetchDistinctPipelineTimes(TIMELINE_HOURS_BACK);
      if (!mounted.current || tErr) return;
      setTimelineTimesAsc((prev) => {
        const merged = trimTimesToRollingDay(mergeTimesAsc(prev, times), pinnedHistoricalTimeRef.current);
        if (!timelineInitRef.current && merged.length > 0) {
          timelineInitRef.current = true;
          setTimelineIndex(merged.length - 1);
        }
        return merged;
      });
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const now = new Date();
      const fromIso = new Date(now.getTime() - TIMELINE_HOURS_BACK * 60 * 60 * 1000).toISOString();
      const toIso = now.toISOString();
      const dayRes = await fetchDailySensorAqiBetweenRecordedTimes(fromIso, toIso);
      if (cancelled || !mounted.current || dayRes.error || !dayRes.data || dayRes.data.length === 0) return;

      const byTime = groupDailyRowsByTime(dayRes.data);
      const times = Array.from(byTime.keys()).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
      for (const t of times) {
        const rows = byTime.get(t) ?? [];
        const sensorRows = toDailySensorPoints(rows);
        if (sensorRows.length === 0) continue;
        const snapshot: HistoricalSnapshot = {
          sensors: sensorRows,
          kriging: recomputeHistoricalKriging(sensorRows, t),
          insufficientData: false,
        };
        historicalCacheRef.current.set(t, snapshot);
      }

      setTimelineTimesAsc((prev) => {
        const merged = trimTimesToRollingDay(mergeTimesAsc(prev, times), pinnedHistoricalTimeRef.current);
        if (!timelineInitRef.current && merged.length > 0) {
          timelineInitRef.current = true;
          setTimelineIndex(merged.length - 1);
        }
        return merged;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSensors = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInitialLoadProgress(0.05);
    try {
      const now = new Date();
      const fromIso = new Date(now.getTime() - TIMELINE_HOURS_BACK * 60 * 60 * 1000).toISOString();
      const toIso = now.toISOString();
      const sensorsRes = await fetchSensorReadingsBetweenRecordedTimes(fromIso, toIso);
      if (!mounted.current) return;
      setInitialLoadProgress(0.9);

      const pa = sensorsRes.purpleAir ?? [];
      const cl = sensorsRes.clarity ?? [];
      const sensorsErr = sensorsRes.error;
      let liveKriging: CurrentKrigingRow[] = [];

      // Preserve whichever feed succeeds so the map can still render partially.
      if (!sensorsErr || pa.length > 0 || cl.length > 0) {
        const groupedByTime = groupSensorsByRecordedTime(pa, cl);
        const times = Array.from(groupedByTime.keys()).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
        const latestTime = times[times.length - 1] ?? null;
        const sensorPoints = latestTime ? (groupedByTime.get(latestTime) ?? []) : [];
        // Keep live and historical snapshots on the same kriging pipeline.
        liveKriging = recomputeHistoricalKriging(sensorPoints, latestTime ?? new Date().toISOString());
        setError(sensorsErr ?? null);
        setPurpleAir(pa);
        setClarity(cl);
        setSensors(sensorPoints);
        setKriging(liveKriging);
        for (const t of times) {
          const rows = groupedByTime.get(t) ?? [];
          if (rows.length === 0) continue;
          const snapshot: HistoricalSnapshot = {
            sensors: rows,
            kriging: recomputeHistoricalKriging(rows, t),
            insufficientData: false,
          };
          historicalCacheRef.current.set(t, snapshot);
        }
        setTimelineTimesAsc((prev) => {
          const merged = trimTimesToRollingDay(mergeTimesAsc(prev, times), pinnedHistoricalTimeRef.current);
          if (merged.length > 0) timelineInitRef.current = true;
          setTimelineIndex((idx) => {
            if (merged.length === 0) return 0;
            if (prev.length === 0) return merged.length - 1;
            if (idx === prev.length - 1) return merged.length - 1;
            return Math.min(idx, merged.length - 1);
          });
          return merged;
        });
      } else {
        setError(sensorsErr ?? null);
        setPurpleAir([]);
        setClarity([]);
        setSensors([]);
        setKriging([]);
      }
      setInitialLoadProgress(1);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const viewingLive = useMemo(
    () => timelineTimesAsc.length > 0 && timelineIndex === timelineTimesAsc.length - 1,
    [timelineIndex, timelineTimesAsc],
  );

  useEffect(() => {
    if (!viewingLive) return;
    pinnedHistoricalTimeRef.current = null;
  }, [viewingLive]);

  const selectRecordedTime = useCallback((recordedTime: string) => {
    pinnedHistoricalTimeRef.current = recordedTime;
    setTimelineTimesAsc((prev) => {
      const merged = trimTimesToRollingDay(mergeTimesAsc(prev, [recordedTime]), recordedTime);
      const idx = merged.findIndex((t) => t === recordedTime);
      if (idx >= 0) setTimelineIndex(idx);
      return merged;
    });
  }, []);

  useEffect(() => {
    if (timelineTimesAsc.length === 0) return;
    const liveEnd = timelineTimesAsc.length - 1;
    if (timelineIndex === liveEnd) {
      setHistoricalDisplay(null);
      setTimelineLoading(false);
      setInsufficientData(false);
      return;
    }

    const t = timelineTimesAsc[timelineIndex];
    const cached = historicalCacheRef.current.get(t);
    if (cached) {
      // Recompute on each selection so switching away from live always refreshes
      // historical kriging with the configured 20x20 surface.
      const recomputed = recomputeHistoricalKriging(cached.sensors, t);
      const refreshed: HistoricalSnapshot = {
        sensors: cached.sensors,
        kriging: recomputed.length > 0 ? recomputed : cached.kriging,
        insufficientData: cached.insufficientData,
      };
      setHistoricalDisplay(refreshed);
      setInsufficientData(refreshed.insufficientData);
      setTimelineLoading(false);
      return;
    }

    let cancelled = false;
    setHistoricalDisplay(null);
    setTimelineLoading(true);
    setInsufficientData(false);
    void (async () => {
      const [dailyRes, sRes] = await Promise.all([
        fetchDailySensorAqiAtRecordedTime(t),
        fetchSensorReadingsAtRecordedTime(t),
      ]);
      if (cancelled || !mounted.current) return;
      const dailySensors = toDailySensorPoints(dailyRes.data);
      const sensorRows = dailySensors.length > 0 ? dailySensors : toSensorPoints(sRes.purpleAir, sRes.clarity);
      const recomputed = recomputeHistoricalKriging(sensorRows, t);
      const krigingRows = recomputed.length > 0 ? recomputed : latestKrigingRef.current;
      // A single sensor datapoint is enough to consider the timestamp usable.
      // Kriging may be missing for sparse historical slots, but the snapshot is still informative.
      const isInsufficient = sensorRows.length === 0;
      if (sRes.error) {
        setError((prev) => prev ?? sRes.error ?? null);
      }
      const snapshot: HistoricalSnapshot = {
        sensors: sensorRows,
        kriging: krigingRows,
        insufficientData: isInsufficient,
      };
      if (isInsufficient) {
        // Keep rendering the date's sensor points when available, but show a center warning.
        setHistoricalDisplay(snapshot);
        setInsufficientData(true);
        setTimelineLoading(false);
        return;
      }
      historicalCacheRef.current.set(t, snapshot);
      setHistoricalDisplay(snapshot);
      setInsufficientData(false);
      setTimelineLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [recomputeHistoricalKriging, timelineIndex, timelineTimesAsc]);

  const displaySensors = viewingLive ? sensors : (historicalDisplay?.sensors ?? []);
  const displayKriging = viewingLive ? kriging : (historicalDisplay?.kriging ?? []);
  const liveAverageAqi = useMemo(() => {
    if (sensors.length === 0) return null;
    const avgPm = sensors.reduce((acc, s) => acc + s.pm25, 0) / sensors.length;
    if (!Number.isFinite(avgPm)) return null;
    const c = Math.floor(avgPm * 10) / 10;
    const bps: [number, number, number, number][] = [
      [0.0, 12.0, 0, 50],
      [12.1, 35.4, 51, 100],
      [35.5, 55.4, 101, 150],
      [55.5, 150.4, 151, 200],
      [150.5, 250.4, 201, 300],
      [250.5, 350.4, 301, 400],
      [350.5, 500.4, 401, 500],
    ];
    for (const [cLo, cHi, iLo, iHi] of bps) {
      if (c >= cLo && c <= cHi) {
        return Math.round(((iHi - iLo) / (cHi - cLo)) * (c - cLo) + iLo);
      }
    }
    if (c > 500.4) return 500;
    return null;
  }, [sensors]);
  const averageAqiTimeseries = useMemo(
    () => buildAverageAqiTimeseries(purpleAir, clarity),
    [clarity, purpleAir],
  );

  useEffect(() => {
    // Bootstrap the app with full latest sensor snapshots first.
    void loadSensors();
    const sensorTimer = setInterval(() => void loadSensors(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(sensorTimer);
    };
  }, [loadSensors]);

  return {
    purpleAir,
    clarity,
    kriging: displayKriging,
    sensors: displaySensors,
    loading,
    initialLoadProgress,
    error,
    timelineTimesAsc,
    timelineIndex,
    setTimelineIndex,
    selectRecordedTime,
    viewingLive,
    timelineLoading,
    insufficientData,
    liveAverageAqi,
    averageAqiTimeseries,
    refresh: loadSensors,
  };
}
