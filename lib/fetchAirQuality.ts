import { ROLLING_24H_TIME_WINDOW_BUFFER_MS } from './constants/ssf';
import { supabase } from './supabase';

import type { ClarityRow, CurrentKrigingRow, DailySensorAqiRow, PurpleAirRow } from './database.types';

export type FetchError = { message: string; details?: string };

/**
 * PostgREST `max-rows` default on Supabase is 1000. If you request a larger
 * `.range()`, the server still returns at most this many rows — so comparing
 * `batch.length` to a bigger "page size" stops pagination after the first batch.
 */
const POSTGREST_MAX_ROWS_PER_REQUEST = 1000;

/** Cap when selecting all sensors for one pipeline `time` (many rows). */
const SNAPSHOT_ROW_CAP = 50_000;

/**
 * Paginated range reads load every row in `[from, to]` until a short page; this
 * ceiling only guards pathological tables (memory / request storms).
 */
const SENSOR_RANGE_HARD_MAX = 2_000_000;

/**
 * Must stay at or below PostgREST `max-rows` for the project (Supabase default 1000).
 */
const SENSOR_RANGE_PAGE_SIZE = POSTGREST_MAX_ROWS_PER_REQUEST;

/** Scanning `time` (+ tie-breaker) for distinct pipeline stamps. */
const PIPELINE_TIME_PAGE_SIZE = POSTGREST_MAX_ROWS_PER_REQUEST;
const PIPELINE_TIME_SCAN_HARD_MAX = 2_000_000;

/**
 * PostgREST defaults to 1000 rows per request; paginate to load the full kriging grid (~10k+ cells).
 */
const KRIGING_RANGE_PAGE = POSTGREST_MAX_ROWS_PER_REQUEST;
const KRIGING_MAX_TOTAL_ROWS = 1_000_000;
const SENSOR_COLUMNS = 'sensor_index,name,latitude,longitude,pm25,time';
// Map DB `variance` -> app field `kriging_variance`.
const KRIGING_COLUMNS = 'latitude,longitude,pm25,aqi,kriging_variance:variance,time';
const DAILY_SENSOR_AQI_COLUMNS =
  'source,sensor_index,name,latitude,longitude,pm25,aqi,time,reading_count';

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
    q = q.order('sensor_index', { ascending: true });
  } else {
    if (options?.fromRecordedTime) q = q.gte('time', options.fromRecordedTime);
    if (options?.toRecordedTime) q = q.lte('time', options.toRecordedTime);
    q = q.order('time', { ascending: false });
  }
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
  const base = supabase.from('purple_air').select(SENSOR_COLUMNS);
  const { data, error } = await applySensorTimeFilters(base, options);

  if (error) {
    return { data: null, error: mapError(error) };
  }
  return { data: data as PurpleAirRow[], error: null };
}

export async function fetchClarityReadings(
  options?: SensorTimeQuery,
): Promise<{ data: ClarityRow[] | null; error: FetchError | null }> {
  const base = supabase.from('clarity').select(SENSOR_COLUMNS);
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

async function fetchPurpleAirReadingsBetweenPaginated(
  fromRecordedTime: string,
  toRecordedTime: string,
): Promise<{ data: PurpleAirRow[] | null; error: FetchError | null }> {
  const rows: PurpleAirRow[] = [];
  let offset = 0;
  while (rows.length < SENSOR_RANGE_HARD_MAX) {
    const end = offset + SENSOR_RANGE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('purple_air')
      .select(SENSOR_COLUMNS)
      .gte('time', fromRecordedTime)
      .lte('time', toRecordedTime)
      .order('time', { ascending: true })
      .order('sensor_index', { ascending: true })
      .range(offset, end);
    if (error) {
      return { data: null, error: mapError(error) };
    }
    const batch = (data ?? []) as PurpleAirRow[];
    if (batch.length === 0) break;
    for (const r of batch) {
      rows.push(r);
      if (rows.length >= SENSOR_RANGE_HARD_MAX) break;
    }
    if (rows.length >= SENSOR_RANGE_HARD_MAX) break;
    offset += batch.length;
    if (batch.length < SENSOR_RANGE_PAGE_SIZE) break;
  }
  return { data: rows, error: null };
}

async function fetchClarityReadingsBetweenPaginated(
  fromRecordedTime: string,
  toRecordedTime: string,
): Promise<{ data: ClarityRow[] | null; error: FetchError | null }> {
  const rows: ClarityRow[] = [];
  let offset = 0;
  while (rows.length < SENSOR_RANGE_HARD_MAX) {
    const end = offset + SENSOR_RANGE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('clarity')
      .select(SENSOR_COLUMNS)
      .gte('time', fromRecordedTime)
      .lte('time', toRecordedTime)
      .order('time', { ascending: true })
      .order('sensor_index', { ascending: true })
      .range(offset, end);
    if (error) {
      return { data: null, error: mapError(error) };
    }
    const batch = (data ?? []) as ClarityRow[];
    if (batch.length === 0) break;
    for (const r of batch) {
      rows.push(r);
      if (rows.length >= SENSOR_RANGE_HARD_MAX) break;
    }
    if (rows.length >= SENSOR_RANGE_HARD_MAX) break;
    offset += batch.length;
    if (batch.length < SENSOR_RANGE_PAGE_SIZE) break;
  }
  return { data: rows, error: null };
}

async function fetchPurpleAirAtRecordedTimePaginated(
  recordedTime: string,
): Promise<{ data: PurpleAirRow[] | null; error: FetchError | null }> {
  const rows: PurpleAirRow[] = [];
  let offset = 0;
  while (rows.length < SNAPSHOT_ROW_CAP) {
    const end = offset + SENSOR_RANGE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('purple_air')
      .select(SENSOR_COLUMNS)
      .eq('time', recordedTime)
      .order('sensor_index', { ascending: true })
      .range(offset, end);
    if (error) {
      return { data: null, error: mapError(error) };
    }
    const batch = (data ?? []) as PurpleAirRow[];
    if (batch.length === 0) break;
    for (const r of batch) {
      rows.push(r);
      if (rows.length >= SNAPSHOT_ROW_CAP) break;
    }
    if (rows.length >= SNAPSHOT_ROW_CAP) break;
    offset += batch.length;
    if (batch.length < SENSOR_RANGE_PAGE_SIZE) break;
  }
  return { data: rows, error: null };
}

async function fetchClarityAtRecordedTimePaginated(
  recordedTime: string,
): Promise<{ data: ClarityRow[] | null; error: FetchError | null }> {
  const rows: ClarityRow[] = [];
  let offset = 0;
  while (rows.length < SNAPSHOT_ROW_CAP) {
    const end = offset + SENSOR_RANGE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('clarity')
      .select(SENSOR_COLUMNS)
      .eq('time', recordedTime)
      .order('sensor_index', { ascending: true })
      .range(offset, end);
    if (error) {
      return { data: null, error: mapError(error) };
    }
    const batch = (data ?? []) as ClarityRow[];
    if (batch.length === 0) break;
    for (const r of batch) {
      rows.push(r);
      if (rows.length >= SNAPSHOT_ROW_CAP) break;
    }
    if (rows.length >= SNAPSHOT_ROW_CAP) break;
    offset += batch.length;
    if (batch.length < SENSOR_RANGE_PAGE_SIZE) break;
  }
  return { data: rows, error: null };
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
    fetchPurpleAirAtRecordedTimePaginated(recordedTime),
    fetchClarityAtRecordedTimePaginated(recordedTime),
  ]);
  const err = purple.error ?? clarity.error;
  return {
    purpleAir: purple.data,
    clarity: clarity.data,
    error: err,
  };
}

/**
 * All PurpleAir + Clarity rows in an inclusive recorded-time range.
 * Use for day-level summaries (e.g., calendar heat cells).
 */
export async function fetchSensorReadingsBetweenRecordedTimes(
  fromRecordedTime: string,
  toRecordedTime: string,
): Promise<{
  purpleAir: PurpleAirRow[] | null;
  clarity: ClarityRow[] | null;
  error: FetchError | null;
}> {
  const [purple, clarity] = await Promise.all([
    fetchPurpleAirReadingsBetweenPaginated(fromRecordedTime, toRecordedTime),
    fetchClarityReadingsBetweenPaginated(fromRecordedTime, toRecordedTime),
  ]);
  const err = purple.error ?? clarity.error;
  return {
    purpleAir: purple.data,
    clarity: clarity.data,
    error: err,
  };
}

export async function fetchDailySensorAqiBetweenRecordedTimes(
  fromRecordedTime: string,
  toRecordedTime: string,
): Promise<{
  data: DailySensorAqiRow[] | null;
  error: FetchError | null;
}> {
  const rows: DailySensorAqiRow[] = [];
  let offset = 0;
  while (rows.length < SENSOR_RANGE_HARD_MAX) {
    const end = offset + SENSOR_RANGE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('daily_sensor_aqi')
      .select(DAILY_SENSOR_AQI_COLUMNS)
      .gte('time', fromRecordedTime)
      .lte('time', toRecordedTime)
      .order('time', { ascending: true })
      .order('sensor_index', { ascending: true })
      .order('source', { ascending: true })
      .range(offset, end);
    if (error) {
      return { data: null, error: mapError(error) };
    }
    const batch = (data ?? []) as DailySensorAqiRow[];
    if (batch.length === 0) break;
    for (const r of batch) {
      rows.push(r);
      if (rows.length >= SENSOR_RANGE_HARD_MAX) break;
    }
    if (rows.length >= SENSOR_RANGE_HARD_MAX) break;
    offset += batch.length;
    if (batch.length < SENSOR_RANGE_PAGE_SIZE) break;
  }
  return { data: rows, error: null };
}

export async function fetchDailySensorAqiAtRecordedTime(
  recordedTime: string,
): Promise<{
  data: DailySensorAqiRow[] | null;
  error: FetchError | null;
}> {
  const rows: DailySensorAqiRow[] = [];
  let offset = 0;
  while (rows.length < SNAPSHOT_ROW_CAP) {
    const end = offset + SENSOR_RANGE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('daily_sensor_aqi')
      .select(DAILY_SENSOR_AQI_COLUMNS)
      .eq('time', recordedTime)
      .order('sensor_index', { ascending: true })
      .order('source', { ascending: true })
      .range(offset, end);
    if (error) {
      return { data: null, error: mapError(error) };
    }
    const batch = (data ?? []) as DailySensorAqiRow[];
    if (batch.length === 0) break;
    for (const r of batch) {
      rows.push(r);
      if (rows.length >= SNAPSHOT_ROW_CAP) break;
    }
    if (rows.length >= SNAPSHOT_ROW_CAP) break;
    offset += batch.length;
    if (batch.length < SENSOR_RANGE_PAGE_SIZE) break;
  }
  return { data: rows, error: null };
}

export async function fetchDailySensorAqiCalendarRows(): Promise<{
  data: DailySensorAqiRow[] | null;
  error: FetchError | null;
}> {
  const { data, error } = await supabase
    .from('daily_sensor_aqi')
    .select('time,aqi,pm25')
    .order('time', { ascending: false })
    .limit(50_000);
  if (error) {
    return { data: null, error: mapError(error) };
  }
  return { data: ((data ?? []) as DailySensorAqiRow[]).reverse(), error: null };
}

export async function fetchDailySensorAqiCalendarRowsForMonth(
  fromRecordedTime: string,
  toRecordedTime: string,
): Promise<{
  data: DailySensorAqiRow[] | null;
  error: FetchError | null;
}> {
  const rows: DailySensorAqiRow[] = [];
  let offset = 0;
  while (rows.length < SENSOR_RANGE_HARD_MAX) {
    const end = offset + SENSOR_RANGE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('daily_sensor_aqi')
      .select('time,aqi,pm25')
      .gte('time', fromRecordedTime)
      .lte('time', toRecordedTime)
      .order('time', { ascending: true })
      .order('sensor_index', { ascending: true })
      .order('source', { ascending: true })
      .range(offset, end);
    if (error) {
      return { data: null, error: mapError(error) };
    }
    const batch = (data ?? []) as DailySensorAqiRow[];
    if (batch.length === 0) break;
    for (const r of batch) {
      rows.push(r);
      if (rows.length >= SENSOR_RANGE_HARD_MAX) break;
    }
    if (rows.length >= SENSOR_RANGE_HARD_MAX) break;
    offset += batch.length;
    if (batch.length < SENSOR_RANGE_PAGE_SIZE) break;
  }
  return { data: rows, error: null };
}

export async function fetchKrigingGridAtRecordedTime(recordedTime: string): Promise<{
  data: CurrentKrigingRow[] | null;
  error: FetchError | null;
}> {
  const rows: CurrentKrigingRow[] = [];
  let offset = 0;
  while (rows.length < KRIGING_MAX_TOTAL_ROWS) {
    const end = offset + KRIGING_RANGE_PAGE - 1;
    const { data, error } = await supabase
      .from('current_kriging')
      .select(KRIGING_COLUMNS)
      .eq('time', recordedTime)
      .order('latitude', { ascending: true })
      .order('longitude', { ascending: true })
      .range(offset, end);
    if (error) return { data: null, error: mapError(error) };
    const batch = ((data ?? []) as Array<Partial<CurrentKrigingRow>>).map((row) => ({
      latitude: row.latitude as number,
      longitude: row.longitude as number,
      pm25: row.pm25 ?? null,
      time: row.time ?? recordedTime,
      kriging_variance: row.kriging_variance ?? null,
      aqi: row.aqi ?? null,
    }));
    if (batch.length === 0) break;
    rows.push(...batch);
    offset += batch.length;
    if (batch.length < KRIGING_RANGE_PAGE) break;
  }
  return { data: rows, error: null };
}

export async function fetchNearestKrigingRecordedTime(
  recordedTime: string,
  lookbackHours = 24,
): Promise<{ recordedTime: string | null; error: FetchError | null }> {
  const targetMs = new Date(recordedTime).getTime();
  if (!Number.isFinite(targetMs)) {
    return { recordedTime: null, error: { message: 'Invalid recorded time' } };
  }
  const from = new Date(targetMs - lookbackHours * HOUR_MS).toISOString();
  const [beforeRes, afterRes] = await Promise.all([
    supabase
      .from('current_kriging')
      .select('time')
      .gte('time', from)
      .lte('time', recordedTime)
      .order('time', { ascending: false })
      .limit(1),
    supabase
      .from('current_kriging')
      .select('time')
      .gte('time', recordedTime)
      .order('time', { ascending: true })
      .limit(1),
  ]);

  const err = beforeRes.error ?? afterRes.error;
  if (err) {
    return { recordedTime: null, error: mapError(err) };
  }

  const beforeTime = ((beforeRes.data ?? [])[0] as { time?: string } | undefined)?.time ?? null;
  const afterTime = ((afterRes.data ?? [])[0] as { time?: string } | undefined)?.time ?? null;
  if (!beforeTime && !afterTime) {
    return { recordedTime: null, error: null };
  }

  if (!beforeTime) return { recordedTime: afterTime, error: null };
  if (!afterTime) return { recordedTime: beforeTime, error: null };

  const beforeDelta = Math.abs(new Date(beforeTime).getTime() - targetMs);
  const afterDelta = Math.abs(new Date(afterTime).getTime() - targetMs);
  return { recordedTime: beforeDelta <= afterDelta ? beforeTime : afterTime, error: null };
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
    tPurple ? fetchPurpleAirAtRecordedTimePaginated(tPurple) : Promise.resolve({ data: [] as PurpleAirRow[], error: null }),
    tClarity ? fetchClarityAtRecordedTimePaginated(tClarity) : Promise.resolve({ data: [] as ClarityRow[], error: null }),
  ]);

  const err = purple.error ?? clarity.error;
  return {
    purpleAir: purple.data,
    clarity: clarity.data,
    recordedTimes: { purpleAir: tPurple, clarity: tClarity },
    error: err,
  };
}

/** All interpolated grid rows from current_kriging (single surface per load). */
export async function fetchCurrentKrigingGrid(): Promise<{
  data: CurrentKrigingRow[] | null;
  error: FetchError | null;
}> {
  const rows: CurrentKrigingRow[] = [];
  let offset = 0;
  while (rows.length < KRIGING_MAX_TOTAL_ROWS) {
    const end = offset + KRIGING_RANGE_PAGE - 1;
    const { data, error } = await supabase
      .from('current_kriging')
      .select(KRIGING_COLUMNS)
      .order('latitude', { ascending: true })
      .order('longitude', { ascending: true })
      .range(offset, end);

    if (error) {
      return { data: null, error: mapError(error) };
    }

    const batch = ((data ?? []) as Array<Partial<CurrentKrigingRow>>).map((row) => ({
      latitude: row.latitude as number,
      longitude: row.longitude as number,
      pm25: row.pm25 ?? null,
      time: row.time ?? new Date().toISOString(),
      kriging_variance: row.kriging_variance ?? null,
      aqi: row.aqi ?? null,
    }));
    if (batch.length === 0) break;
    rows.push(...batch);
    offset += batch.length;
    if (batch.length < KRIGING_RANGE_PAGE) break;
  }

  return { data: rows, error: null };
}

const HOUR_MS = 60 * 60 * 1000;

async function collectDistinctPipelineTimesFromTable(
  table: 'purple_air' | 'clarity',
  fromIso: string,
  toIso: string,
  into: Set<string>,
): Promise<FetchError | null> {
  let offset = 0;
  let scanned = 0;
  while (scanned < PIPELINE_TIME_SCAN_HARD_MAX) {
    const end = offset + PIPELINE_TIME_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from(table)
      .select('time,sensor_index')
      .gte('time', fromIso)
      .lte('time', toIso)
      .order('time', { ascending: true })
      .order('sensor_index', { ascending: true })
      .range(offset, end);
    if (error) {
      return mapError(error);
    }
    const batch = (data ?? []) as { time: string }[];
    if (batch.length === 0) break;
    for (const row of batch) {
      if (row?.time) into.add(row.time);
    }
    scanned += batch.length;
    if (batch.length < PIPELINE_TIME_PAGE_SIZE) break;
    offset += batch.length;
  }
  return null;
}

/**
 * Distinct pipeline `time` values in the window [now - hoursBack, now], from PurpleAir + Clarity.
 * Sorted ascending (oldest first). Used for timeline scrubbing.
 */
export async function fetchDistinctPipelineTimes(hoursBack: number): Promise<{
  times: string[];
  error: FetchError | null;
}> {
  const nowMs = Date.now();
  const from = new Date(nowMs - hoursBack * HOUR_MS - ROLLING_24H_TIME_WINDOW_BUFFER_MS).toISOString();
  const to = new Date(nowMs).toISOString();
  const set = new Set<string>();
  const [e1, e2] = await Promise.all([
    collectDistinctPipelineTimesFromTable('purple_air', from, to, set),
    collectDistinctPipelineTimesFromTable('clarity', from, to, set),
  ]);
  const err = e1 ?? e2;
  if (err) {
    return { times: [], error: err };
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
