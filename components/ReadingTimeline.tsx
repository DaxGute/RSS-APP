import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TimelineCalendarModal } from './TimelineCalendarModal';

/** Horizontal slot width for each time in the dial carousel. */
const ITEM_WIDTH = 104;

function formatDialTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

type DialSlotProps = {
  index: number;
  label: string;
  scrollX: Animated.Value;
  itemWidth: number;
  onPick: () => void;
};

function DialSlot({ index, label, scrollX, itemWidth, onPick }: DialSlotProps) {
  const inputRange = useMemo(
    () => [(index - 1) * itemWidth, index * itemWidth, (index + 1) * itemWidth],
    [index, itemWidth],
  );

  const scale = useMemo(
    () =>
      scrollX.interpolate({
        inputRange,
        outputRange: [0.72, 1.22, 0.72],
        extrapolate: 'clamp',
      }),
    [scrollX, inputRange],
  );

  const opacity = useMemo(
    () =>
      scrollX.interpolate({
        inputRange,
        outputRange: [0.35, 1, 0.35],
        extrapolate: 'clamp',
      }),
    [scrollX, inputRange],
  );

  return (
    <Pressable onPress={onPick} style={{ width: itemWidth }}>
      <Animated.View style={[styles.slotInner, { opacity, transform: [{ scale }] }]}>
        <Text style={styles.dialText} numberOfLines={2}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<string>);

export type ReadingTimelineProps = {
  timesAsc: string[];
  selectedIndex: number;
  onChangeIndex: (index: number) => void;
  viewingLive: boolean;
  showCurrentDayHistoryLabel?: boolean;
  loading?: boolean;
  onPickRecordedTime?: (recordedTime: string) => void;
  liveAverageAqi?: number | null;
};

export function ReadingTimeline({
  timesAsc,
  selectedIndex,
  onChangeIndex,
  viewingLive,
  showCurrentDayHistoryLabel = true,
  loading = false,
  onPickRecordedTime,
  liveAverageAqi = null,
}: ReadingTimelineProps) {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const listRef = useRef<FlatList<string>>(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const calendarButtonScale = useRef(new Animated.Value(1)).current;
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false });
  const [calendarOpen, setCalendarOpen] = useState(false);
  const didInitialScrollRef = useRef(false);

  const maxIdx = Math.max(0, timesAsc.length - 1);
  const safeIndex = Math.min(Math.max(0, selectedIndex), maxIdx);

  const sidePad = useMemo(() => Math.max(0, (screenW - ITEM_WIDTH) / 2), [screenW]);

  const updateScrollEdges = useCallback(
    (offset: number) => {
      const maxX = maxIdx * ITEM_WIDTH;
      setScrollEdges({
        left: offset > 6,
        right: maxX > 6 && offset < maxX - 6,
      });
    },
    [maxIdx],
  );

  const scrollToIndex = useCallback(
    (index: number, animated: boolean) => {
      const clamped = Math.min(maxIdx, Math.max(0, index));
      const offset = clamped * ITEM_WIDTH;
      if (!animated) {
        scrollX.setValue(offset);
      }
      listRef.current?.scrollToOffset({ offset, animated });
      updateScrollEdges(offset);
    },
    [maxIdx, scrollX, updateScrollEdges],
  );

  const snapToIndex = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      const idx = Math.round(x / ITEM_WIDTH);
      onChangeIndex(Math.min(maxIdx, Math.max(0, idx)));
    },
    [maxIdx, onChangeIndex],
  );

  useEffect(() => {
    // First layout should lock to the selected value without visual jump.
    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      scrollToIndex(safeIndex, false);
      return;
    }
    // Subsequent index updates animate (including tap-to-jump).
    scrollToIndex(safeIndex, true);
  }, [safeIndex, scrollToIndex, timesAsc.length]);

  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
        useNativeDriver: true,
        listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          const maxX = Math.max(0, contentSize.width - layoutMeasurement.width);
          const x = contentOffset.x;
          setScrollEdges({
            left: x > 6,
            right: maxX > 6 && x < maxX - 6,
          });
        },
      }),
    [scrollX],
  );

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<string>) => (
      <DialSlot
        index={index}
        label={formatDialTime(item)}
        scrollX={scrollX}
        itemWidth={ITEM_WIDTH}
        onPick={() => {
          scrollToIndex(index, true);
          onChangeIndex(index);
        }}
      />
    ),
    [onChangeIndex, scrollToIndex, scrollX],
  );

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
      <View style={styles.metaRow} pointerEvents="box-none">
        {showCurrentDayHistoryLabel ? <Text style={styles.metaLabel}>Past 24h</Text> : null}
        {loading ? <ActivityIndicator size="small" color="#475569" style={styles.spinner} /> : null}
        {onPickRecordedTime ? (
          <Animated.View style={{ transform: [{ scale: calendarButtonScale }] }}>
            <Pressable
              onPress={openCalendar}
              style={({ pressed }) => [styles.calendarButton, pressed && styles.calendarButtonPressed]}
              accessibilityRole="button"
              accessibilityLabel="Open date calendar"
            >
              <Ionicons name="calendar-outline" size={15} color="#1f2937" />
              <Text style={styles.calendarButtonText}>Date</Text>
            </Pressable>
          </Animated.View>
        ) : null}
        {maxIdx > 0 ? (
          <Text style={styles.swipeCue} pointerEvents="none">
            Swipe
          </Text>
        ) : null}
        <Text style={[styles.metaLive, !viewingLive && styles.metaLiveDim]}>
          {viewingLive ? 'Live' : 'History'}
        </Text>
      </View>

      <View style={styles.carouselWrap}>
        {maxIdx > 0 && scrollEdges.left ? (
          <View style={[styles.edgeCue, styles.edgeCueLeft]} pointerEvents="none">
            <Ionicons name="chevron-back" size={22} color="#475569" />
          </View>
        ) : null}
        {maxIdx > 0 && scrollEdges.right ? (
          <View style={[styles.edgeCue, styles.edgeCueRight]} pointerEvents="none">
            <Ionicons name="chevron-forward" size={22} color="#475569" />
          </View>
        ) : null}

        <AnimatedFlatList
          ref={listRef}
          data={timesAsc}
          keyExtractor={(item, i) => `${item}-${i}`}
          horizontal
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={1}
          decelerationRate="fast"
          snapToInterval={ITEM_WIDTH}
          snapToAlignment="start"
          disableIntervalMomentum
          contentContainerStyle={{ paddingHorizontal: sidePad, paddingBottom: 6 }}
          getItemLayout={(_, index) => ({
            length: ITEM_WIDTH,
            offset: ITEM_WIDTH * index,
            index,
          })}
          onScroll={onScroll}
          onMomentumScrollEnd={snapToIndex}
          onScrollEndDrag={snapToIndex}
          renderItem={renderItem}
        />
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
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 2,
  },
  metaLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#334155',
    letterSpacing: 0.4,
    textShadowColor: 'rgba(255,255,255,0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
  spinner: { marginVertical: -2 },
  calendarButton: {
    minHeight: 24,
    paddingHorizontal: 8,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: '#dbe5f2',
    shadowColor: '#0f172a',
    shadowOpacity: 0.12,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  calendarButtonPressed: {
    opacity: 0.9,
  },
  calendarButtonText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
    color: '#334155',
  },
  metaLive: {
    fontSize: 11,
    fontWeight: '800',
    color: '#15803d',
    textShadowColor: 'rgba(255,255,255,0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
  metaLiveDim: {
    color: '#64748b',
  },
  swipeCue: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748b',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    textShadowColor: 'rgba(255,255,255,0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
  carouselWrap: {
    position: 'relative',
  },
  edgeCue: {
    position: 'absolute',
    top: 0,
    bottom: 10,
    width: 36,
    zIndex: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  edgeCueLeft: {
    left: 0,
  },
  edgeCueRight: {
    right: 0,
  },
  slotInner: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 4,
  },
  dialText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'center',
    textShadowColor: 'rgba(255,255,255,0.98)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
});
