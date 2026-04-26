import { supabase } from './supabase';

import type { ClarityRow, CurrentKrigingRow, DailySensorAqiRow, PurpleAirRow } from './database.types';

export type FetchError = { message: string; details?: string };

/** Cap when selecting all sensors for one pipeline `time` (many rows). */
const SNAPSHOT_ROW_CAP = 50_000;

/**
 * PostgREST defaults to 1000 rows per request; paginate to load the full kriging grid (~10k+ cells).
 */
const KRIGING_PAGE_SIZE = 5000;
const KRIGING_MAX_PAGES = 200;
const SENSOR_COLUMNS = 'sensor_index,latitude,longitude,pm25,time';
const KRIGING_COLUMNS = 'latitude,longitude,pm25,time';
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
    fetchPurpleAirReadings({
      fromRecordedTime,
      toRecordedTime,
      limit: SNAPSHOT_ROW_CAP,
    }),
    fetchClarityReadings({
      fromRecordedTime,
      toRecordedTime,
      limit: SNAPSHOT_ROW_CAP,
    }),
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
  const { data, error } = await supabase
    .from('daily_sensor_aqi')
    .select(DAILY_SENSOR_AQI_COLUMNS)
    .gte('time', fromRecordedTime)
    .lte('time', toRecordedTime)
    .order('time', { ascending: true })
    .limit(SNAPSHOT_ROW_CAP);

  if (error) {
    return { data: null, error: mapError(error) };
  }
  return { data: (data ?? []) as DailySensorAqiRow[], error: null };
}

export async function fetchDailySensorAqiAtRecordedTime(
  recordedTime: string,
): Promise<{
  data: DailySensorAqiRow[] | null;
  error: FetchError | null;
}> {
  const { data, error } = await supabase
    .from('daily_sensor_aqi')
    .select(DAILY_SENSOR_AQI_COLUMNS)
    .eq('time', recordedTime)
    .order('sensor_index', { ascending: true })
    .limit(SNAPSHOT_ROW_CAP);
  if (error) {
    return { data: null, error: mapError(error) };
  }
  return { data: (data ?? []) as DailySensorAqiRow[], error: null };
}

export async function fetchDailySensorAqiCalendarRows(): Promise<{
  data: DailySensorAqiRow[] | null;
  error: FetchError | null;
}> {
  const { data, error } = await supabase
    .from('daily_sensor_aqi')
    .select('time,aqi,pm25')
    .order('time', { ascending: true })
    .limit(50_000);
  if (error) {
    return { data: null, error: mapError(error) };
  }
  return { data: (data ?? []) as DailySensorAqiRow[], error: null };
}

export async function fetchDailySensorAqiCalendarRowsForMonth(
  fromRecordedTime: string,
  toRecordedTime: string,
): Promise<{
  data: DailySensorAqiRow[] | null;
  error: FetchError | null;
}> {
  const { data, error } = await supabase
    .from('daily_sensor_aqi')
    .select('time,aqi,pm25')
    .gte('time', fromRecordedTime)
    .lte('time', toRecordedTime)
    .order('time', { ascending: true })
    .limit(50_000);
  if (error) {
    return { data: null, error: mapError(error) };
  }
  return { data: (data ?? []) as DailySensorAqiRow[], error: null };
}

export async function fetchKrigingGridAtRecordedTime(recordedTime: string): Promise<{
  data: CurrentKrigingRow[] | null;
  error: FetchError | null;
}> {
  const rows: CurrentKrigingRow[] = [];
  for (let page = 0; page < KRIGING_MAX_PAGES; page++) {
    const offset = page * KRIGING_PAGE_SIZE;
    const { data, error } = await supabase
      .from('current_kriging')
      .select(KRIGING_COLUMNS)
      .eq('time', recordedTime)
      .order('latitude', { ascending: true })
      .order('longitude', { ascending: true })
      .range(offset, offset + KRIGING_PAGE_SIZE - 1);
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
    if (batch.length < KRIGING_PAGE_SIZE) break;
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

  for (let page = 0; page < KRIGING_MAX_PAGES; page++) {
    const offset = page * KRIGING_PAGE_SIZE;
    const { data, error } = await supabase
      .from('current_kriging')
      .select(KRIGING_COLUMNS)
      .order('latitude', { ascending: true })
      .order('longitude', { ascending: true })
      .range(offset, offset + KRIGING_PAGE_SIZE - 1);

    if (error) {
      return { data: null, error: mapError(error) };
    }

    const batch = ((data ?? []) as Array<Partial<CurrentKrigingRow>>).map((row) => ({
      latitude: row.latitude as number,
      longitude: row.longitude as number,
      pm25: row.pm25 ?? null,
      time: row.time ?? new Date(0).toISOString(),
      // Optional in some deployments; keep null when absent.
      kriging_variance: row.kriging_variance ?? null,
      aqi: row.aqi ?? null,
    }));
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
