import { useCallback, useMemo, useRef, useState } from 'react';
import Mapbox from '@rnmapbox/maps';
import type { FeatureCollection, Point } from 'geojson';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';

import type { CurrentKrigingRow } from '../lib/database.types';
import { SSF_BBOX } from '../lib/constants/ssf';
import { pm25ToAqi } from '../lib/aqiUtils';
import { buildKrigingHeatmapPoints } from '../lib/krigingHeatmapPoints';
import type { MapRegion } from '../lib/mapRegionFromData';
import type { SensorPoint } from '../lib/sensorTypes';

export type MapSelectDetail = {
  touchInBottomBand: boolean;
};

export type SsfMapProps = {
  sensors: SensorPoint[];
  kriging: CurrentKrigingRow[];
  mapRegion: MapRegion;
  selected: { latitude: number; longitude: number } | null;
  /** Saved reminder pin (same coords as global reminder in the panel). */
  reminderLocation?: { latitude: number; longitude: number } | null;
  onSelectCoordinate: (lat: number, lon: number, detail: MapSelectDetail) => void;
};

const mapboxToken = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
if (mapboxToken) {
  Mapbox.setAccessToken(mapboxToken);
}

export function SsfMap({
  sensors,
  kriging,
  mapRegion,
  selected,
  reminderLocation = null,
  onSelectCoordinate,
}: SsfMapProps) {
  const wrapRef = useRef<View>(null);
  const [layout, setLayout] = useState({ w: 0, h: 0 });

  const heatmapPoints = useMemo(
    () => buildKrigingHeatmapPoints(kriging, mapRegion),
    [kriging, mapRegion],
  );

  const heatmapGeoJson = useMemo(() => {
    const shape: FeatureCollection<Point, { weight: number; opacity: number }> = {
      type: 'FeatureCollection',
      features: heatmapPoints.map((p, idx) => ({
        type: 'Feature' as const,
        id: `k-${idx}`,
        geometry: {
          type: 'Point' as const,
          coordinates: [p.longitude, p.latitude],
        },
        properties: {
          weight: Math.round(p.weight),
          opacity: Math.max(0.62, Math.min(1, p.varianceOpacity * (0.6 + 0.4 * p.intensityOpacity))),
        },
      })),
    };
    return shape;
  }, [heatmapPoints]);

  const sensorGeoJson = useMemo(() => {
    const shape: FeatureCollection<Point, { sensor_index: number; pm25: number; aqi: number }> = {
      type: 'FeatureCollection',
      features: sensors.map((s) => ({
        type: 'Feature' as const,
        id: `s-${s.sensorIndex}`,
        geometry: {
          type: 'Point' as const,
          coordinates: [s.longitude, s.latitude],
        },
        properties: {
          sensor_index: s.sensorIndex,
          pm25: s.pm25,
          aqi: pm25ToAqi(s.pm25) ?? 0,
        },
      })),
    };
    return shape;
  }, [sensors]);

  const selectedGeoJson = useMemo(() => {
    if (!selected) return null;
    const shape: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [selected.longitude, selected.latitude],
          },
          properties: {},
        },
      ],
    };
    return shape;
  }, [selected]);

  const reminderGeoJson = useMemo(() => {
    if (!reminderLocation) return null;
    const shape: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [reminderLocation.longitude, reminderLocation.latitude],
          },
          properties: {},
        },
      ],
    };
    return shape;
  }, [reminderLocation]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setLayout({ w: width, h: height });
  }, []);

  const handlePress = useCallback(
    (lat: number, lon: number, pageY: number | null) => {
      const finish = (touchInBottomBand: boolean) => {
        onSelectCoordinate(lat, lon, { touchInBottomBand });
      };

      const wrap = wrapRef.current;
      if (wrap == null || typeof wrap.measureInWindow !== 'function') {
        finish(false);
        return;
      }

      wrap.measureInWindow((_x, y, _w, h) => {
        finish(pageY != null && h > 0 && pageY >= y + h * 0.8);
      });
    },
    [onSelectCoordinate],
  );

  const handleMapPress = useCallback(
    (event: any) => {
      const coords = event?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      const [lon, lat] = coords;
      const maybePageY = (event?.properties as { screenPointY?: number } | undefined)?.screenPointY ?? null;
      handlePress(lat, lon, maybePageY);
    },
    [handlePress],
  );

  const handleSensorPress = useCallback(
    (event: any) => {
      const feature = event.features?.[0];
      const coords = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (!coords || coords.length < 2) return;
      const [lon, lat] = coords;
      const maybePageY =
        (event as unknown as { properties?: { screenPointY?: number } }).properties?.screenPointY ?? null;
      handlePress(lat, lon, maybePageY);
    },
    [handlePress],
  );

  return (
    <View ref={wrapRef} style={styles.wrap} onLayout={onLayout}>
      <Mapbox.MapView
        style={styles.map}
        styleURL={Mapbox.StyleURL.Street}
        compassEnabled={false}
        logoEnabled={false}
        attributionEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        onPress={handleMapPress}
      >
        <Mapbox.Camera
          zoomLevel={12}
          centerCoordinate={[mapRegion.longitude, mapRegion.latitude]}
          maxBounds={{
            ne: [SSF_BBOX.seLon, SSF_BBOX.nwLat],
            sw: [SSF_BBOX.nwLon, SSF_BBOX.seLat],
          }}
          minZoomLevel={10.8}
          maxZoomLevel={14.5}
        />

        {heatmapGeoJson.features.length > 0 ? (
          <Mapbox.ShapeSource id="kriging-heat-source" shape={heatmapGeoJson}>
            <Mapbox.HeatmapLayer
              id="kriging-heat-layer"
              style={{
                heatmapWeight: ['interpolate', ['linear'], ['get', 'weight'], 1, 0.1, 500, 1],
                heatmapIntensity: 1,
                heatmapRadius: ['interpolate', ['linear'], ['zoom'], 10, 18, 14, 28],
                heatmapOpacity: 0.75,
                heatmapColor: [
                  'interpolate',
                  ['linear'],
                  ['heatmap-density'],
                  0,
                  'rgba(0, 228, 0, 0)',
                  0.2,
                  'rgba(255, 255, 0, 0.45)',
                  0.4,
                  'rgba(255, 126, 0, 0.6)',
                  0.6,
                  'rgba(255, 0, 0, 0.7)',
                  0.8,
                  'rgba(143, 63, 151, 0.75)',
                  1,
                  'rgba(126, 0, 35, 0.82)',
                ],
              }}
            />
          </Mapbox.ShapeSource>
        ) : null}

        <Mapbox.ShapeSource id="sensors" shape={sensorGeoJson} onPress={handleSensorPress}>
          <Mapbox.CircleLayer
            id="sensor-points"
            style={{
              circleRadius: 7,
              circleColor: [
                'step',
                ['get', 'aqi'],
                '#00e400',
                50,
                '#ffff00',
                100,
                '#ff7e00',
                150,
                '#ff0000',
                200,
                '#8f3f97',
                300,
                '#7e0023',
              ],
              circleStrokeWidth: 1,
              circleStrokeColor: '#ffffff',
            }}
          />
        </Mapbox.ShapeSource>

        {selectedGeoJson ? (
          <Mapbox.ShapeSource id="selected-point" shape={selectedGeoJson}>
            <Mapbox.CircleLayer
              id="selected-point-layer"
              style={{
                circleRadius: 9,
                circleColor: '#ffffff',
                circleStrokeWidth: 3,
                circleStrokeColor: '#0f172a',
              }}
            />
          </Mapbox.ShapeSource>
        ) : null}

        {reminderGeoJson ? (
          <Mapbox.ShapeSource id="reminder-point" shape={reminderGeoJson}>
            <Mapbox.CircleLayer
              id="reminder-point-layer"
              style={{
                circleRadius: 6,
                circleColor: '#facc15',
                circleStrokeWidth: 2,
                circleStrokeColor: '#111827',
              }}
            />
          </Mapbox.ShapeSource>
        ) : null}
      </Mapbox.MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 0, width: '100%', alignSelf: 'stretch', backgroundColor: '#dbeafe' },
  map: { flex: 1 },
});
