import { useCallback, useMemo, useState } from 'react';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CurrentKrigingRow } from '../lib/database.types';
import type { FetchError } from '../lib/fetchAirQuality';
import { useAirQualityReminder } from '../hooks/useAirQualityReminder';
import { regionFromSensorData } from '../lib/mapRegionFromData';
import { PM25_AQI_BOUNDS } from '../lib/pm25ColorScale';
import type { SensorPoint } from '../lib/sensorTypes';
import { AqiPanel } from './AqiPanel';
import { Pm25VerticalScale } from './Pm25VerticalScale';
import { ReadingTimeline } from './ReadingTimeline';
import { SsfMap } from './SsfMap';

type PanelSlot = 'bottom' | 'center';

/** Lifts the selection sheet slightly above the screen edge / vertical center. */
const PANEL_LIFT_PX = 15;

export type SsfAirQualityScreenProps = {
  sensors: SensorPoint[];
  kriging: CurrentKrigingRow[];
  loading: boolean;
  initialLoadProgress: number;
  error: FetchError | null;
  timelineTimesAsc: string[];
  timelineIndex: number;
  onTimelineIndexChange: (index: number) => void;
  onSelectRecordedTime: (recordedTime: string) => void;
  viewingLive: boolean;
  timelineLoading: boolean;
  insufficientData: boolean;
  liveAverageAqi: number | null;
};

export function SsfAirQualityScreen({
  sensors,
  kriging,
  loading,
  initialLoadProgress,
  error,
  timelineTimesAsc,
  timelineIndex,
  onTimelineIndexChange,
  onSelectRecordedTime,
  viewingLive,
  timelineLoading,
  insufficientData,
  liveAverageAqi,
}: SsfAirQualityScreenProps) {
  const insets = useSafeAreaInsets();

  const [selected, setSelected] = useState<{ lat: number; lon: number } | null>(null);
  const [panelSlot, setPanelSlot] = useState<PanelSlot>('bottom');

  const mapRegion = useMemo(() => regionFromSensorData(sensors, kriging), [sensors, kriging]);
  const selectedTimeIsoForUi = useMemo(
    () => timelineTimesAsc[timelineIndex] ?? (timelineTimesAsc.length === 0 ? new Date().toISOString() : null),
    [timelineIndex, timelineTimesAsc],
  );
  const selectedTimeInPastDay = useMemo(() => {
    if (!selectedTimeIsoForUi) return false;
    const selected = new Date(selectedTimeIsoForUi);
    if (!Number.isFinite(selected.getTime())) return false;
    const ageMs = Date.now() - selected.getTime();
    return ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000;
  }, [selectedTimeIsoForUi]);
  const timelineTimesForUi = useMemo(
    () =>
      timelineTimesAsc.length === 0 && selectedTimeInPastDay
        ? [new Date().toISOString()]
        : timelineTimesAsc,
    [selectedTimeInPastDay, timelineTimesAsc],
  );
  const timelineIndexForUi = useMemo(
    () =>
      timelineTimesForUi.length > 0 ? Math.min(timelineIndex, timelineTimesForUi.length - 1) : 0,
    [timelineIndex, timelineTimesForUi],
  );

  const { reminder, setReminder, clearReminder, isReminderForCoordinate } = useAirQualityReminder(
    sensors,
    kriging,
    viewingLive,
  );

  const maxSensorPm25 = useMemo(() => {
    if (sensors.length === 0) return PM25_AQI_BOUNDS[PM25_AQI_BOUNDS.length - 1];
    return Math.max(...sensors.map((s) => s.pm25));
  }, [sensors]);

  const onSelectCoordinate = useCallback(
    (lat: number, lon: number, detail: { touchInBottomBand: boolean }) => {
      setSelected({ lat, lon });
      setPanelSlot(detail.touchInBottomBand ? 'center' : 'bottom');
    },
    [],
  );

  const clearSelection = useCallback(() => {
    setSelected(null);
    setPanelSlot('bottom');
  }, []);

  return (
    <View style={styles.screenRoot}>
      <View style={styles.screenContent}>
        <View style={styles.main}>
          <Pm25VerticalScale maxPm25={maxSensorPm25} />

          <View style={styles.mapCol}>
            {loading && sensors.length === 0 && kriging.length === 0 ? (
              <View style={styles.loadingOverlay} pointerEvents="none">
                <Image source={require('../assets/rise-south-city-logo.png')} style={styles.loadingLogo} />
                <Text style={styles.loadingText}>Loading PurpleAir and Clarity data...</Text>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.max(8, Math.min(100, initialLoadProgress * 100))}%` }]} />
                </View>
                <Text style={styles.progressText}>{Math.round(initialLoadProgress * 100)}%</Text>
              </View>
            ) : null}
            <SsfMap
              sensors={sensors}
              kriging={kriging}
              mapRegion={mapRegion}
              selected={selected ? { latitude: selected.lat, longitude: selected.lon } : null}
              reminderLocation={
                reminder ? { latitude: reminder.lat, longitude: reminder.lon } : null
              }
              onSelectCoordinate={onSelectCoordinate}
            />
            {!viewingLive && insufficientData ? (
              <View style={styles.insufficientWrap} pointerEvents="none">
                <Text style={styles.insufficientText}>Insufficient Data</Text>
              </View>
            ) : null}
          </View>
          {selected ? (
            <View
              style={[
                panelSlot === 'center' ? styles.sheetWrapCenter : styles.sheetWrapBottom,
                panelSlot === 'bottom' && {
                  paddingBottom: Math.max(insets.bottom, 12),
                  bottom: PANEL_LIFT_PX,
                },
              ]}
              pointerEvents="box-none"
            >
              <View
                style={[
                  styles.sheetInner,
                  panelSlot === 'center' && { transform: [{ translateY: -PANEL_LIFT_PX }] },
                ]}
              >
                <AqiPanel
                  selected={selected}
                  loading={loading}
                  error={error}
                  sensors={sensors}
                  kriging={kriging}
                  mapRegion={mapRegion}
                  onClose={clearSelection}
                  sheetMode
                  healthTooltipPlacement={panelSlot === 'bottom' ? 'above' : 'below'}
                  reminderBellActive={isReminderForCoordinate(selected)}
                  onReminderPickThreshold={async (categoryIndex, cooldownMinutes) => {
                    if (selected == null) return;
                    try {
                      await setReminder(selected.lat, selected.lon, categoryIndex, cooldownMinutes);
                    } catch {
                      Alert.alert(
                        'Check your connection',
                        'We could not save your reminder. Check your connection.',
                      );
                    }
                  }}
                  onReminderCooldownChange={async (cooldownMinutes) => {
                    if (reminder == null) return;
                    try {
                      await setReminder(
                        reminder.lat,
                        reminder.lon,
                        reminder.categoryIndex,
                        cooldownMinutes,
                      );
                    } catch {
                      Alert.alert(
                        'Check your connection',
                        'We could not save your reminder. Check your connection.',
                      );
                    }
                  }}
                  onReminderClear={clearReminder}
                  savedReminderCategoryIndex={reminder?.categoryIndex ?? null}
                  savedReminderCooldownMinutes={reminder?.cooldownMinutes ?? null}
                />
              </View>
            </View>
          ) : null}

          <ReadingTimeline
            timesAsc={timelineTimesForUi}
            selectedIndex={timelineIndexForUi}
            onChangeIndex={(index) => {
              if (timelineTimesAsc.length === 0) return;
              onTimelineIndexChange(index);
            }}
            viewingLive={viewingLive}
            showCurrentDayHistoryLabel={selectedTimeInPastDay}
            loading={timelineLoading}
            onPickRecordedTime={onSelectRecordedTime}
            liveAverageAqi={liveAverageAqi}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screenRoot: { flex: 1, backgroundColor: '#e8f0fe' },
  screenContent: { flex: 1, position: 'relative' },
  main: { flex: 1, minHeight: 0 },
  mapCol: { flex: 1, minHeight: 0, zIndex: 0 },
  insufficientWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 3,
  },
  insufficientText: {
    color: '#dc2626',
    fontSize: 22,
    fontWeight: '800',
    textShadowColor: 'rgba(255,255,255,0.95)',
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 0 },
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: 'rgba(241,245,249,0.72)',
  },
  loadingLogo: {
    width: 144,
    height: 144,
    resizeMode: 'contain',
  },
  loadingText: { fontSize: 13, color: '#334155', fontWeight: '600' },
  progressTrack: {
    width: 220,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#cbd5e1',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#1e3a8a',
  },
  progressText: { fontSize: 12, color: '#475569' },
  sheetWrapBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: PANEL_LIFT_PX,
    paddingHorizontal: 16,
    paddingTop: 8,
    width: '100%',
    alignItems: 'center',
    zIndex: 2,
  },
  sheetWrapCenter: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    zIndex: 2,
  },
  sheetInner: {
    width: '100%',
    maxWidth: 520,
  },
});
