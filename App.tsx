import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { AqiGraphScreen } from './components/AqiGraphScreen';
import { EducationHubScreen } from './components/EducationHubScreen';
import { InitialLoadSplash } from './components/InitialLoadSplash';
import { SsfAirQualityScreen } from './components/SsfAirQualityScreen';
import { useSsfAirQuality } from './hooks/useSsfAirQuality';
import { ensureAnonymousSession } from './lib/ensureAnonymousSession';

type RootTab = 'map' | 'graph' | 'education';

function AppContent() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<RootTab>('map');
  const {
    sensors,
    kriging,
    loading,
    initialLoadProgress,
    error,
    timelineTimesAsc,
    timelineIndex,
    setTimelineIndex,
    selectRecordedTime,
    viewingLive,
    timelineLoading,
    insufficientData,
    liveAverageAqi,
    averageAqiTimeseries,
  } = useSsfAirQuality();
  const showInitialSplash = loading && sensors.length === 0 && kriging.length === 0;
  const selectedTimeIso = useMemo(
    () => timelineTimesAsc[timelineIndex] ?? (timelineTimesAsc.length === 0 ? new Date().toISOString() : null),
    [timelineIndex, timelineTimesAsc],
  );

  return (
    <View style={styles.appRoot}>
      <View style={styles.screenContainer}>
        {activeTab === 'map' ? (
          <SsfAirQualityScreen
            sensors={sensors}
            kriging={kriging}
            loading={loading}
            error={error}
            timelineTimesAsc={timelineTimesAsc}
            timelineIndex={timelineIndex}
            onTimelineIndexChange={setTimelineIndex}
            onSelectRecordedTime={selectRecordedTime}
            viewingLive={viewingLive}
            timelineLoading={timelineLoading}
            insufficientData={insufficientData}
            liveAverageAqi={liveAverageAqi}
            averageAqiTimeseries={averageAqiTimeseries}
          />
        ) : activeTab === 'graph' ? (
          <AqiGraphScreen
            points={averageAqiTimeseries}
            timelineTimesAsc={timelineTimesAsc}
            timelineIndex={timelineIndex}
            selectedTimeIso={selectedTimeIso}
            liveAverageAqi={liveAverageAqi}
            loading={timelineLoading}
            onSelectTime={(recordedTime) => {
              const sourceIndex = timelineTimesAsc.findIndex((iso) => iso === recordedTime);
              if (sourceIndex >= 0) setTimelineIndex(sourceIndex);
            }}
            onSelectRecordedTime={selectRecordedTime}
          />
        ) : (
          <EducationHubScreen />
        )}
      </View>
      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <Pressable
          onPress={() => setActiveTab('map')}
          style={({ pressed }) => [styles.tabButton, pressed && styles.tabButtonPressed]}
          accessibilityRole="button"
          accessibilityLabel="Open map tab"
        >
          <Ionicons name={activeTab === 'map' ? 'map' : 'map-outline'} size={20} color={activeTab === 'map' ? '#0f172a' : '#64748b'} />
          <Text style={[styles.tabLabel, activeTab === 'map' && styles.tabLabelActive]}>Map</Text>
        </Pressable>
        <Pressable
          onPress={() => setActiveTab('graph')}
          style={({ pressed }) => [styles.tabButton, pressed && styles.tabButtonPressed]}
          accessibilityRole="button"
          accessibilityLabel="Open graph tab"
        >
          <Ionicons
            name={activeTab === 'graph' ? 'bar-chart' : 'bar-chart-outline'}
            size={20}
            color={activeTab === 'graph' ? '#0f172a' : '#64748b'}
          />
          <Text style={[styles.tabLabel, activeTab === 'graph' && styles.tabLabelActive]}>Graph</Text>
        </Pressable>
        <Pressable
          onPress={() => setActiveTab('education')}
          style={({ pressed }) => [styles.tabButton, pressed && styles.tabButtonPressed]}
          accessibilityRole="button"
          accessibilityLabel="Open education tab"
        >
          <Ionicons
            name={activeTab === 'education' ? 'school' : 'school-outline'}
            size={20}
            color={activeTab === 'education' ? '#0f172a' : '#64748b'}
          />
          <Text style={[styles.tabLabel, activeTab === 'education' && styles.tabLabelActive]}>Education</Text>
        </Pressable>
      </View>
      <InitialLoadSplash visible={showInitialSplash} progress={initialLoadProgress} />
    </View>
  );
}

export default function App() {
  const splashHiddenRef = useRef(false);

  useEffect(() => {
    void ensureAnonymousSession().catch((err) => {
      console.error('[ensureAnonymousSession]', err);
    });
  }, []);

  useEffect(() => {
    if (splashHiddenRef.current) return;
    splashHiddenRef.current = true;
    void SplashScreen.hideAsync().catch((err) => {
      console.error('[SplashScreen.hideAsync]', err);
    });
  }, []);

  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaProvider>
        <AppContent />
        <StatusBar style="dark" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  gestureRoot: { flex: 1 },
  appRoot: { flex: 1, position: 'relative' },
  screenContainer: { flex: 1, paddingBottom: 78 },
  tabBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    shadowColor: '#0f172a',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  tabButton: {
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: 12,
  },
  tabButtonPressed: {
    opacity: 0.86,
  },
  tabLabel: {
    marginTop: 2,
    fontSize: 12,
    color: '#64748b',
    fontWeight: '700',
  },
  tabLabelActive: {
    color: '#0f172a',
  },
});
