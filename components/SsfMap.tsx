import { useCallback, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, useWindowDimensions, View } from 'react-native';

import type { CurrentKrigingRow } from '../lib/database.types';
import { SSF_GEO_BOUNDS } from '../lib/constants/ssfGeo';
import { pm25ToAqi } from '../lib/aqiUtils';
import { buildKrigingHeatmapPoints } from '../lib/krigingHeatmapPoints';
import { getColorFromAqi } from '../lib/metricColor';
import { pm25ToGradientColor } from '../lib/pm25ColorScale';
import type { MapRegion } from '../lib/mapRegionFromData';
import type { SensorPoint } from '../lib/sensorTypes';
import { StaticMapOverlay } from './StaticMapOverlay';

/** Replace with a PNG that matches `SSF_GEO_BOUNDS` (same framing as Static Maps / OSM for that bbox). */
const MAP_IMAGE = require('../assets/ssf-static-map.png');

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

export function SsfMap({
  sensors,
  kriging,
  mapRegion,
  selected,
  reminderLocation = null,
  onSelectCoordinate,
}: SsfMapProps) {
  const wrapRef = useRef<View>(null);
  const { width: winW, height: winH } = useWindowDimensions();
  const [layout, setLayout] = useState({ w: 0, h: 0 });

  /** If `onLayout` never reports a size (flex edge cases), still mount the map using the full window. */
  const mapW = layout.w > 0 ? layout.w : winW;
  const mapH = layout.h > 0 ? layout.h : winH;

  const heatmapPoints = useMemo(
    () => buildKrigingHeatmapPoints(kriging, mapRegion),
    [kriging, mapRegion],
  );

  const points = useMemo(() => {
    const heat = heatmapPoints.map((p) => ({
      lat: p.latitude,
      lon: p.longitude,
      value: Math.round(p.weight),
      heatmapSplat: true as const,
      color: pm25ToGradientColor(p.pm25),
      // Keep the kriging field visible across the map; modulate within a strong floor.
      opacity: Math.max(0.62, Math.min(1, p.varianceOpacity * (0.6 + 0.4 * p.intensityOpacity))),
    }));
    const sens = sensors.map((s) => ({
      lat: s.latitude,
      lon: s.longitude,
      value: pm25ToAqi(s.pm25) ?? 0,
      radius: 6,
      stroke: '#ffffff',
      strokeWidth: 1.5,
    }));
    return [...heat, ...sens];
  }, [heatmapPoints, sensors]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setLayout({ w: width, h: height });
  }, []);

  const handlePress = useCallback(
    (lat: number, lon: number, detail: { pageX: number; pageY: number }) => {
      const finish = (touchInBottomBand: boolean) => {
        onSelectCoordinate(lat, lon, { touchInBottomBand });
      };

      const wrap = wrapRef.current;
      if (wrap == null || typeof wrap.measureInWindow !== 'function') {
        finish(false);
        return;
      }

      wrap.measureInWindow((_x, y, _w, h) => {
        finish(h > 0 && detail.pageY >= y + h * 0.8);
      });
    },
    [onSelectCoordinate],
  );

  return (
    <View ref={wrapRef} style={styles.wrap} onLayout={onLayout}>
      {winW > 0 && winH > 0 ? (
        <StaticMapOverlay
          mapImage={MAP_IMAGE}
          bounds={SSF_GEO_BOUNDS}
          points={points}
          width={mapW}
          height={mapH}
          getColor={getColorFromAqi}
          selected={selected ? { lat: selected.latitude, lon: selected.longitude } : null}
          reminderPin={
            reminderLocation
              ? { lat: reminderLocation.latitude, lon: reminderLocation.longitude }
              : null
          }
          onPress={handlePress}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 0, width: '100%', alignSelf: 'stretch', backgroundColor: '#dbeafe' },
});
