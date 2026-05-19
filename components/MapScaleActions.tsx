import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type MapScaleActionsProps = {
  onNotificationPress?: () => void;
  onModelingPress?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  canZoomIn?: boolean;
  canZoomOut?: boolean;
};

/** Alert, Model, and zoom controls in the top-left map overlay. */
export function MapScaleActions({
  onNotificationPress,
  onModelingPress,
  onZoomIn,
  onZoomOut,
  canZoomIn = true,
  canZoomOut = true,
}: MapScaleActionsProps) {
  const insets = useSafeAreaInsets();
  const showZoom = onZoomIn != null && onZoomOut != null;
  const showActions = onNotificationPress != null || onModelingPress != null || showZoom;
  if (!showActions) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          top: Math.max(insets.top, 6) + 8,
          left: 8,
        },
      ]}
    >
      {onNotificationPress ? (
        <Pressable
          onPress={onNotificationPress}
          style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel="Go to notification location and open settings"
        >
          <Ionicons name="notifications-outline" size={16} color="#1f2937" />
          <Text style={styles.actionLabel} numberOfLines={1}>
            Alert
          </Text>
        </Pressable>
      ) : null}
      {onModelingPress ? (
        <Pressable
          onPress={onModelingPress}
          style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel="Modeling"
        >
          <Ionicons name="layers-outline" size={16} color="#1f2937" />
          <Text style={styles.actionLabel} numberOfLines={1}>
            Model
          </Text>
        </Pressable>
      ) : null}
      {showZoom ? (
        <View style={styles.zoomPill}>
          <Pressable
            onPress={onZoomIn}
            disabled={!canZoomIn}
            style={({ pressed }) => [
              styles.zoomPillHalf,
              !canZoomIn && styles.zoomPillHalfDisabled,
              pressed && canZoomIn && styles.zoomPillHalfPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Zoom in map"
          >
            <Ionicons name="add" size={16} color={canZoomIn ? '#1f2937' : '#94a3b8'} />
          </Pressable>
          <View style={styles.zoomPillDivider} />
          <Pressable
            onPress={onZoomOut}
            disabled={!canZoomOut}
            style={({ pressed }) => [
              styles.zoomPillHalf,
              !canZoomOut && styles.zoomPillHalfDisabled,
              pressed && canZoomOut && styles.zoomPillHalfPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Zoom out map"
          >
            <Ionicons name="remove" size={16} color={canZoomOut ? '#1f2937' : '#94a3b8'} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const ACTION_PILL_MIN_WIDTH = 72;
const ZOOM_PILL_WIDTH = ACTION_PILL_MIN_WIDTH / 2;

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    zIndex: 12,
    gap: 6,
    minWidth: ACTION_PILL_MIN_WIDTH,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: 34,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    shadowColor: '#1e293b',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  actionBtnPressed: {
    opacity: 0.88,
    transform: [{ translateY: 0.5 }],
  },
  actionLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.15,
    color: '#334155',
  },
  zoomPill: {
    alignSelf: 'flex-start',
    width: ZOOM_PILL_WIDTH,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    shadowColor: '#1e293b',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
    overflow: 'hidden',
  },
  zoomPillHalf: {
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomPillHalfPressed: {
    opacity: 0.88,
    backgroundColor: 'rgba(241,245,249,0.9)',
  },
  zoomPillHalfDisabled: {
    opacity: 0.55,
  },
  zoomPillDivider: {
    height: 1,
    backgroundColor: '#e2e8f0',
    marginHorizontal: 4,
  },
});
