import { useMemo } from 'react';
import Mapbox from '@rnmapbox/maps';
import { contours, type ContourMultiPolygon } from 'd3-contour';
import type { FeatureCollection, MultiPolygon } from 'geojson';

import type { CurrentKrigingRow } from '../lib/database.types';
import { PM25_AQI_BOUNDS } from '../lib/pm25ColorScale';
import { recomputeKrigingFromSensors } from '../lib/recomputeKriging';
import type { MapRegion } from '../lib/mapRegionFromData';
import type { SensorPoint } from '../lib/sensorTypes';

type KrigingHeatmapLayerProps = {
  kriging: CurrentKrigingRow[];
  mapRegion: MapRegion;
  sensors: SensorPoint[];
};

const HEATMAP_GRID_STEPS = 40;
const EXPECTED_GRID_CELLS = HEATMAP_GRID_STEPS * HEATMAP_GRID_STEPS;
const BIN_COLORS = ['#00e400', '#ffff00', '#ff7e00', '#ff0000', '#8f3f97', '#7e0023', '#4a001a'];
const BIN_CONTOUR_THRESHOLDS = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
const BIN_UPPER_BOUNDS = PM25_AQI_BOUNDS.slice(1);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pm25BinIndex(pm25: number): number {
  for (let i = 0; i < BIN_UPPER_BOUNDS.length; i++) {
    if (pm25 <= BIN_UPPER_BOUNDS[i]) return i;
  }
  return BIN_UPPER_BOUNDS.length;
}

export function KrigingHeatmapLayer({ kriging, mapRegion, sensors }: KrigingHeatmapLayerProps) {
  const binnedGeoJson = useMemo(
    () => {
      const time = sensors[0]?.time ?? new Date().toISOString();
      const recomputed =
        sensors.length > 0
          ? recomputeKrigingFromSensors(sensors, time, {
              latSteps: HEATMAP_GRID_STEPS,
              lonSteps: HEATMAP_GRID_STEPS,
            })
          : [];
      const gridRows =
        recomputed.length >= EXPECTED_GRID_CELLS ? recomputed.slice(0, EXPECTED_GRID_CELLS) : kriging;
      const validRows = gridRows.filter(
        (r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && Number.isFinite(r.pm25),
      );
      if (validRows.length === 0) {
        return {
          type: 'FeatureCollection',
          features: [],
        } as FeatureCollection<MultiPolygon, { bin: number; color: string; level: number }>;
      }

      const byLat = new Map<number, Map<number, number>>();
      for (const row of validRows) {
        let lonMap = byLat.get(row.latitude);
        if (!lonMap) {
          lonMap = new Map<number, number>();
          byLat.set(row.latitude, lonMap);
        }
        lonMap.set(row.longitude, row.pm25 as number);
      }

      const latAsc = Array.from(byLat.keys()).sort((a, b) => a - b);
      if (latAsc.length < 2) {
        return {
          type: 'FeatureCollection',
          features: [],
        } as FeatureCollection<MultiPolygon, { bin: number; color: string; level: number }>;
      }
      const lonAsc = Array.from(byLat.get(latAsc[0])?.keys() ?? []).sort((a, b) => a - b);
      if (lonAsc.length < 2) {
        return {
          type: 'FeatureCollection',
          features: [],
        } as FeatureCollection<MultiPolygon, { bin: number; color: string; level: number }>;
      }

      const n = lonAsc.length;
      const m = latAsc.length;
      const minLon = lonAsc[0];
      const maxLon = lonAsc[n - 1];
      const minLat = latAsc[0];
      const maxLat = latAsc[m - 1];
      if (!(maxLon > minLon) || !(maxLat > minLat)) {
        return {
          type: 'FeatureCollection',
          features: [],
        } as FeatureCollection<MultiPolygon, { bin: number; color: string; level: number }>;
      }

      const values: number[] = [];
      for (let y = 0; y < m; y++) {
        const lat = latAsc[m - 1 - y];
        const lonMap = byLat.get(lat);
        for (let x = 0; x < n; x++) {
          const lon = lonAsc[x];
          const pm = lonMap?.get(lon);
          values.push(pm == null ? 0 : pm25BinIndex(pm));
        }
      }

      const contourGen = contours().size([n, m]).thresholds(BIN_CONTOUR_THRESHOLDS);
      const contourFeatures = contourGen(values);
      const shape: FeatureCollection<MultiPolygon, { bin: number; color: string; level: number }> = {
        type: 'FeatureCollection',
        features: [
          // No base fill for "good" AQI (green): leave the map visible there; contours handle higher bins only.
          ...contourFeatures.map((feature: ContourMultiPolygon, idx: number) => {
            const level = Number(feature.value);
            // Category contours at 0.5, 1.5, ... represent areas where bin index >= 1, >= 2, ...
            const safeBin = clamp(Math.round(level + 0.5), 1, BIN_COLORS.length - 1);
            const projected = feature.coordinates.map((poly: number[][][]) =>
              poly.map((ring: number[][]) =>
                ring.map(([x, y]: number[]) => {
                  const lon = minLon + (x / (n - 1)) * (maxLon - minLon);
                  const lat = maxLat - (y / (m - 1)) * (maxLat - minLat);
                  return [lon, lat] as [number, number];
                }),
              ),
            );
            return {
              type: 'Feature' as const,
              id: `kband-${idx}`,
              geometry: {
                type: 'MultiPolygon' as const,
                coordinates: projected,
              },
              properties: {
                bin: safeBin,
                color: BIN_COLORS[safeBin],
                level,
              },
            };
          }),
        ],
      };
      return shape;
    },
    [kriging, mapRegion, sensors],
  );

  if (binnedGeoJson.features.length === 0) return null;

  return (
    <Mapbox.ShapeSource id="kriging-heat-source" shape={binnedGeoJson}>
      <Mapbox.FillLayer
        id="kriging-binned-fill-layer"
        style={{
          fillSortKey: ['get', 'bin'],
          fillColor: ['get', 'color'],
          fillOpacity: 0.3,
          fillAntialias: true,
        }}
      />
      <Mapbox.LineLayer
        id="kriging-binned-line-soft-layer"
        style={{
          lineColor: ['get', 'color'],
          lineOpacity: 0.2,
          lineWidth: ['interpolate', ['linear'], ['zoom'], 10, 1.4, 14, 2.3],
          lineBlur: 1.2,
          lineJoin: 'round',
          lineCap: 'round',
        }}
      />
      <Mapbox.LineLayer
        id="kriging-binned-line-layer"
        style={{
          lineColor: ['get', 'color'],
          lineOpacity: 0.34,
          lineWidth: ['interpolate', ['linear'], ['zoom'], 10, 0.35, 14, 0.78],
          lineBlur: 0.25,
          lineJoin: 'round',
          lineCap: 'round',
        }}
      />
    </Mapbox.ShapeSource>
  );
}
