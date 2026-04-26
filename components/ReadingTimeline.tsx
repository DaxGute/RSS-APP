import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TimelineCalendarModal } from './TimelineCalendarModal';

const VISIBLE_OFFSETS = [-3, -2, -1, 0, 1, 2, 3] as const;
const ARC_START_DEG = 0;
const ARC_END_DEG = 90;
const ARC_CENTER_DEG = 45;
const ARC_STEP_DEG = 14;
const ARC_RADIUS = 84;
const ARC_CENTER_X = 95;
const ARC_CENTER_Y = 95;
const DATE_HUB_RADIUS = 59;
const ARC_INPUT_MIN_DEG = 8;
const ARC_INPUT_MAX_DEG = 82;
const ARC_VISUAL_MIN_DEG = 6;
const ARC_VISUAL_MAX_DEG = 84;
const ARC_GESTURE_MIN_DEG = -12;
const ARC_GESTURE_MAX_DEG = 102;
const DRAG_EASING = 0.24;
const ANGLE_DEADZONE_DEG = 1.2;
const ENDPOINT_SNAP_DEG = 10;

function formatDialTime(iso: string): string {
  try {
    const readingTime = new Date(iso);
    if (!Number.isFinite(readingTime.getTime())) return '';
    return readingTime.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function dateKeyLocal(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateButtonLabel(iso: string | null): string {
  if (!iso) return 'today';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'today';
  if (dateKeyLocal(date) === dateKeyLocal(new Date())) return 'today';
  const mm = `${date.getMonth() + 1}`.padStart(2, '0');
  const dd = `${date.getDate()}`.padStart(2, '0');
  const yy = `${date.getFullYear()}`.slice(-2);
  return `${mm}/${dd}/${yy}`;
}

function polarToCartesian(angleDeg: number, radius: number) {
  const theta = (angleDeg * Math.PI) / 180;
  return {
    x: ARC_CENTER_X + Math.cos(theta) * radius,
    y: ARC_CENTER_Y + Math.sin(theta) * radius,
  };
}

export type ReadingTimelineProps = {
  timesAsc: string[];
  selectedIndex: number;
  onChangeIndex: (index: number) => void;
  loading?: boolean;
  onPickRecordedTime?: (recordedTime: string) => void;
  liveAverageAqi?: number | null;
  todayRecordedTime?: string | null;
  timelineScrollable?: boolean;
};

export function ReadingTimeline({
  timesAsc,
  selectedIndex,
  onChangeIndex,
  loading = false,
  onPickRecordedTime,
  liveAverageAqi = null,
  todayRecordedTime = null,
  timelineScrollable = true,
}: ReadingTimelineProps) {
  const insets = useSafeAreaInsets();
  const calendarButtonScale = useRef(new Animated.Value(1)).current;
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [dragProgress, setDragProgress] = useState<number | null>(null);
  const dragProgressRef = useRef<number | null>(null);
  const dragTargetRef = useRef<number | null>(null);
  const pendingProgressRef = useRef<number | null>(null);
  const dragRafRef = useRef<number | null>(null);

  const maxIdx = Math.max(0, timesAsc.length - 1);
  const safeIndex = Math.min(Math.max(0, selectedIndex), maxIdx);
  const displayProgress = dragProgress ?? safeIndex;

  const selectedIso = timesAsc[Math.round(displayProgress)] ?? null;
  const showTodayButton = useMemo(() => {
    if (!onPickRecordedTime || !selectedIso) return false;
    const selectedDate = new Date(selectedIso);
    if (!Number.isFinite(selectedDate.getTime())) return false;
    return dateKeyLocal(selectedDate) !== dateKeyLocal(new Date());
  }, [onPickRecordedTime, selectedIso]);
  const dateButtonLabel = useMemo(() => formatDateButtonLabel(selectedIso), [selectedIso]);

  const arcLabels = useMemo(() => {
    const out: Array<{ index: number; offsetFloat: number; angle: number; x: number; y: number; label: string }> = [];
    const centerIndex = Math.round(displayProgress);
    for (const offset of VISIBLE_OFFSETS) {
      const index = centerIndex + offset;
      if (index < 0 || index > maxIdx) continue;
      const offsetFloat = index - displayProgress;
      const angle = Math.max(
        ARC_VISUAL_MIN_DEG,
        Math.min(ARC_VISUAL_MAX_DEG, ARC_CENTER_DEG + offsetFloat * ARC_STEP_DEG),
      );
      const point = polarToCartesian(angle, ARC_RADIUS);
      const label = formatDialTime(timesAsc[index] ?? '');
      out.push({ index, offsetFloat, angle, x: point.x, y: point.y, label });
    }
    return out;
  }, [displayProgress, maxIdx, timesAsc]);

  const arcMarkers = useMemo(() => {
    const markers: Array<{ id: string; x: number; y: number; active: boolean }> = [];
    const steps = 12;
    const selectedAngle = ARC_START_DEG + ((maxIdx - displayProgress) / Math.max(1, maxIdx)) * (ARC_END_DEG - ARC_START_DEG);
    for (let i = 0; i <= steps; i += 1) {
      const angle = ARC_START_DEG + (i / steps) * (ARC_END_DEG - ARC_START_DEG);
      const p = polarToCartesian(angle, DATE_HUB_RADIUS);
      markers.push({
        id: `m-${i}`,
        x: p.x,
        y: p.y,
        active: Math.abs(angle - selectedAngle) < 4,
      });
    }
    return markers;
  }, [displayProgress, maxIdx]);

  useEffect(() => {
    dragProgressRef.current = dragProgress;
  }, [dragProgress]);

  useEffect(() => {
    return () => {
      if (dragRafRef.current != null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
    };
  }, []);

  const openCalendar = useCallback(() => {
    if (!onPickRecordedTime) return;
    Animated.sequence([
      Animated.timing(calendarButtonScale, { toValue: 0.94, duration: 80, useNativeDriver: true }),
      Animated.spring(calendarButtonScale, {
        toValue: 1,
        damping: 12,
        stiffness: 220,
        mass: 0.9,
        useNativeDriver: true,
      }),
    ]).start();
    setCalendarOpen(true);
  }, [calendarButtonScale, onPickRecordedTime]);

  const closeCalendar = useCallback(() => {
    setCalendarOpen(false);
  }, []);

  const pickIndexFromArcPoint = useCallback(
    (x: number, y: number) => {
      if (!timelineScrollable || maxIdx <= 0) return;
      const center = 95;
      const dx = x - center;
      const dy = y - center;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const rawAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (rawAngle < ARC_GESTURE_MIN_DEG || rawAngle > ARC_GESTURE_MAX_DEG) return;
      const clampedAngle = Math.max(0, Math.min(90, rawAngle));
      const progress =
        clampedAngle <= ARC_INPUT_MIN_DEG
          ? 0
          : clampedAngle >= ARC_INPUT_MAX_DEG
            ? 1
            : (clampedAngle - ARC_INPUT_MIN_DEG) / (ARC_INPUT_MAX_DEG - ARC_INPUT_MIN_DEG);
      const idxFloat = maxIdx * (1 - progress);
      const targetFloat = Math.max(0, Math.min(maxIdx, idxFloat));
      dragTargetRef.current = targetFloat;
      const nearLatestEnd = clampedAngle <= ENDPOINT_SNAP_DEG;
      const nearEarliestEnd = clampedAngle >= 90 - ENDPOINT_SNAP_DEG;
      if (nearLatestEnd || nearEarliestEnd) {
        pendingProgressRef.current = nearLatestEnd ? maxIdx : 0;
        setDragProgress(pendingProgressRef.current);
        return;
      }
      const currentFloat = dragProgressRef.current ?? safeIndex;
      const delta = targetFloat - currentFloat;
      if (Math.abs(delta) < (maxIdx / 90) * ANGLE_DEADZONE_DEG) return;
      const smoothedFloat = currentFloat + delta * DRAG_EASING;
      pendingProgressRef.current = smoothedFloat;
      if (dragRafRef.current != null) return;
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
        if (pendingProgressRef.current == null) return;
        setDragProgress(pendingProgressRef.current);
      });
    },
    [maxIdx, safeIndex, timelineScrollable],
  );

  const radialPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) =>
          timelineScrollable && (Math.abs(gestureState.dx) > 2 || Math.abs(gestureState.dy) > 2),
        onStartShouldSetPanResponder: () => timelineScrollable,
        onPanResponderGrant: (e) => {
          pickIndexFromArcPoint(e.nativeEvent.locationX, e.nativeEvent.locationY);
        },
        onPanResponderMove: (e) => {
          pickIndexFromArcPoint(e.nativeEvent.locationX, e.nativeEvent.locationY);
        },
        onPanResponderRelease: () => {
          const committed = dragTargetRef.current ?? dragProgressRef.current;
          if (committed != null) {
            onChangeIndex(Math.round(committed));
            setDragProgress(null);
          }
          dragTargetRef.current = null;
          pendingProgressRef.current = null;
        },
        onPanResponderTerminate: () => {
          const committed = dragTargetRef.current ?? dragProgressRef.current;
          if (committed != null) {
            onChangeIndex(Math.round(committed));
            setDragProgress(null);
          }
          dragTargetRef.current = null;
          pendingProgressRef.current = null;
        },
      }),
    [onChangeIndex, pickIndexFromArcPoint, timelineScrollable],
  );

  if (timesAsc.length === 0) {
    return null;
  }

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          paddingTop: Math.max(insets.top, 6),
        },
      ]}
    >
      <View style={styles.orbitWrap} pointerEvents="box-none">
        <View style={styles.dateHub} pointerEvents="box-none">
          {loading ? <ActivityIndicator size="small" color="#475569" style={styles.spinner} /> : null}
          {onPickRecordedTime ? (
            <Animated.View style={{ transform: [{ scale: calendarButtonScale }] }}>
              <Pressable
                onPress={openCalendar}
                style={({ pressed }) => [styles.calendarButton, pressed && styles.calendarButtonPressed]}
                accessibilityRole="button"
                accessibilityLabel="Open date calendar"
              >
                <Ionicons name="calendar-outline" size={18} color="#1f2937" />
                <Text style={styles.calendarButtonText}>{dateButtonLabel}</Text>
              </Pressable>
            </Animated.View>
          ) : null}
        </View>
        {showTodayButton ? (
          <Pressable
            onPress={() => {
              if (onPickRecordedTime && todayRecordedTime) {
                onPickRecordedTime(todayRecordedTime);
                return;
              }
              onChangeIndex(maxIdx);
            }}
            style={({ pressed }) => [styles.todayButton, pressed && styles.calendarButtonPressed]}
            accessibilityRole="button"
            accessibilityLabel="Jump to latest reported readings"
          >
            <Text style={styles.todayButtonText}>Today</Text>
          </Pressable>
        ) : null}
        <View style={styles.arcScrollerShell}>
          <View style={styles.arcGestureLayer} {...(timelineScrollable ? radialPanResponder.panHandlers : {})} />
          {arcMarkers.map((marker) => (
            <View
              key={marker.id}
              pointerEvents="none"
              style={[
                styles.arcMarker,
                marker.active && styles.arcMarkerActive,
                { left: marker.x - 3, top: marker.y - 3 },
              ]}
            />
          ))}
          {arcLabels.map((slot) => (
            <Pressable
              key={`${slot.index}-${slot.angle}`}
              pointerEvents="auto"
              onPress={() => {
                if (Math.abs(slot.offsetFloat) > 1.1) return;
                onChangeIndex(slot.index);
              }}
              style={[
                styles.arcLabelSlot,
                {
                  left: slot.x - 30,
                  top: slot.y - 12,
                  opacity: Math.max(0, 1 - Math.abs(slot.offsetFloat) * 0.32),
                  transform: [
                    { rotate: `${slot.angle - 45}deg` },
                    {
                      scale:
                        Math.abs(slot.offsetFloat) < 0.18
                          ? 1.18
                          : Math.max(0.72, 1 - Math.abs(slot.offsetFloat) * 0.12),
                    },
                  ],
                },
              ]}
            >
              <Text style={styles.dialText} numberOfLines={1}>
                {slot.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {onPickRecordedTime ? (
        <TimelineCalendarModal
          visible={calendarOpen}
          onClose={closeCalendar}
          timelineTimesAsc={timesAsc}
          timelineIndex={safeIndex}
          onPickRecordedTime={onPickRecordedTime}
          liveAverageAqi={liveAverageAqi}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    zIndex: 30,
    backgroundColor: 'transparent',
    alignItems: 'flex-start',
    paddingLeft: 8,
  },
  orbitWrap: {
    position: 'relative',
    width: 220,
    height: 220,
  },
  dateHub: {
    position: 'absolute',
    left: 34,
    top: 34,
    width: 118,
    height: 118,
    borderRadius: 59,
    backgroundColor: 'rgba(255,255,255,0.94)',
    shadowColor: '#0f172a',
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9,
  },
  spinner: { position: 'absolute', top: 8, right: 8 },
  calendarButton: {
    minHeight: 42,
    paddingHorizontal: 16,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    shadowColor: '#1e293b',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  calendarButtonPressed: {
    opacity: 0.88,
    transform: [{ translateY: 0.5 }],
  },
  calendarButtonText: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.2,
    color: '#334155',
  },
  todayButton: {
    position: 'absolute',
    left: 136,
    top: 126,
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1e3a8a',
    borderWidth: 1,
    borderColor: '#1d4ed8',
    shadowColor: '#020617',
    shadowOpacity: 0.2,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  todayButtonText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
    color: '#ffffff',
  },
  arcScrollerShell: {
    position: 'absolute',
    left: -2,
    top: -2,
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: 'transparent',
    overflow: 'visible',
    zIndex: 4,
  },
  arcGestureLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5,
    backgroundColor: 'transparent',
  },
  arcMarker: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(148,163,184,0.55)',
  },
  arcMarkerActive: {
    backgroundColor: '#1e3a8a',
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  arcLabelSlot: {
    position: 'absolute',
    width: 78,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'center',
    textShadowColor: 'rgba(255,255,255,0.92)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
});
