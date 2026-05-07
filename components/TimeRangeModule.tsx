import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  LayoutChangeEvent,
  PanResponder,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { ClipPath, Defs, G, Line, Path, Rect } from 'react-native-svg';
import { aqiCategory } from '../lib/aqiUtils';

export type TimeRangePoint = {
  time: string;
  avgAqi: number;
  /** Normalized position along scrub axis [0..1]. */
  position: number;
  /** Time to load for preview/commit; can be null for missing-data buckets. */
  selectableTime?: string | null;
};

export type TimeRangeTick = {
  position: number;
  label: string;
};

type TimeRangeModuleProps = {
  points: TimeRangePoint[];
  active: boolean;
  loading?: boolean;
  selectedPosition?: number | null;
  onCommitTime: (timeIso: string) => void;
  onPreviewTime?: (timeIso: string) => void;
  ticks?: TimeRangeTick[];
  compact?: boolean;
  graphOnly?: boolean;
  chartLength?: number;
  orientation?: 'horizontal' | 'vertical';
  topLabel?: string | null;
  markerLabel?: string | null;
};

const CHART_HEIGHT = 72;
const CHART_PADDING_X = 8;
const CHART_PADDING_Y = 8;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function desaturateHex(hex: string, amount01: number): string {
  const amt = clamp(amount01, 0, 1);
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return hex;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const nr = Math.round(r + (gray - r) * amt);
  const ng = Math.round(g + (gray - g) * amt);
  const nb = Math.round(b + (gray - b) * amt);
  return `rgb(${nr},${ng},${nb})`;
}

export function TimeRangeModule({
  points,
  active,
  loading = false,
  selectedPosition = null,
  onCommitTime,
  onPreviewTime,
  ticks = [],
  compact = false,
  graphOnly = false,
  chartLength,
  orientation = 'horizontal',
  topLabel = 'now',
  markerLabel = null,
}: TimeRangeModuleProps) {
  const [layoutW, setLayoutW] = useState(0);
  const [layoutH, setLayoutH] = useState(0);
  const [dragX, setDragX] = useState<number | null>(null);
  const dragXRef = useRef<number | null>(null);
  const lastPreviewTimeRef = useRef<string | null>(null);

  const normalized = useMemo(() => {
    const clean = points.filter((p) => Number.isFinite(p.avgAqi));
    if (clean.length === 0) {
      return {
        values: [] as Array<{
          x: number;
          y: number;
          time: string;
          avgAqi: number;
          selectableTime?: string | null;
        }>,
        minAqi: 0,
        maxAqi: 300,
      };
    }
    const minAqi = Math.min(...clean.map((p) => p.avgAqi));
    const maxAqi = Math.max(...clean.map((p) => p.avgAqi));
    const span = Math.max(10, maxAqi - minAqi);
    const paddedMin = Math.max(0, minAqi - span * 0.15);
    const paddedMax = maxAqi + span * 0.15;
    const valueSpan = Math.max(1, paddedMax - paddedMin);
    const usableW = Math.max(1, layoutW - CHART_PADDING_X * 2);
    const usableH = Math.max(1, layoutH - CHART_PADDING_Y * 2);
    const values = clean.map((p) => {
      const frac = clamp(p.position, 0, 1);
      if (orientation === 'vertical') {
        const y = CHART_PADDING_Y + usableH * frac;
        const x = CHART_PADDING_X + usableW * (1 - (p.avgAqi - paddedMin) / valueSpan);
        return { ...p, x, y };
      }
      const x = CHART_PADDING_X + usableW * frac;
      const y = CHART_PADDING_Y + usableH * (1 - (p.avgAqi - paddedMin) / valueSpan);
      return { ...p, x, y };
    });
    return { values };
  }, [layoutH, layoutW, orientation, points]);

  const selectedPos = useMemo(() => {
    if (selectedPosition == null || !(layoutW > 0) || !(layoutH > 0)) return null;
    const frac = clamp(selectedPosition, 0, 1);
    if (orientation === 'vertical') {
      const y = CHART_PADDING_Y + Math.max(1, layoutH - CHART_PADDING_Y * 2) * frac;
      return { x: null as number | null, y };
    }
    const x = CHART_PADDING_X + Math.max(1, layoutW - CHART_PADDING_X * 2) * frac;
    return { x, y: null as number | null };
  }, [layoutH, layoutW, orientation, selectedPosition]);

  const lineSegments = useMemo(() => {
    const pts = normalized.values;
    if (pts.length < 2) return [] as Array<{ key: string; x1: number; y1: number; x2: number; y2: number; color: string }>;
    const out: Array<{ key: string; x1: number; y1: number; x2: number; y2: number; color: string }> = [];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const meanAqi = (p1.avgAqi + p2.avgAqi) / 2;
      out.push({ key: `seg-${i}`, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, color: active ? aqiCategory(meanAqi).bg : '#94a3b8' });
    }
    return out;
  }, [active, normalized.values]);

  const areaPathD = useMemo(() => {
    const pts = normalized.values;
    if (pts.length < 2) return null;
    if (orientation === 'vertical') {
      const rightX = CHART_PADDING_X + Math.max(1, layoutW - CHART_PADDING_X * 2);
      const poly = pts.map((p) => `${p.x} ${p.y}`).join(' L ');
      return `M ${pts[0].x} ${pts[0].y} L ${poly} L ${rightX} ${pts[pts.length - 1].y} L ${rightX} ${pts[0].y} Z`;
    }
    const bottomY = CHART_HEIGHT - CHART_PADDING_Y;
    const poly = pts.map((p) => `${p.x} ${p.y}`).join(' L ');
    return `M ${pts[0].x} ${pts[0].y} L ${poly} L ${pts[pts.length - 1].x} ${bottomY} L ${pts[0].x} ${bottomY} Z`;
  }, [layoutW, normalized.values, orientation]);

  const nearestPointForMain = (main: number) => {
    if (normalized.values.length === 0) return null;
    let best = normalized.values[0];
    let bestDist = Math.abs((orientation === 'vertical' ? best.y : best.x) - main);
    for (let i = 1; i < normalized.values.length; i += 1) {
      const c = normalized.values[i];
      const d = Math.abs((orientation === 'vertical' ? c.y : c.x) - main);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => active,
        onMoveShouldSetPanResponder: () => active,
        onStartShouldSetPanResponderCapture: () => active,
        onMoveShouldSetPanResponderCapture: () => active,
        onPanResponderGrant: (e) => {
          const mainRaw = orientation === 'vertical' ? e.nativeEvent.locationY : e.nativeEvent.locationX;
          const main = clamp(
            mainRaw,
            orientation === 'vertical' ? CHART_PADDING_Y : CHART_PADDING_X,
            Math.max(
              orientation === 'vertical' ? CHART_PADDING_Y : CHART_PADDING_X,
              (orientation === 'vertical' ? layoutH : layoutW) -
                (orientation === 'vertical' ? CHART_PADDING_Y : CHART_PADDING_X),
            ),
          );
          dragXRef.current = main;
          setDragX(main);
          const nearest = nearestPointForMain(main);
          const targetTime = nearest?.selectableTime ?? null;
          if (targetTime && targetTime !== lastPreviewTimeRef.current) {
            lastPreviewTimeRef.current = targetTime;
            onPreviewTime?.(targetTime);
          }
        },
        onPanResponderMove: (e) => {
          const mainRaw = orientation === 'vertical' ? e.nativeEvent.locationY : e.nativeEvent.locationX;
          const main = clamp(
            mainRaw,
            orientation === 'vertical' ? CHART_PADDING_Y : CHART_PADDING_X,
            Math.max(
              orientation === 'vertical' ? CHART_PADDING_Y : CHART_PADDING_X,
              (orientation === 'vertical' ? layoutH : layoutW) -
                (orientation === 'vertical' ? CHART_PADDING_Y : CHART_PADDING_X),
            ),
          );
          dragXRef.current = main;
          setDragX(main);
          const nearest = nearestPointForMain(main);
          const targetTime = nearest?.selectableTime ?? null;
          if (targetTime && targetTime !== lastPreviewTimeRef.current) {
            lastPreviewTimeRef.current = targetTime;
            onPreviewTime?.(targetTime);
          }
        },
        onPanResponderRelease: () => {
          if (!active || dragXRef.current == null) {
            setDragX(null);
            return;
          }
          const nearest = nearestPointForMain(dragXRef.current);
          const targetTime = nearest?.selectableTime ?? null;
          if (targetTime) onCommitTime(targetTime);
          dragXRef.current = null;
          setDragX(null);
          lastPreviewTimeRef.current = null;
        },
        onPanResponderTerminate: () => {
          dragXRef.current = null;
          setDragX(null);
          lastPreviewTimeRef.current = null;
        },
      }),
    [active, layoutH, layoutW, normalized.values, onCommitTime, onPreviewTime, orientation],
  );

  const markerMain = dragX ?? (orientation === 'vertical' ? selectedPos?.y : selectedPos?.x);
  const markerLabelWidth = 88;
  const markerLabelLeft =
    markerMain == null ? 0 : clamp(markerMain - markerLabelWidth / 2, 0, Math.max(0, layoutW - markerLabelWidth));

  const onLayout = (e: LayoutChangeEvent) => {
    const w = chartLength ?? e.nativeEvent.layout.width;
    const h = e.nativeEvent.layout.height;
    if (w > 0 && w !== layoutW) setLayoutW(w);
    if (h > 0 && h !== layoutH) setLayoutH(h);
  };

  const resolvedWidth = chartLength ?? '100%';
  const marks =
    ticks.length > 0
      ? ticks
      : [
          { position: 0, label: '12a' },
          { position: 0.25, label: '6a' },
          { position: 0.5, label: '12p' },
          { position: 0.75, label: '6p' },
        ];

  return (
    <View
      style={[
        graphOnly ? styles.graphOnlyWrap : styles.card,
        compact && !graphOnly && styles.cardCompact,
        !active && !graphOnly && styles.cardDisabled,
      ]}
    >
      {!graphOnly ? (
        <View style={styles.headerRow}>
          <Text style={[styles.title, !active && styles.titleDisabled]}>Time range</Text>
          {loading ? <ActivityIndicator size="small" color="#475569" /> : null}
        </View>
      ) : null}
      {!graphOnly ? (
        <Text style={[styles.subtitle, compact && styles.subtitleCompact, !active && styles.subtitleDisabled]}>
          Avg AQI across sensors
        </Text>
      ) : null}
      <View
        onLayout={onLayout}
        style={[
          styles.chartWrap,
          graphOnly && { width: resolvedWidth },
          orientation === 'vertical' && { width: chartLength ?? '100%', height: '100%' },
        ]}
        {...(active ? panResponder.panHandlers : {})}
      >
        {topLabel ? (
          <Text
            style={[
              styles.nowLabel,
              orientation === 'vertical' && styles.nowLabelVertical,
              !active && styles.nowLabelDisabled,
            ]}
          >
            {topLabel}
          </Text>
        ) : null}
        {markerMain != null && markerLabel ? (
          <Text
            style={[
              styles.markerLabel,
              !active && styles.markLabelDisabled,
              orientation === 'vertical'
                ? { top: markerMain - 8, left: CHART_PADDING_X + 2 }
                : { left: markerLabelLeft },
            ]}
            numberOfLines={1}
          >
            {markerLabel}
          </Text>
        ) : null}
        {marks.map((tick) => {
          const xOrY =
            (orientation === 'vertical' ? CHART_PADDING_Y : CHART_PADDING_X) +
            (Math.max(
              1,
              (orientation === 'vertical' ? layoutH : layoutW) -
                (orientation === 'vertical' ? CHART_PADDING_Y : CHART_PADDING_X) * 2,
            ) *
              clamp(tick.position, 0, 1) || 0);
          return (
            <Text
              key={`top-lbl-${tick.label}-${tick.position}`}
              style={[
                styles.topMarkLabel,
                !active && styles.markLabelDisabled,
                {
                  ...(orientation === 'vertical'
                    ? { top: xOrY - 7, left: 2, width: 28 }
                    : { left: xOrY - 12 }),
                },
              ]}
            >
              {tick.label}
            </Text>
          );
        })}
        <Svg width="100%" height="100%">
          {markerMain != null && layoutW > 0 && layoutH > 0 ? (
            <Defs>
              <ClipPath id="afterClip">
                <Rect
                  x={orientation === 'vertical' ? 0 : markerMain}
                  y={orientation === 'vertical' ? 0 : 0}
                  width={orientation === 'vertical' ? layoutW : Math.max(0, layoutW - markerMain)}
                  height={orientation === 'vertical' ? Math.max(0, markerMain) : layoutH}
                />
              </ClipPath>
            </Defs>
          ) : null}

          {areaPathD ? (
            <Path d={areaPathD} fill={active ? 'rgba(15, 23, 42, 0.28)' : 'rgba(100, 116, 139, 0.22)'} />
          ) : null}

          {marks.map((tick) => {
            const xOrY =
              (orientation === 'vertical' ? CHART_PADDING_Y : CHART_PADDING_X) +
              (Math.max(
                1,
                (orientation === 'vertical' ? layoutH : layoutW) -
                  (orientation === 'vertical' ? CHART_PADDING_Y : CHART_PADDING_X) * 2,
              ) *
                clamp(tick.position, 0, 1) || 0);
            return (
              <Line
                key={`mark-${tick.label}-${tick.position}`}
                x1={orientation === 'vertical' ? CHART_PADDING_X : xOrY}
                x2={orientation === 'vertical' ? layoutW - CHART_PADDING_X : xOrY}
                y1={orientation === 'vertical' ? xOrY : CHART_PADDING_Y}
                y2={orientation === 'vertical' ? xOrY : CHART_HEIGHT - CHART_PADDING_Y}
                stroke={active ? 'rgba(100,116,139,0.32)' : 'rgba(148,163,184,0.45)'}
                strokeWidth={1}
              />
            );
          })}
          {lineSegments.map((seg) => (
            <Line
              key={`${seg.key}-outline`}
              x1={seg.x1}
              y1={seg.y1}
              x2={seg.x2}
              y2={seg.y2}
              stroke={active ? 'rgba(2, 6, 23, 0.75)' : 'rgba(71, 85, 105, 0.65)'}
              strokeWidth={6}
              strokeLinecap="round"
            />
          ))}
          {lineSegments.map((seg) => (
            <Line
              key={seg.key}
              x1={seg.x1}
              y1={seg.y1}
              x2={seg.x2}
              y2={seg.y2}
              stroke={seg.color}
              strokeWidth={3}
              strokeLinecap="round"
            />
          ))}
          {markerMain != null && layoutW > 0 && layoutH > 0 ? (
            <G clipPath="url(#afterClip)">
              {areaPathD ? (
                <Path d={areaPathD} fill={active ? 'rgba(148, 163, 184, 0.26)' : 'rgba(148, 163, 184, 0.18)'} />
              ) : null}
              {lineSegments.map((seg) => (
                <Line
                  key={`${seg.key}-outline-after`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  stroke={active ? 'rgba(15, 23, 42, 0.62)' : 'rgba(100, 116, 139, 0.55)'}
                  strokeWidth={6}
                  strokeLinecap="round"
                />
              ))}
              {lineSegments.map((seg) => (
                <Line
                  key={`${seg.key}-after`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  stroke={active ? desaturateHex(seg.color, 0.7) : '#94a3b8'}
                  strokeWidth={3}
                  strokeLinecap="round"
                />
              ))}
            </G>
          ) : null}
          {markerMain != null ? (
            <Line
              x1={orientation === 'vertical' ? CHART_PADDING_X - 1 : markerMain}
              x2={orientation === 'vertical' ? layoutW - CHART_PADDING_X + 1 : markerMain}
              y1={orientation === 'vertical' ? markerMain : CHART_PADDING_Y - 1}
              y2={orientation === 'vertical' ? markerMain : CHART_HEIGHT - CHART_PADDING_Y + 1}
              stroke={active ? '#1e293b' : '#94a3b8'}
              strokeWidth={2}
              strokeDasharray="3 4"
            />
          ) : null}
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 214,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.35)',
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 8,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 3,
  },
  graphOnlyWrap: {
    backgroundColor: 'transparent',
  },
  cardCompact: {
    width: 198,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 6,
  },
  cardDisabled: {
    backgroundColor: 'rgba(241,245,249,0.95)',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  title: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  titleDisabled: {
    color: '#64748b',
  },
  subtitle: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 6,
  },
  subtitleCompact: {
    fontSize: 9,
    marginBottom: 4,
  },
  subtitleDisabled: {
    color: '#94a3b8',
  },
  chartWrap: {
    width: '100%',
    height: CHART_HEIGHT,
    position: 'relative',
  },
  nowLabel: {
    position: 'absolute',
    top: -2,
    right: 2,
    zIndex: 2,
    fontSize: 10,
    fontWeight: '800',
    color: '#0f172a',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  nowLabelVertical: {
    left: 2,
    right: undefined,
  },
  nowLabelDisabled: {
    color: '#94a3b8',
  },
  topMarkLabel: {
    position: 'absolute',
    top: -2,
    width: 24,
    textAlign: 'center',
    zIndex: 2,
    fontSize: 10,
    fontWeight: '700',
    color: '#334155',
    fontVariant: ['tabular-nums'],
  },
  markerLabel: {
    position: 'absolute',
    top: -18,
    width: 88,
    textAlign: 'center',
    zIndex: 2,
    fontSize: 10,
    fontWeight: '800',
    color: '#0f172a',
    fontVariant: ['tabular-nums'],
  },
  markLabelDisabled: {
    color: '#94a3b8',
  },
});
