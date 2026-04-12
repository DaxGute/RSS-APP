import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, type ImageSourcePropType, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  clamp,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import Svg, {
  Circle,
  Defs,
  G,
  Path,
  Polyline,
  Polygon,
  RadialGradient,
  Stop,
} from 'react-native-svg';

import { KRIGING_SPLAT_DENSITY_HINT } from '../lib/krigingHeatmapPoints';

import type { GeoBounds } from '../lib/geoPixel';
import { latLonToPixel, pixelToLatLon } from '../lib/geoPixel';
import { getColorFromAqi, type MetricColorFn } from '../lib/metricColor';

/** Max zoom = fit-to-view scale × this factor (keeps zoom modest). */
const MAX_ZOOM_FACTOR = 2.25;

/** Material-style notification bell, 24×24 viewBox — solid fill, no plate behind (map shows through). */
const REMINDER_BELL_PATH =
  'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z';

/** Map-content pixels: taps within this distance of the reminder pin snap to that lat/lon. */
const DEFAULT_REMINDER_SNAP_RADIUS_PX = 34;

export type StaticMapPoint = {
  lat: number;
  lon: number;
  value?: number;
  color?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  opacity?: number;
  /**
   * When true, draws a soft radial splat (heatmap) using `fill` as the center color
   * instead of a solid disk. Overlapping splats blend for a continuous field.
   */
  heatmapSplat?: boolean;
};

function heatmapGradientId(fillColor: string): string {
  return `hm-${fillColor.replace(/#/g, '')}`;
}

export type StaticMapOverlayProps = {
  mapImage: ImageSourcePropType;
  bounds: GeoBounds;
  points: StaticMapPoint[];
  /** Viewport width / height (visible area). */
  width: number;
  height: number;
  connectPoints?: boolean;
  circleRadius?: number;
  polylineStroke?: string;
  polylineStrokeWidth?: number;
  getColor?: MetricColorFn;
  noValueColor?: string;
  selected?: { lat: number; lon: number } | null;
  /** Saved air-quality reminder location — shown as a bell; taps nearby snap to this point. */
  reminderPin?: { lat: number; lon: number } | null;
  reminderSnapRadiusPx?: number;
  onPress?: (lat: number, lon: number, detail: { pageX: number; pageY: number }) => void;
};

const DEFAULT_POLY_STROKE = '#1e293b';
const DEFAULT_NO_VALUE = '#94a3b8';

function clampPan(
  px: number,
  py: number,
  scale: number,
  vw: number,
  vh: number,
  cw: number,
  ch: number,
): { x: number; y: number } {
  'worklet';
  const w = cw * scale;
  const h = ch * scale;
  let nx = px;
  let ny = py;
  if (w <= vw) {
    nx = (vw - w) / 2;
  } else {
    nx = clamp(px, vw - w, 0);
  }
  if (h <= vh) {
    ny = (vh - h) / 2;
  } else {
    ny = clamp(py, vh - h, 0);
  }
  return { x: nx, y: ny };
}

export function StaticMapOverlay({
  mapImage,
  bounds,
  points,
  width: vw,
  height: vh,
  connectPoints = false,
  circleRadius = 5,
  polylineStroke = DEFAULT_POLY_STROKE,
  polylineStrokeWidth = 3,
  getColor = getColorFromAqi,
  noValueColor = DEFAULT_NO_VALUE,
  selected = null,
  reminderPin = null,
  reminderSnapRadiusPx = DEFAULT_REMINDER_SNAP_RADIUS_PX,
  onPress,
}: StaticMapOverlayProps) {
  const [decodeError, setDecodeError] = useState(false);

  const { cw, ch } = useMemo(() => {
    if (typeof mapImage === 'number') {
      const d = Image.resolveAssetSource(mapImage);
      return { cw: d?.width ?? 1024, ch: d?.height ?? 1024 };
    }
    return { cw: 1024, ch: 1024 };
  }, [mapImage]);

  const totalScale = useSharedValue(1);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const minScale = useSharedValue(1);
  const maxScale = useSharedValue(1);

  const pinchStartScale = useSharedValue(1);
  const panStart = useSharedValue({ x: 0, y: 0 });

  useEffect(() => {
    setDecodeError(false);
  }, [mapImage]);

  useEffect(() => {
    if (!(vw > 0) || !(vh > 0) || !(cw > 0) || !(ch > 0)) return;
    /** Cover viewport (no letterboxing): image always fills width and height; excess is pannable. */
    const cover = Math.max(vw / cw, vh / ch);
    minScale.value = cover;
    maxScale.value = cover * MAX_ZOOM_FACTOR;
    totalScale.value = cover;
    panX.value = (vw - cw * cover) / 2;
    panY.value = (vh - ch * cover) / 2;
  }, [vw, vh, cw, ch]);

  const resolved = useMemo(() => {
    const heatmapCount = points.filter((p) => p.heatmapSplat).length;
    const gridApprox =
      heatmapCount > 0 ? Math.max(16, Math.ceil(Math.sqrt(heatmapCount))) : KRIGING_SPLAT_DENSITY_HINT;
    const defaultSplatR = Math.max(14, (Math.min(cw, ch) / gridApprox) * 1.85);

    const pixelPts = points.map((p) => {
      const { x, y } = latLonToPixel(p.lat, p.lon, bounds, cw, ch);
      const v = p.value;
      const fill =
        p.color ?? (v !== undefined && Number.isFinite(v) ? getColor(v) : noValueColor);
      const r = p.heatmapSplat ? (p.radius ?? defaultSplatR) : (p.radius ?? circleRadius);
      return { ...p, x, y, fill, r };
    });

    const heatColors = Array.from(
      new Set(pixelPts.filter((p) => p.heatmapSplat).map((p) => p.fill)),
    );

    const polylinePoints =
      connectPoints && pixelPts.length >= 2
        ? pixelPts.map((p) => `${p.x},${p.y}`).join(' ')
        : null;

    let selectedPx: { x: number; y: number } | null = null;
    if (selected != null && Number.isFinite(selected.lat) && Number.isFinite(selected.lon)) {
      selectedPx = latLonToPixel(selected.lat, selected.lon, bounds, cw, ch);
    }

    let reminderPx: { x: number; y: number } | null = null;
    if (reminderPin != null && Number.isFinite(reminderPin.lat) && Number.isFinite(reminderPin.lon)) {
      reminderPx = latLonToPixel(reminderPin.lat, reminderPin.lon, bounds, cw, ch);
    }

    const heatmapPts = pixelPts.filter((p) => p.heatmapSplat);
    const markerPts = pixelPts.filter((p) => !p.heatmapSplat);

    return { heatmapPts, markerPts, heatColors, polylinePoints, selectedPx, reminderPx };
  }, [
    bounds,
    circleRadius,
    connectPoints,
    cw,
    ch,
    getColor,
    noValueColor,
    points,
    reminderPin,
    selected,
  ]);

  const firePress = useCallback(
    (cx: number, cy: number, pageX: number, pageY: number) => {
      if (onPress == null) return;
      let { lat, lon } = pixelToLatLon(cx, cy, bounds, cw, ch);
      if (reminderPin != null && Number.isFinite(reminderPin.lat) && Number.isFinite(reminderPin.lon)) {
        const rp = latLonToPixel(reminderPin.lat, reminderPin.lon, bounds, cw, ch);
        const d = Math.hypot(cx - rp.x, cy - rp.y);
        if (d <= reminderSnapRadiusPx) {
          lat = reminderPin.lat;
          lon = reminderPin.lon;
        }
      }
      onPress(lat, lon, { pageX, pageY });
    },
    [onPress, bounds, cw, ch, reminderPin, reminderSnapRadiusPx],
  );

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          panStart.value = { x: panX.value, y: panY.value };
        })
        .onUpdate((e) => {
          const next = clampPan(
            panStart.value.x + e.translationX,
            panStart.value.y + e.translationY,
            totalScale.value,
            vw,
            vh,
            cw,
            ch,
          );
          panX.value = next.x;
          panY.value = next.y;
        }),
    [vw, vh, cw, ch],
  );

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onStart(() => {
          pinchStartScale.value = totalScale.value;
        })
        .onUpdate((e) => {
          const next = clamp(pinchStartScale.value * e.scale, minScale.value, maxScale.value);
          totalScale.value = next;
          const c = clampPan(panX.value, panY.value, next, vw, vh, cw, ch);
          panX.value = c.x;
          panY.value = c.y;
        }),
    [vw, vh, cw, ch],
  );

  const tapGesture = useMemo(() => {
    return Gesture.Tap()
      .maxDistance(14)
      .onEnd((e) => {
        const cx = (e.x - panX.value) / totalScale.value;
        const cy = (e.y - panY.value) / totalScale.value;
        runOnJS(firePress)(cx, cy, e.absoluteX, e.absoluteY);
      });
  }, [firePress]);

  const composed = useMemo(() => {
    const zoom = Gesture.Simultaneous(panGesture, pinchGesture);
    if (onPress == null) return zoom;
    return Gesture.Simultaneous(zoom, tapGesture);
  }, [panGesture, pinchGesture, tapGesture, onPress]);

  const mapLayerStyle = useAnimatedStyle(() => ({
    position: 'absolute',
    left: panX.value,
    top: panY.value,
    width: cw * totalScale.value,
    height: ch * totalScale.value,
  }));

  if (!(vw > 0) || !(vh > 0)) {
    return <View style={[styles.container, { width: vw, height: vh }]} />;
  }

  const inner = (
    <View style={[styles.container, { width: vw, height: vh }]} pointerEvents="box-none">
      <LinearGradient
        colors={['#dbeafe', '#bfdbfe', '#94a3b8']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />

      <GestureDetector gesture={composed}>
        <Animated.View style={[styles.viewport, { width: vw, height: vh }]}>
          {!decodeError ? (
            <Animated.View style={mapLayerStyle}>
              <Image
                source={mapImage}
                style={styles.fillContain}
                resizeMode="cover"
                onError={() => setDecodeError(true)}
              />
              <Svg
                style={StyleSheet.absoluteFillObject}
                width="100%"
                height="100%"
                viewBox={`0 0 ${cw} ${ch}`}
                preserveAspectRatio="xMidYMid meet"
              >
                <Defs>
                  {resolved.heatColors.map((c) => (
                    <RadialGradient
                      key={c}
                      id={heatmapGradientId(c)}
                      cx="50%"
                      cy="50%"
                      r="50%"
                      fx="50%"
                      fy="50%"
                      gradientUnits="objectBoundingBox"
                    >
                      <Stop offset="0%" stopColor={c} stopOpacity={0.12} />
                      <Stop offset="45%" stopColor={c} stopOpacity={0.035} />
                      <Stop offset="100%" stopColor={c} stopOpacity={0} />
                    </RadialGradient>
                  ))}
                </Defs>

                {resolved.polylinePoints ? (
                  <Polyline
                    points={resolved.polylinePoints}
                    fill="none"
                    stroke={polylineStroke}
                    strokeWidth={polylineStrokeWidth}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ) : null}

                {resolved.heatmapPts.map((p, i) => (
                  <Circle
                    key={`heat-${i}`}
                    cx={p.x}
                    cy={p.y}
                    r={p.r}
                    fill={`url(#${heatmapGradientId(p.fill)})`}
                    fillOpacity={Math.min(1, (p.opacity ?? 1) * 0.72)}
                  />
                ))}

                {resolved.markerPts.map((p, i) => (
                  <Circle
                    key={`pt-${i}`}
                    cx={p.x}
                    cy={p.y}
                    r={p.r}
                    fill={p.fill}
                    fillOpacity={p.opacity ?? 1}
                    stroke={p.stroke ?? 'none'}
                    strokeWidth={p.stroke != null ? (p.strokeWidth ?? 1.5) : 0}
                  />
                ))}

                {resolved.reminderPx ? (
                  <G
                    transform={`translate(${resolved.reminderPx.x - 12 * 1.35}, ${resolved.reminderPx.y - 22 * 1.35}) scale(1.35)`}
                  >
                    <Path
                      d={REMINDER_BELL_PATH}
                      fill="#0f172a"
                      stroke="#ffffff"
                      strokeWidth={1.15}
                      strokeLinejoin="round"
                    />
                  </G>
                ) : null}

                {resolved.selectedPx ? (
                  <Polygon
                    points={`${resolved.selectedPx.x},${resolved.selectedPx.y} ${resolved.selectedPx.x - 9},${resolved.selectedPx.y - 16} ${resolved.selectedPx.x + 9},${resolved.selectedPx.y - 16}`}
                    fill="#dc2626"
                  />
                ) : null}
              </Svg>
            </Animated.View>
          ) : (
            <View style={[styles.viewport, styles.fallback]} />
          )}
        </Animated.View>
      </GestureDetector>
    </View>
  );

  return inner;
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#e8f0fe',
  },
  viewport: {
    overflow: 'hidden',
  },
  fillContain: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  fallback: {
    flex: 1,
    backgroundColor: '#e2e8f0',
  },
});

export { latLonToPixel, pixelToLatLon, type GeoBounds } from '../lib/geoPixel';
export { getColorFromAqi, getColorFromPm25, type MetricColorFn } from '../lib/metricColor';
