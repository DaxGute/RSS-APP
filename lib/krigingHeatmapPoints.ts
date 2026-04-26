import { pm25ToAqi } from './aqiUtils';
import type { MapRegion } from './mapRegionFromData';
import { coordinateInRegionSlack } from './mapRegionFromData';
import type { CurrentKrigingRow } from './database.types';

export type HeatmapPoint = {
  latitude: number;
  longitude: number;
  pm25: number;
  weight: number;
  /** Value-scaled opacity [~0.35..1] so cleaner air remains visible but lighter. */
  intensityOpacity: number;
  /**
   * Splat opacity multiplier (~0.25–1), from each row’s `kriging_variance` when present.
   * Higher variance → lower opacity. 1 when variance data is unavailable (constant strength).
   */
  varianceOpacity: number;
};

/**
 * Fallback ~√N for splat radius heuristics in `StaticMapOverlay` when point count is unknown.
 * Does not define a raster grid — splats come one per `current_kriging` row.
 */
export const KRIGING_SPLAT_DENSITY_HINT = 34;

/**
 * One splat per `current_kriging` row at the pipeline’s **own** lat/lon — no IDW or
 * re-interpolation of kriging output. Prefer rows inside the map viewport (with slack for
 * float/bbox mismatch); if that would drop every row, use all valid rows so the layer still draws.
 */
export function buildKrigingHeatmapPoints(kriging: CurrentKrigingRow[], region: MapRegion): HeatmapPoint[] {
  const valid = kriging.filter(
    (p) =>
      p.pm25 != null &&
      Number.isFinite(p.pm25) &&
      Number.isFinite(p.latitude) &&
      Number.isFinite(p.longitude),
  );
  if (valid.length === 0) return [];

  const inView = valid.filter((p) => coordinateInRegionSlack(p.latitude, p.longitude, region));
  const sources = inView.length > 0 ? inView : valid;

  const variances = sources.map((p) =>
    p.kriging_variance != null && Number.isFinite(p.kriging_variance) ? p.kriging_variance : null,
  );
  const hasVariance = variances.some((v) => v != null);
  const finiteVars = variances.filter((v): v is number => v != null && Number.isFinite(v) && v >= 0);
  const maxVar = finiteVars.length > 0 ? Math.max(...finiteVars, 1e-12) : 0;
  const maxPm = Math.max(...sources.map((p) => p.pm25 as number), 1e-9);

  return sources.map((p) => {
    const pm = p.pm25 as number;
    const aqi = pm25ToAqi(pm);
    const w = aqi != null && Number.isFinite(aqi) ? Math.max(1, Math.min(500, aqi)) : 1;
    const intensityOpacity = Math.max(0.35, Math.min(1, 0.35 + 0.65 * (pm / maxPm)));

    let varianceOpacity = 1;
    if (hasVariance && maxVar > 0) {
      const v = p.kriging_variance;
      if (v != null && Number.isFinite(v) && v >= 0) {
        varianceOpacity = Math.max(0.25, 1 - Math.min(1, v / maxVar));
      } else {
        varianceOpacity = 0.35;
      }
    } else if (hasVariance) {
      varianceOpacity = 0.35;
    }

    return {
      latitude: p.latitude,
      longitude: p.longitude,
      pm25: pm,
      weight: w,
      intensityOpacity,
      varianceOpacity,
    };
  });
}

export { EPA_AQI_HEATMAP_GRADIENT } from './aqiUtils';
