import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
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
  error: FetchError | null;
  timelineTimesAsc: string[];
  timelineIndex: number;
  onTimelineIndexChange: (index: number) => void;
  viewingLive: boolean;
  timelineLoading: boolean;
};

export function SsfAirQualityScreen({
  sensors,
  kriging,
  loading,
  error,
  timelineTimesAsc,
  timelineIndex,
  onTimelineIndexChange,
  viewingLive,
  timelineLoading,
}: SsfAirQualityScreenProps) {
  const insets = useSafeAreaInsets();

  const [selected, setSelected] = useState<{ lat: number; lon: number } | null>(null);
  const [panelSlot, setPanelSlot] = useState<PanelSlot>('bottom');

  const mapRegion = useMemo(() => regionFromSensorData(sensors, kriging), [sensors, kriging]);

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
                <ActivityIndicator color="#475569" />
                <Text style={styles.loadingText}>Loading Supabase data…</Text>
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
                  reminderBellActive={isReminderForCoordinate(selected)}
                  onReminderPickThreshold={async (categoryIndex) => {
                    if (selected == null) return;
                    try {
                      await setReminder(selected.lat, selected.lon, categoryIndex);
                    } catch {
                      Alert.alert(
                        'Check your connection',
                        'We could not save your reminder. Check your connection.',
                      );
                    }
                  }}
                  onReminderClear={clearReminder}
                  savedReminderCategoryIndex={reminder?.categoryIndex ?? null}
                />
              </View>
            </View>
          ) : null}

          <ReadingTimeline
            timesAsc={timelineTimesAsc}
            selectedIndex={timelineIndex}
            onChangeIndex={onTimelineIndexChange}
            viewingLive={viewingLive}
            loading={timelineLoading}
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
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'rgba(241,245,249,0.72)',
  },
  loadingText: { fontSize: 13, color: '#475569' },
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
