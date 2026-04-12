import { supabase } from './supabase';

import type { ClarityRow, CurrentKrigingRow, PurpleAirRow } from './database.types';

export type FetchError = { message: string; details?: string };

/** Cap when selecting all sensors for one pipeline `time` (many rows). */
const SNAPSHOT_ROW_CAP = 50_000;

/**
 * PostgREST defaults to 1000 rows per request; paginate to load the full kriging grid (~10k+ cells).
 */
const KRIGING_PAGE_SIZE = 1000;
const KRIGING_FETCH_MAX = 50_000;

export type SensorTimeQuery = {
  /**
   * Exact match on the pipeline `time` column (ISO 8601).
   * Returns every sensor row recorded at that instant — use for “this run” or a known timestamp.
   */
  atRecordedTime?: string;
  /** Inclusive lower bound on `time` (ISO 8601). Ignored if `atRecordedTime` is set. */
  fromRecordedTime?: string;
  /** Inclusive upper bound on `time` (ISO 8601). Ignored if `atRecordedTime` is set. */
  toRecordedTime?: string;
  /**
   * Max rows when not using `atRecordedTime` (default 500).
   * For `atRecordedTime`, a high internal cap applies instead.
   */
  limit?: number;
};

function mapError(err: { message: string; details?: string; hint?: string }): FetchError {
  return {
    message: err.message,
    details: [err.details, err.hint].filter(Boolean).join(' — ') || undefined,
  };
}

function applySensorTimeFilters<T extends { gte: Function; lte: Function; eq: Function; order: Function; limit: Function }>(
  query: T,
  options: SensorTimeQuery | undefined,
): T {
  let q = query;
  if (options?.atRecordedTime) {
    q = q.eq('time', options.atRecordedTime);
  } else {
    if (options?.fromRecordedTime) q = q.gte('time', options.fromRecordedTime);
    if (options?.toRecordedTime) q = q.lte('time', options.toRecordedTime);
  }
  q = q.order('time', { ascending: false });
  if (options?.atRecordedTime) {
    q = q.limit(SNAPSHOT_ROW_CAP);
  } else {
    q = q.limit(options?.limit ?? 500);
  }
  return q;
}

export async function fetchPurpleAirReadings(
  options?: SensorTimeQuery,
): Promise<{ data: PurpleAirRow[] | null; error: FetchError | null }> {
  const base = supabase.from('purple_air').select('*');
  const { data, error } = await applySensorTimeFilters(base, options);

  if (error) {
    return { data: null, error: mapError(error) };
  }
  return { data: data as PurpleAirRow[], error: null };
}

export async function fetchClarityReadings(
  options?: SensorTimeQuery,
): Promise<{ data: ClarityRow[] | null; error: FetchError | null }> {
  const base = supabase.from('clarity').select('*');
  const { data, error } = await applySensorTimeFilters(base, options);

  if (error) {
    return { data: null, error: mapError(error) };
  }
  return { data: data as ClarityRow[], error: null };
}

/** Latest pipeline `time` value per table (may differ slightly if one source is empty or lagging). */
export async function getLatestRecordedTimes(): Promise<{
  purpleAir: string | null;
  clarity: string | null;
  error: FetchError | null;
}> {
  const [p, c] = await Promise.all([
    supabase.from('purple_air').select('time').order('time', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('clarity').select('time').order('time', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const err = p.error ?? c.error;
  if (err) {
    return { purpleAir: null, clarity: null, error: mapError(err) };
  }
  const pt = p.data as { time: string } | null;
  const ct = c.data as { time: string } | null;
  return {
    purpleAir: pt?.time ?? null,
    clarity: ct?.time ?? null,
    error: null,
  };
}

/**
 * All PurpleAir + Clarity rows for the same pipeline `time`.
 * Use when you already know the run timestamp (e.g. from a previous call or UI).
 */
export async function fetchSensorReadingsAtRecordedTime(recordedTime: string): Promise<{
  purpleAir: PurpleAirRow[] | null;
  clarity: ClarityRow[] | null;
  error: FetchError | null;
}> {
  const [purple, clarity] = await Promise.all([
    fetchPurpleAirReadings({ atRecordedTime: recordedTime }),
    fetchClarityReadings({ atRecordedTime: recordedTime }),
  ]);
  const err = purple.error ?? clarity.error;
  return {
    purpleAir: purple.data,
    clarity: clarity.data,
    error: err,
  };
}

/**
 * Latest snapshot per source: resolves the newest `time` in each table, then loads all rows for that time.
 * Prefer this for “current” sensor readings when each pipeline run stamps one shared `time`.
 */
export async function fetchCurrentSensorReadings(): Promise<{
  purpleAir: PurpleAirRow[] | null;
  clarity: ClarityRow[] | null;
  recordedTimes: { purpleAir: string | null; clarity: string | null };
  error: FetchError | null;
}> {
  const { purpleAir: tPurple, clarity: tClarity, error: tErr } = await getLatestRecordedTimes();
  if (tErr) {
    return { purpleAir: null, clarity: null, recordedTimes: { purpleAir: null, clarity: null }, error: tErr };
  }

  const [purple, clarity] = await Promise.all([
    tPurple ? fetchPurpleAirReadings({ atRecordedTime: tPurple }) : Promise.resolve({ data: [] as PurpleAirRow[], error: null }),
    tClarity ? fetchClarityReadings({ atRecordedTime: tClarity }) : Promise.resolve({ data: [] as ClarityRow[], error: null }),
  ]);

  const err = purple.error ?? clarity.error;
  return {
    purpleAir: purple.data,
    clarity: clarity.data,
    recordedTimes: { purpleAir: tPurple, clarity: tClarity },
    error: err,
  };
}

/** Latest interpolated grid snapshot (full table; typically replaced each pipeline run). */
export async function fetchCurrentKrigingGrid(): Promise<{
  data: CurrentKrigingRow[] | null;
  error: FetchError | null;
}> {
  const rows: CurrentKrigingRow[] = [];

  for (let offset = 0; offset < KRIGING_FETCH_MAX; offset += KRIGING_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('current_kriging')
      .select('*')
      .order('latitude', { ascending: true })
      .order('longitude', { ascending: true })
      .range(offset, offset + KRIGING_PAGE_SIZE - 1);

    if (error) {
      return { data: null, error: mapError(error) };
    }

    const batch = (data ?? []) as CurrentKrigingRow[];
    if (batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < KRIGING_PAGE_SIZE) break;
  }

  return { data: rows, error: null };
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Distinct pipeline `time` values in the window [now - hoursBack, now], from PurpleAir + Clarity.
 * Sorted ascending (oldest first). Used for timeline scrubbing.
 */
export async function fetchDistinctPipelineTimes(hoursBack: number): Promise<{
  times: string[];
  error: FetchError | null;
}> {
  const from = new Date(Date.now() - hoursBack * HOUR_MS).toISOString();
  const [p, c] = await Promise.all([
    supabase.from('purple_air').select('time').gte('time', from).order('time', { ascending: true }).limit(50_000),
    supabase.from('clarity').select('time').gte('time', from).order('time', { ascending: true }).limit(50_000),
  ]);
  const err = p.error ?? c.error;
  if (err) {
    return { times: [], error: mapError(err) };
  }
  const set = new Set<string>();
  for (const row of (p.data ?? []) as { time: string }[]) {
    if (row?.time) set.add(row.time);
  }
  for (const row of (c.data ?? []) as { time: string }[]) {
    if (row?.time) set.add(row.time);
  }
  const times = Array.from(set).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return { times, error: null };
}

/** Load all three sources in parallel. */
export async function fetchAllAirQuality(options?: { sensorLimit?: number }) {
  const limit = options?.sensorLimit ?? 500;
  const [purple, clarity, kriging] = await Promise.all([
    fetchPurpleAirReadings({ limit }),
    fetchClarityReadings({ limit }),
    fetchCurrentKrigingGrid(),
  ]);

  const err = purple.error ?? clarity.error ?? kriging.error;
  return {
    purpleAir: purple.data,
    clarity: clarity.data,
    kriging: kriging.data,
    error: err,
  };
}
