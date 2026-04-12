import type { CurrentKrigingRow } from './database.types';
import { haversineKm } from './geoUtils';
import type { SensorPoint } from './sensorTypes';
import { pm25BreakpointCategory, type Pm25Category } from './aqiUtils';

/** Nearest kriging grid cell (haversine) — uses pipeline values as-is, no IDW on top. */
function pm25AtNearestKrigingCell(lat0: number, lon0: number, kg: CurrentKrigingRow[]): number | null {
  let bestPm: number | null = null;
  let bestD = Infinity;
  for (const r of kg) {
    const d = haversineKm(lat0, lon0, r.latitude, r.longitude);
    if (d < bestD) {
      bestD = d;
      bestPm = r.pm25 as number;
    }
  }
  return bestPm;
}

export function computeSsfSelection(
  lat0: number,
  lon0: number,
  sensors: SensorPoint[],
  kriging: CurrentKrigingRow[],
): {
  predPm25: number | null;
  predPm25Category: Pm25Category;
  closest: { lat: number; lon: number; pm25: number; distKm: number } | null;
} {
  const kg = kriging.filter(
    (r) =>
      r.pm25 != null &&
      Number.isFinite(r.latitude) &&
      Number.isFinite(r.longitude) &&
      Number.isFinite(r.pm25),
  );

  let closest: { lat: number; lon: number; pm25: number; distKm: number } | null = null;
  if (sensors.length > 0) {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < sensors.length; i++) {
      const d = haversineKm(lat0, lon0, sensors[i].latitude, sensors[i].longitude);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    const s = sensors[bestI];
    closest = { lat: s.latitude, lon: s.longitude, pm25: s.pm25, distKm: bestD };
  }

  /** Kriging grid only: value at the geographically nearest cell (no second-stage IDW). */
  const predPm25: number | null = kg.length > 0 ? pm25AtNearestKrigingCell(lat0, lon0, kg) : null;

  const predPm25Category = pm25BreakpointCategory(predPm25);

  return { predPm25, predPm25Category, closest };
}
