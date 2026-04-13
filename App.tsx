import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { SsfAirQualityScreen } from './components/SsfAirQualityScreen';
import { useSsfAirQuality } from './hooks/useSsfAirQuality';
import { ensureAnonymousSession } from './lib/ensureAnonymousSession';

function AppContent() {
  const {
    sensors,
    kriging,
    loading,
    error,
    timelineTimesAsc,
    timelineIndex,
    setTimelineIndex,
    viewingLive,
    timelineLoading,
  } = useSsfAirQuality();

  return (
    <View style={styles.appRoot}>
      <SsfAirQualityScreen
        sensors={sensors}
        kriging={kriging}
        loading={loading}
        error={error}
        timelineTimesAsc={timelineTimesAsc}
        timelineIndex={timelineIndex}
        onTimelineIndexChange={setTimelineIndex}
        viewingLive={viewingLive}
        timelineLoading={timelineLoading}
      />
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
});
