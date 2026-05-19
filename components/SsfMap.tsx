import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Mapbox from '@rnmapbox/maps';
import type { FeatureCollection, Point } from 'geojson';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import type { CurrentKrigingRow } from '../lib/database.types';
import { SSF_BBOX } from '../lib/constants/ssf';
import { pm25BreakpointCategory, pm25ToAqi } from '../lib/aqiUtils';
import type { MapRegion } from '../lib/mapRegionFromData';
import type { SensorPoint } from '../lib/sensorTypes';
import { KrigingHeatmapLayer } from './KrigingHeatmapLayer';
import { MapScaleActions } from './MapScaleActions';

export type MapSelectDetail = {
  touchInBottomBand: boolean;
  screenPointX?: number | null;
  screenPointY?: number | null;
  sensorIndex?: number;
  sensorSource?: string;
  sensorName?: string | null;
};

export type SsfMapProps = {
  sensors: SensorPoint[];
  kriging: CurrentKrigingRow[];
  mapRegion: MapRegion;
  selected: { latitude: number; longitude: number } | null;
  /** Saved reminder pin (same coords as global reminder in the panel). */
  reminderLocation?: { latitude: number; longitude: number } | null;
  onSelectCoordinate: (lat: number, lon: number, detail: MapSelectDetail) => void;
  selectedCallout?: ReactNode;
  selectedCalloutPlacement?: 'above' | 'below';
  selectedCalloutShiftX?: number;
  onNotificationPress?: () => void;
  onModelingPress?: () => void;
};

export type SsfMapHandle = {
  focusCoordinate: (lat: number, lon: number, zoomLevel?: number) => void;
};

const NOTIFICATION_FOCUS_ZOOM = 14;

const mapboxToken = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
if (mapboxToken) {
  Mapbox.setAccessToken(mapboxToken);
}

const DEFAULT_ZOOM_LEVEL = 12;
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 3;
const MIN_ZOOM_LEVEL = DEFAULT_ZOOM_LEVEL * MIN_ZOOM_FACTOR;
const MAX_ZOOM_LEVEL = DEFAULT_ZOOM_LEVEL * MAX_ZOOM_FACTOR;
const ZOOM_STEP = 1;
const REMINDER_BELL_PATH =
  'M42.2174 32.922V21.7756C42.2174 20.4935 42.0235 19.2188 41.6423 17.9946C37.9321 6.07937 21.0679 6.07937 17.3577 17.9946C16.9765 19.2188 16.7826 20.4935 16.7826 21.7756V32.922C16.7826 34.01 16.3743 35.0585 15.6383 35.8599L11.5394 40.3236C10.9506 40.9648 11.4054 42 12.2759 42H46.7241C47.5946 42 48.0494 40.9648 47.4606 40.3236L43.3617 35.8599C42.6257 35.0585 42.2174 34.01 42.2174 32.922Z';

function ReminderBellIcon() {
  return (
    <Svg width={30} height={30} viewBox="0 0 60 60">
      <Circle cx={29.5} cy={45.5} r={6.5} fill="#F66D1E" stroke="#AA2C1E" strokeWidth={4} />
      <Path
        d={REMINDER_BELL_PATH}
        fill="#F66D1E"
        stroke="#AA2C1E"
        strokeWidth={4}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export const SsfMap = forwardRef<SsfMapHandle, SsfMapProps>(function SsfMap(
  {
    sensors,
    kriging,
    mapRegion,
    selected,
    reminderLocation = null,
    onSelectCoordinate,
    selectedCallout = null,
    selectedCalloutPlacement = 'above',
    selectedCalloutShiftX = 0,
    onNotificationPress,
    onModelingPress,
  },
  ref,
) {
  const wrapRef = useRef<View>(null);
  const cameraRef = useRef<Mapbox.Camera>(null);
  const lastSensorTapMsRef = useRef(0);
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_ZOOM_LEVEL);
  const calloutScale = useRef(new Animated.Value(0.92)).current;
  const calloutOpacity = useRef(new Animated.Value(0)).current;
  const [animatedSelected, setAnimatedSelected] = useState(selected);
  const [animatedCallout, setAnimatedCallout] = useState<ReactNode>(selectedCallout);
  const [animatedPlacement, setAnimatedPlacement] = useState<'above' | 'below'>(selectedCalloutPlacement);
  const [animatedShiftX, setAnimatedShiftX] = useState(selectedCalloutShiftX);
  const prevSelectedCoordKeyRef = useRef<string | null>(
    selected ? `${selected.latitude.toFixed(6)}:${selected.longitude.toFixed(6)}` : null,
  );

  const sensorGeoJson = useMemo(() => {
    const shape: FeatureCollection<
      Point,
      { sensor_index: number; source: string; name: string | null; pm25: number; aqi: number; color: string }
    > = {
      type: 'FeatureCollection',
      features: sensors.map((s) => ({
        type: 'Feature' as const,
        id: `s-${s.source}-${s.sensorIndex}`,
        geometry: {
          type: 'Point' as const,
          coordinates: [s.longitude, s.latitude],
        },
        properties: {
          sensor_index: s.sensorIndex,
          source: s.source,
          name: s.name ?? null,
          pm25: s.pm25,
          aqi: pm25ToAqi(s.pm25) ?? 0,
          color: pm25BreakpointCategory(s.pm25).bg,
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

  const handlePress = useCallback(
    (
      lat: number,
      lon: number,
      pageX: number | null,
      pageY: number | null,
      sensorDetail?: { sensorIndex?: number; sensorSource?: string; sensorName?: string | null },
    ) => {
      const finish = (touchInBottomBand: boolean) => {
        onSelectCoordinate(lat, lon, {
          touchInBottomBand,
          screenPointX: pageX,
          screenPointY: pageY,
          ...sensorDetail,
        });
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
      // Prevent the immediate map click after a sensor click from overriding sensor selection.
      if (Date.now() - lastSensorTapMsRef.current < 250) return;
      const coords = event?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      const [lon, lat] = coords;
      const maybePageX = (event?.properties as { screenPointX?: number } | undefined)?.screenPointX ?? null;
      const maybePageY = (event?.properties as { screenPointY?: number } | undefined)?.screenPointY ?? null;
      handlePress(lat, lon, maybePageX, maybePageY);
    },
    [handlePress],
  );

  const handleSensorPress = useCallback(
    (event: any) => {
      const feature = event.features?.[0];
      const coords = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (!coords || coords.length < 2) return;
      const [lon, lat] = coords;
      const rawSensorIndex = feature?.properties?.sensor_index;
      const sensorIndex =
        typeof rawSensorIndex === 'number'
          ? rawSensorIndex
          : typeof rawSensorIndex === 'string'
            ? Number.parseInt(rawSensorIndex, 10)
            : undefined;
      const sensorSource =
        typeof feature?.properties?.source === 'string' ? feature.properties.source : undefined;
      const sensorName =
        typeof feature?.properties?.name === 'string' ? feature.properties.name : null;
      const maybePageY =
        (event as unknown as { properties?: { screenPointY?: number } }).properties?.screenPointY ?? null;
      const maybePageX =
        (event as unknown as { properties?: { screenPointX?: number } }).properties?.screenPointX ?? null;
      lastSensorTapMsRef.current = Date.now();
      handlePress(lat, lon, maybePageX, maybePageY, {
        sensorIndex: Number.isFinite(sensorIndex) ? sensorIndex : undefined,
        sensorSource,
        sensorName,
      });
    },
    [handlePress],
  );

  const handleReminderPress = useCallback(() => {
    if (!reminderLocation) return;
    handlePress(reminderLocation.latitude, reminderLocation.longitude, null, null);
  }, [handlePress, reminderLocation]);

  useImperativeHandle(
    ref,
    () => ({
      focusCoordinate(lat: number, lon: number, zoom = NOTIFICATION_FOCUS_ZOOM) {
        const clamped = Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, zoom));
        setZoomLevel(clamped);
        cameraRef.current?.setCamera({
          centerCoordinate: [lon, lat],
          zoomLevel: clamped,
          animationDuration: 700,
          animationMode: 'flyTo',
        });
      },
    }),
    [],
  );

  const canZoomIn = zoomLevel < MAX_ZOOM_LEVEL - 0.05;
  const canZoomOut = zoomLevel > MIN_ZOOM_LEVEL + 0.05;

  const applyZoomDelta = useCallback(
    (delta: number) => {
      const next = Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, zoomLevel + delta));
      setZoomLevel(next);
      cameraRef.current?.setCamera({
        centerCoordinate: [mapRegion.longitude, mapRegion.latitude],
        zoomLevel: next,
        animationDuration: 200,
        animationMode: 'easeTo',
      });
    },
    [mapRegion.latitude, mapRegion.longitude, zoomLevel],
  );

  const zoomIn = useCallback(() => applyZoomDelta(ZOOM_STEP), [applyZoomDelta]);
  const zoomOut = useCallback(() => applyZoomDelta(-ZOOM_STEP), [applyZoomDelta]);

  const handleCameraChanged = useCallback((event: { properties?: { zoom?: number } }) => {
    const z = event.properties?.zoom;
    if (typeof z === 'number' && Number.isFinite(z)) {
      setZoomLevel(z);
    }
  }, []);

  useEffect(() => {
    const selectedCoordKey = selected
      ? `${selected.latitude.toFixed(6)}:${selected.longitude.toFixed(6)}`
      : null;
    const didOpen = prevSelectedCoordKeyRef.current == null && selectedCoordKey != null;
    const didClose = prevSelectedCoordKeyRef.current != null && selectedCoordKey == null;
    const didMove =
      prevSelectedCoordKeyRef.current != null &&
      selectedCoordKey != null &&
      prevSelectedCoordKeyRef.current !== selectedCoordKey;
    prevSelectedCoordKeyRef.current = selectedCoordKey;

    if (selected) {
      setAnimatedSelected(selected);
      setAnimatedCallout(selectedCallout);
      setAnimatedPlacement(selectedCalloutPlacement);
      setAnimatedShiftX(selectedCalloutShiftX);
      if (didOpen || didMove) {
        calloutScale.stopAnimation();
        calloutOpacity.stopAnimation();
        calloutScale.setValue(0.92);
        calloutOpacity.setValue(0);
        Animated.parallel([
          Animated.spring(calloutScale, {
            toValue: 1,
            stiffness: 220,
            damping: 16,
            mass: 0.7,
            useNativeDriver: true,
          }),
          Animated.timing(calloutOpacity, {
            toValue: 1,
            duration: 180,
            useNativeDriver: true,
          }),
        ]).start();
      } else {
        calloutScale.setValue(1);
        calloutOpacity.setValue(1);
      }
      return;
    }
    if (!didClose || !animatedSelected) return;
    calloutScale.stopAnimation();
    calloutOpacity.stopAnimation();
    Animated.parallel([
      Animated.timing(calloutScale, {
        toValue: 0.94,
        duration: 140,
        useNativeDriver: true,
      }),
      Animated.timing(calloutOpacity, {
        toValue: 0,
        duration: 120,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished) return;
      setAnimatedSelected(null);
      setAnimatedCallout(null);
    });
  }, [
    animatedSelected,
    calloutOpacity,
    calloutScale,
    selected,
  ]);

  useEffect(() => {
    if (!selected) return;
    setAnimatedCallout(selectedCallout);
    setAnimatedPlacement(selectedCalloutPlacement);
    setAnimatedShiftX(selectedCalloutShiftX);
  }, [selected, selectedCallout, selectedCalloutPlacement, selectedCalloutShiftX]);

  return (
    <View ref={wrapRef} style={styles.wrap}>
      <Mapbox.MapView
        style={styles.map}
        styleURL={Mapbox.StyleURL.Street}
        compassEnabled={false}
        logoEnabled={false}
        attributionEnabled={false}
        scaleBarEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        onPress={handleMapPress}
        onCameraChanged={handleCameraChanged}
      >
        <Mapbox.Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: [mapRegion.longitude, mapRegion.latitude],
            zoomLevel: DEFAULT_ZOOM_LEVEL,
          }}
          centerCoordinate={[mapRegion.longitude, mapRegion.latitude]}
          maxBounds={{
            ne: [SSF_BBOX.seLon, SSF_BBOX.nwLat],
            sw: [SSF_BBOX.nwLon, SSF_BBOX.seLat],
          }}
          minZoomLevel={MIN_ZOOM_LEVEL}
          maxZoomLevel={MAX_ZOOM_LEVEL}
        />

        <KrigingHeatmapLayer kriging={kriging} mapRegion={mapRegion} sensors={sensors} />

        <Mapbox.ShapeSource id="sensors" shape={sensorGeoJson} onPress={handleSensorPress}>
          <Mapbox.CircleLayer
            id="sensor-points"
            style={{
              circleRadius: 7,
              circleColor: ['get', 'color'],
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
                circleColor: 'rgba(255,255,255,0)',
                circleStrokeWidth: 3,
                circleStrokeColor: '#0f172a',
              }}
            />
          </Mapbox.ShapeSource>
        ) : null}
        {animatedSelected && animatedCallout ? (
          <Mapbox.MarkerView
            id="selected-callout"
            coordinate={[animatedSelected.longitude, animatedSelected.latitude]}
            anchor={{ x: 0.5, y: animatedPlacement === 'above' ? 1 : 0 }}
          >
            <Animated.View
              style={[
                styles.calloutWrap,
                animatedPlacement === 'above' ? styles.calloutWrapAbove : styles.calloutWrapBelow,
                {
                  opacity: calloutOpacity,
                  transform: [{ scale: calloutScale }],
                },
              ]}
              pointerEvents="box-none"
            >
              {animatedPlacement === 'below' ? <View style={styles.calloutArrowUp} /> : null}
              <View style={[styles.calloutCard, { transform: [{ translateX: animatedShiftX }] }]}>
                {animatedCallout}
              </View>
              {animatedPlacement === 'above' ? <View style={styles.calloutArrowDown} /> : null}
            </Animated.View>
          </Mapbox.MarkerView>
        ) : null}

        {reminderLocation ? (
          <Mapbox.PointAnnotation
            id="reminder-point-annotation"
            coordinate={[reminderLocation.longitude, reminderLocation.latitude]}
            onSelected={handleReminderPress}
          >
            <Pressable onPress={handleReminderPress} hitSlop={14} style={styles.reminderIconWrap}>
              <ReminderBellIcon />
            </Pressable>
          </Mapbox.PointAnnotation>
        ) : null}
      </Mapbox.MapView>
      <MapScaleActions
        onNotificationPress={onNotificationPress}
        onModelingPress={onModelingPress}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        canZoomIn={canZoomIn}
        canZoomOut={canZoomOut}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 0, width: '100%', alignSelf: 'stretch', backgroundColor: '#dbeafe' },
  map: { flex: 1 },
  reminderIconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  calloutWrap: {
    alignItems: 'center',
  },
  calloutWrapAbove: {
    marginBottom: 18,
  },
  calloutWrapBelow: {
    marginTop: 18,
  },
  calloutCard: {
    width: 300,
    borderRadius: 14,
    overflow: 'hidden',
  },
  calloutArrowDown: {
    marginTop: -1,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderTopWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: 'rgba(255,255,255,0.92)',
  },
  calloutArrowUp: {
    marginBottom: -1,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: 'rgba(255,255,255,0.92)',
  },
});
