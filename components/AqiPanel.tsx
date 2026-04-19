import { FontAwesome } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { RefObject } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import type { CurrentKrigingRow } from '../lib/database.types';
import { coordinateInRegion, type MapRegion } from '../lib/mapRegionFromData';
import {
  EPA_AQI_CATEGORY_BANDS,
  aqiCategory,
  pm25ToAqi,
  type AqiCategory,
  type Pm25Category,
} from '../lib/aqiUtils';
import { milesBetweenKm } from '../lib/geoUtils';
import { computeSsfSelection } from '../lib/ssfSelection';
import type { SensorPoint } from '../lib/sensorTypes';
import type { FetchError } from '../lib/fetchAirQuality';

export type Metric = 'pm25' | 'aqi';

function sheetPanelTitle(panel: { kind: string }): string {
  switch (panel.kind) {
    case 'oob':
      return 'Out of bounds';
    case 'msg':
      return 'Air quality';
    case 'placeholder':
      return 'Click a point on the map';
    case 'ok':
      return 'Air quality estimate';
    default:
      return 'Air quality estimate';
  }
}

const AQI_HEALTH_PAPER_URL =
  'https://www.sciencedirect.com/science/article/pii/S0160412020318316';

const BMJ_PM25_HOSPITAL_ER_URL = 'https://www.bmj.com/content/384/bmj-2023-076322';

/** Outdoor mask efficacy — fixed pooled estimate (does not scale with PM2.5 at this point). */
const OUTDOOR_MASK_PAPER_URL =
  'https://www.sciencedirect.com/science/article/abs/pii/S1309104223001940';
const OUTDOOR_MASK_EFFICACY_PCT = 72;
const OUTDOOR_MASK_CI_LO_PCT = 43;
const OUTDOOR_MASK_CI_HI_PCT = 86;

/** Indoor filter efficacy — fixed pooled estimate (does not scale with PM2.5 at this point). */
const INDOOR_FILTER_PAPER_URL =
  'https://www.sciencedirect.com/science/article/abs/pii/S0048969720361143';
const INDOOR_FILTER_EFFICACY_PCT = 57;
const INDOOR_FILTER_CI_LO_PCT = 22.6;
const INDOOR_FILTER_CI_HI_PCT = 92.0;

/**
 * Meta-analysis (short-term PM2.5): effect scaled from +65% / ±21% per +10 µg/m³; values are divided by 100
 * so displayed percentages match the literature scale used in the UI.
 */
function mortalityPercentFromInterpolatedPm25(
  pm25UgM3: number | null | undefined,
): { pct: number; uncPct: number } | null {
  if (pm25UgM3 == null || !Number.isFinite(pm25UgM3) || pm25UgM3 <= 0) return null;
  const per10 = pm25UgM3 / 10;
  return { pct: (per10 * 65) / 100, uncPct: (per10 * 21) / 100 };
}

/** Linear scale of per–10 µg/m³ effect to current interpolated µg/m³. */
function scalePer10ug(
  pm25UgM3: number | null | undefined,
  per10: number,
  per10Lo: number,
  per10Hi: number,
): { mid: number; lo: number; hi: number } | null {
  if (pm25UgM3 == null || !Number.isFinite(pm25UgM3) || pm25UgM3 <= 0) return null;
  const k = pm25UgM3 / 10;
  return { mid: k * per10, lo: k * per10Lo, hi: k * per10Hi };
}

function formatSmallPct(n: number): string {
  return n >= 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`;
}

function formatCiPct(lo: number, hi: number): string {
  return `${lo.toFixed(2)}–${hi.toFixed(2)}%`;
}

/** Preset cooldowns for the reminder modal (minutes). Default selection is 60. Labels are short so the row fits on one line. */
const REMINDER_COOLDOWN_PRESETS = [
  { minutes: 30, label: '30m', a11y: '30 minutes' },
  { minutes: 60, label: '1h', a11y: '1 hour' },
  { minutes: 300, label: '5h', a11y: '5 hours' },
  { minutes: 720, label: '12h', a11y: '12 hours' },
  { minutes: 1440, label: '24h', a11y: '24 hours' },
] as const;

function nearestReminderCooldownPreset(minutes: number): number {
  let best: number = REMINDER_COOLDOWN_PRESETS[0].minutes;
  let bestD = Math.abs(minutes - best);
  for (const p of REMINDER_COOLDOWN_PRESETS) {
    const d = Math.abs(minutes - p.minutes);
    if (d < bestD) {
      best = p.minutes;
      bestD = d;
    }
  }
  return best;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

type HealthTooltipAnchor = { x: number; y: number; w: number; h: number };

function HealthTooltipLeftCell({
  title,
  subtitleBeforeLink,
  onLinkPress,
}: {
  title: string;
  subtitleBeforeLink: string;
  onLinkPress: () => void;
}) {
  return (
    <View style={styles.healthTooltipSilentLeft}>
      <Text style={styles.healthTooltipTitle}>{title}</Text>
      <Text style={styles.healthTooltipSub}>
        {subtitleBeforeLink}{' '}
        <Text style={styles.aqiStatsLinkInline} onPress={onLinkPress}>
          (link)
        </Text>
      </Text>
    </View>
  );
}

function HealthStatsTooltipBubble({
  anchor,
  predPm25,
  onMortalityLink,
  onBmjLink,
  onOutdoorMaskLink,
  onIndoorFilterLink,
  placement,
  winW,
  winH,
}: {
  anchor: HealthTooltipAnchor;
  predPm25: number | null;
  onMortalityLink: () => void;
  onBmjLink: () => void;
  onOutdoorMaskLink: () => void;
  onIndoorFilterLink: () => void;
  /** `above`: anchor the bubble upward (e.g. bottom sheet). `below`: under the ? chip. */
  placement: 'above' | 'below';
  winW: number;
  winH: number;
}) {
  const mort = mortalityPercentFromInterpolatedPm25(predPm25);
  /** BMJ: respiratory ED visits, per +10 µg/m³ two-day PM2.5 */
  const erErr = scalePer10ug(predPm25, 1.34, 0.73, 1.94);

  const PAD = 12;
  /** Gap between ? chip and tooltip (below: under the chip; above: above the chip). */
  const TOOLTIP_EDGE_GAP = 8;
  const ARROW = 7;
  const BUBBLE_MAX_W = 320;
  const scrollMaxHBase = Math.min(400, winH * 0.52);
  /** When opening above, cap scroll height so the bubble stays on-screen above the ?. */
  const scrollMaxH =
    placement === 'above'
      ? Math.min(scrollMaxHBase, Math.max(140, anchor.y - PAD - TOOLTIP_EDGE_GAP - 44))
      : scrollMaxHBase;
  const ax = anchor.x + anchor.w / 2;
  const bw = Math.min(BUBBLE_MAX_W, winW - 2 * PAD);
  const left = Math.max(PAD, Math.min(ax - bw / 2, winW - PAD - bw));
  const triW = ARROW * 2;
  const arrowPad = 6;
  const arrowLeftRaw = ax - left - ARROW;
  const arrowLeftMax = bw - triW - arrowPad;
  const arrowLeft = Math.min(Math.max(arrowLeftRaw, arrowPad), Math.max(arrowLeftMax, arrowPad));

  const wrapPositionStyle =
    placement === 'below'
      ? ({
          left,
          top: anchor.y + anchor.h + TOOLTIP_EDGE_GAP,
          width: bw,
        } as const)
      : ({
          left,
          bottom: winH - anchor.y + TOOLTIP_EDGE_GAP,
          width: bw,
          maxHeight: Math.min(scrollMaxH + 56, anchor.y - PAD - TOOLTIP_EDGE_GAP),
        } as const);

  const mortalityRight = mort ? (
    <>
      <Text style={styles.aqiStatsTdValueRed}>{formatSmallPct(mort.pct)}</Text>
      <Text style={styles.healthTooltipErrCi}>
        {formatCiPct(mort.pct - mort.uncPct, mort.pct + mort.uncPct)}
      </Text>
    </>
  ) : (
    <Text style={styles.healthTooltipEmDash}>—</Text>
  );

  const bmjErrBlock = (s: { mid: number; lo: number; hi: number } | null) =>
    s ? (
      <>
        <Text style={styles.aqiStatsTdValueRed}>{formatSmallPct(s.mid)}</Text>
        <Text style={styles.healthTooltipErrCi}>{formatCiPct(s.lo, s.hi)}</Text>
      </>
    ) : (
      <Text style={styles.healthTooltipEmDash}>—</Text>
    );

  const outdoorMaskRight = (
    <>
      <Text style={styles.healthTooltipValueGreen}>{`${OUTDOOR_MASK_EFFICACY_PCT}%`}</Text>
      <Text style={styles.healthTooltipErrCi}>
        {formatCiPct(OUTDOOR_MASK_CI_LO_PCT, OUTDOOR_MASK_CI_HI_PCT)}
      </Text>
    </>
  );

  const indoorFilterRight = (
    <>
      <Text style={styles.healthTooltipValueGreen}>{`${INDOOR_FILTER_EFFICACY_PCT}%`}</Text>
      <Text style={styles.healthTooltipErrCi}>
        {formatCiPct(INDOOR_FILTER_CI_LO_PCT, INDOOR_FILTER_CI_HI_PCT)}
      </Text>
    </>
  );

  const cardAndScroll = (
    <View style={styles.healthTooltipCard}>
      <ScrollView
        style={{ maxHeight: scrollMaxH }}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.healthTooltipTableRow}>
          <HealthTooltipLeftCell
            title="Mortality Risk"
            subtitleBeforeLink="Evidence from a meta-analysis on short-term PM2.5"
            onLinkPress={onMortalityLink}
          />
          <View style={styles.healthTooltipSilentRight}>{mortalityRight}</View>
        </View>
        <View style={styles.healthTooltipRowDivider} />
        <View style={styles.healthTooltipTableRow}>
          <HealthTooltipLeftCell
            title="ER Visit Rate"
            subtitleBeforeLink="respiratory visits vs two-day PM2.5; excess relative risk"
            onLinkPress={onBmjLink}
          />
          <View style={styles.healthTooltipSilentRight}>{bmjErrBlock(erErr)}</View>
        </View>
        <View style={styles.healthTooltipRowDivider} />
        <View style={styles.healthTooltipTableRow}>
          <HealthTooltipLeftCell
            title="Outdoor Mask Efficacy"
            subtitleBeforeLink="Pooled outdoor estimate; With proper use"
            onLinkPress={onOutdoorMaskLink}
          />
          <View style={styles.healthTooltipSilentRight}>{outdoorMaskRight}</View>
        </View>
        <View style={styles.healthTooltipRowDivider} />
        <View style={styles.healthTooltipTableRow}>
          <HealthTooltipLeftCell
            title="Indoor Filter Efficacy"
            subtitleBeforeLink="Pooled indoor estimate; With proper use and scale"
            onLinkPress={onIndoorFilterLink}
          />
          <View style={styles.healthTooltipSilentRight}>{indoorFilterRight}</View>
        </View>
      </ScrollView>
    </View>
  );

  return (
    <View style={[styles.healthTooltipWrap, wrapPositionStyle]} pointerEvents="box-none">
      {placement === 'below' ? (
        <>
          <View style={[styles.healthTooltipArrowUp, { left: arrowLeft }]} />
          {cardAndScroll}
        </>
      ) : (
        <>
          {cardAndScroll}
          <View style={[styles.healthTooltipArrowDown, { left: arrowLeft }]} />
        </>
      )}
    </View>
  );
}

export type AqiPanelProps = {
  selected: { lat: number; lon: number } | null;
  loading: boolean;
  error: FetchError | null;
  sensors: SensorPoint[];
  kriging: CurrentKrigingRow[];
  /** Same region as the map: extent of loaded sensor + kriging points. */
  mapRegion: MapRegion;
  /** When set (e.g. modal), shows a top bar with dismiss — matches SSF-AQI `aqi_panel.py` chrome. */
  onClose?: () => void;
  /**
   * Bottom sheet: compact inner metrics (same font/padding as before), title + dismiss row,
   * no internal scroll — height follows content.
   */
  sheetMode?: boolean;
  /** EPA band index 0–5; when true, the bell uses the filled style for this map selection. */
  reminderBellActive?: boolean;
  /** If provided, a bell appears (when the panel has a valid estimate) to set a single global reminder. */
  onReminderPickThreshold?: (
    categoryIndex: number,
    cooldownMinutes: number,
  ) => void | Promise<void>;
  /** When a reminder already exists for this spot, persist cooldown changes from the chips. */
  onReminderCooldownChange?: (cooldownMinutes: number) => void | Promise<void>;
  onReminderClear?: () => void;
  /** Highlights the saved global threshold row in the reminder modal (0–5). */
  savedReminderCategoryIndex?: number | null;
  /** Saved cooldown for the reminder (minutes); omit or null to use default 60 in the modal. */
  savedReminderCooldownMinutes?: number | null;
  /**
   * Health tooltip relative to the ? control. Use `above` when the panel sits at the bottom of the screen
   * so the popover stays visible; `below` when there is room under the chip (e.g. lifted center sheet).
   */
  healthTooltipPlacement?: 'above' | 'below';
};

export function AqiPanel({
  selected,
  loading,
  error,
  sensors,
  kriging,
  mapRegion,
  onClose,
  sheetMode = false,
  reminderBellActive = false,
  onReminderPickThreshold,
  onReminderCooldownChange,
  onReminderClear,
  savedReminderCategoryIndex = null,
  savedReminderCooldownMinutes = null,
  healthTooltipPlacement = 'below',
}: AqiPanelProps) {
  const { width: winW, height: winH } = useWindowDimensions();
  const isNarrow = winW <= 640;
  const [metric, setMetric] = useState<Metric>('pm25');
  const [reminderModalOpen, setReminderModalOpen] = useState(false);
  const [healthTooltipOpen, setHealthTooltipOpen] = useState(false);
  const [healthTooltipAnchor, setHealthTooltipAnchor] = useState<HealthTooltipAnchor | null>(null);
  const healthHelpAnchorRef = useRef<View>(null);
  /** Snapshot when modal opens: only then show Clear (avoids Clear appearing mid-close after first-time save). */
  const [reminderHadClearWhenOpened, setReminderHadClearWhenOpened] = useState(false);
  const [reminderCooldownMinutes, setReminderCooldownMinutes] = useState(60);

  const closeHealthTooltip = useCallback(() => {
    setHealthTooltipOpen(false);
    setHealthTooltipAnchor(null);
  }, []);

  const openHealthTooltip = useCallback(() => {
    healthHelpAnchorRef.current?.measureInWindow((x, y, w, h) => {
      setHealthTooltipAnchor({ x, y, w, h });
      setHealthTooltipOpen(true);
    });
  }, []);

  const openMortalityPaperLink = useCallback(() => {
    void Linking.openURL(AQI_HEALTH_PAPER_URL).catch(() => {
      /* ignore */
    });
  }, []);

  const openBmjPaperLink = useCallback(() => {
    void Linking.openURL(BMJ_PM25_HOSPITAL_ER_URL).catch(() => {
      /* ignore */
    });
  }, []);

  const openOutdoorMaskPaperLink = useCallback(() => {
    void Linking.openURL(OUTDOOR_MASK_PAPER_URL).catch(() => {
      /* ignore */
    });
  }, []);

  const openIndoorFilterPaperLink = useCallback(() => {
    void Linking.openURL(INDOOR_FILTER_PAPER_URL).catch(() => {
      /* ignore */
    });
  }, []);

  const openReminderModal = useCallback(() => {
    setReminderHadClearWhenOpened(reminderBellActive);
    setReminderCooldownMinutes(
      nearestReminderCooldownPreset(savedReminderCooldownMinutes ?? 60),
    );
    setReminderModalOpen(true);
  }, [reminderBellActive, savedReminderCooldownMinutes]);

  const closeReminderModal = useCallback(() => {
    setReminderModalOpen(false);
  }, []);

  const compact = sheetMode;

  const panel = useMemo(() => {
    if (selected == null) {
      return {
        kind: 'placeholder' as const,
      };
    }
    const lat = selected.lat;
    const lon = selected.lon;
    if (!coordinateInRegion(lat, lon, mapRegion)) {
      return { kind: 'oob' as const, lat, lon };
    }
    if (error) {
      return { kind: 'msg' as const, msg: `Couldn't load data: ${error.message}` };
    }
    if (loading && sensors.length === 0 && kriging.length === 0) {
      return { kind: 'msg' as const, msg: 'Loading PurpleAir data…' };
    }
    if (!loading && sensors.length === 0 && kriging.length === 0) {
      return { kind: 'msg' as const, msg: 'No sensor or grid data yet.' };
    }

    const { predPm25, predPm25Category, closest } = computeSsfSelection(lat, lon, sensors, kriging);
    const predAqi = pm25ToAqi(predPm25);
    const aqiCat = aqiCategory(predAqi);

    return {
      kind: 'ok' as const,
      lat,
      lon,
      predPm25,
      predPm25Category,
      predAqi,
      aqiCat,
      closest,
    };
  }, [selected, loading, error, sensors, kriging, mapRegion]);

  const showReminderButton = Boolean(onReminderPickThreshold && panel.kind === 'ok');

  const heroAccent =
    panel.kind === 'ok'
      ? metric === 'aqi'
        ? panel.aqiCat.bg
        : panel.predPm25Category.bg
      : '#cbd5e1';

  const heroValueSize = compact ? 30 : isNarrow ? 54 : 68;
  const cardValueSize = compact ? 13 : isNarrow ? 22 : 28;

  return (
    <LinearGradient
      colors={['rgba(255,255,255,0.92)', 'rgba(255,255,255,0.78)']}
      style={[
        styles.shellOuter,
        compact && styles.shellOuterCompact,
        onClose == null && styles.shellOuterInline,
        compact && styles.shellOuterSheetFlex,
      ]}
    >
      <View style={[styles.shell, compact && styles.shellSheetFlex]}>
        {compact ? (
          <>
            <View style={styles.sheetTitleRow}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {sheetPanelTitle(panel)}
              </Text>
              <View style={styles.sheetTitleActions}>
                {showReminderButton ? (
                  <Pressable
                    onPress={openReminderModal}
                    hitSlop={12}
                    style={styles.chromeIconBtnSheet}
                    accessibilityRole="button"
                    accessibilityLabel="Air quality reminder"
                  >
                    <FontAwesome
                      name={reminderBellActive ? 'bell' : 'bell-o'}
                      size={19}
                      color="#334155"
                    />
                  </Pressable>
                ) : null}
                {onClose ? (
                  <Pressable
                    onPress={onClose}
                    hitSlop={12}
                    style={styles.chromeIconBtnSheet}
                    accessibilityRole="button"
                    accessibilityLabel="Close air quality panel"
                  >
                    <Text style={styles.closeBtnText}>✕</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            <View style={styles.sheetBody}>
              <CompactPanelBody
                panel={panel}
                metric={metric}
                setMetric={setMetric}
                heroAccent={heroAccent}
                heroValueSize={heroValueSize}
                cardValueSize={cardValueSize}
                onHealthHelpPress={openHealthTooltip}
                healthHelpAnchorRef={healthHelpAnchorRef}
              />
            </View>
          </>
        ) : (
          <>
            {onClose ? (
              <View style={styles.shellTop}>
                <View style={styles.shellTopActions}>
                  {showReminderButton ? (
                    <Pressable
                      onPress={openReminderModal}
                      hitSlop={12}
                      style={styles.chromeIconBtn}
                      accessibilityRole="button"
                      accessibilityLabel="Air quality reminder"
                    >
                      <FontAwesome
                        name={reminderBellActive ? 'bell' : 'bell-o'}
                        size={21}
                        color="#334155"
                      />
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={onClose}
                    hitSlop={12}
                    style={styles.chromeIconBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Close air quality panel"
                  >
                    <Text style={styles.closeBtnText}>✕</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
            <ScrollView
              contentContainerStyle={[styles.scroll, isNarrow && styles.scrollNarrow]}
              keyboardShouldPersistTaps="handled"
              style={styles.scrollView}
            >
          {panel.kind === 'oob' ? (
            <View style={[styles.empty, styles.emptyMinH]}>
              <Text style={styles.emptyTitle}>Out of bounds</Text>
              <Text style={styles.emptyBody}>
                Those coordinates aren’t inside the configured map area.
              </Text>
              <Text style={styles.emptyCoords}>
                {panel.lat.toFixed(5)}, {panel.lon.toFixed(5)}
              </Text>
            </View>
          ) : panel.kind === 'msg' ? (
            <View style={[styles.empty, styles.emptyMinH]}>
              <Text style={styles.emptyBody}>{panel.msg}</Text>
            </View>
          ) : null}

          {panel.kind === 'placeholder' ? (
            <>
              <View style={styles.modernTop}>
                <View>
                  <Text style={styles.eyebrow}>Click a point on the map</Text>
                  <Text style={styles.coords}>-, -.</Text>
                </View>
              </View>
              <View style={styles.heroWrap}>
                <LinearGradient
                  colors={[hexToRgba('#cbd5e1', 0.35), 'rgba(255,255,255,0.88)']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0.35, y: 1 }}
                  style={[styles.hero, styles.heroShadow, { shadowColor: '#94a3b8' }]}
                >
                  <Pressable
                    ref={healthHelpAnchorRef}
                    onPress={openHealthTooltip}
                    hitSlop={10}
                    style={styles.heroHelpBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Health summary for this estimate"
                  >
                    <Text style={styles.heroHelpBtnMark}>?</Text>
                  </Pressable>
                  <View style={styles.heroInner}>
                    <Text style={styles.heroLabel}>
                      {metric === 'aqi' ? 'Predicted AQI' : 'Predicted PM2.5'}
                    </Text>
                    <View style={styles.heroRow}>
                      <Text style={[styles.heroValue, { fontSize: heroValueSize }]}>—</Text>
                      <Text style={styles.heroUnit}>{metric === 'aqi' ? 'AQI' : 'µg/m³'}</Text>
                    </View>
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>No data</Text>
                    </View>
                  </View>
                </LinearGradient>
              </View>
            </>
          ) : panel.kind === 'ok' ? (
            <>
              <View style={styles.modernTop}>
                <View style={styles.modernTopLeft}>
                  <Text style={styles.eyebrow}>Air quality estimate</Text>
                  <Text style={styles.coords}>
                    {panel.lat.toFixed(5)}, {panel.lon.toFixed(5)}
                  </Text>
                </View>
              </View>

              <View style={styles.heroWrap}>
                <LinearGradient
                  colors={[hexToRgba(heroAccent, 0.17), 'rgba(255,255,255,0.76)']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  style={[styles.hero, styles.heroShadow, { shadowColor: heroAccent }]}
                >
                  <Pressable
                    ref={healthHelpAnchorRef}
                    onPress={openHealthTooltip}
                    hitSlop={10}
                    style={styles.heroHelpBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Health summary for this estimate"
                  >
                    <Text style={styles.heroHelpBtnMark}>?</Text>
                  </Pressable>
                  <View style={styles.heroInner}>
                    <Text style={styles.heroLabel}>
                      {metric === 'aqi' ? 'Predicted AQI' : 'Predicted PM2.5'}
                    </Text>
                    <View style={styles.heroRow}>
                      <Text style={[styles.heroValue, { fontSize: heroValueSize }]}>
                        {metric === 'aqi'
                          ? panel.predAqi != null
                            ? String(panel.predAqi)
                            : '—'
                          : panel.predPm25 != null && Number.isFinite(panel.predPm25)
                            ? panel.predPm25.toFixed(1)
                            : '—'}
                      </Text>
                      <Text style={styles.heroUnit}>{metric === 'aqi' ? 'AQI' : 'µg/m³'}</Text>
                    </View>
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>
                        {metric === 'aqi' ? panel.aqiCat.label : panel.predPm25Category.label}
                      </Text>
                    </View>
                  </View>
                </LinearGradient>
              </View>
            </>
          ) : null}

          <View style={styles.metricToggleDock}>
            <View style={styles.metricToggle}>
              <Pressable
                onPress={() => setMetric('pm25')}
                style={[styles.metricPill, metric === 'pm25' && styles.metricPillActive]}
              >
                <Text style={[styles.metricPillText, metric === 'pm25' && styles.metricPillTextActive]}>
                  PM2.5
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setMetric('aqi')}
                style={[styles.metricPill, metric === 'aqi' && styles.metricPillActive]}
              >
                <Text style={[styles.metricPillText, metric === 'aqi' && styles.metricPillTextActive]}>
                  AQI
                </Text>
              </Pressable>
            </View>
          </View>

          {panel.kind === 'ok' || panel.kind === 'placeholder' ? (
            <View style={[styles.grid, styles.gridAfterToggle]}>
              {panel.kind === 'placeholder' ? (
                <>
                  <MiniCard
                    k="Closest sensor"
                    v="—"
                    sub="Click the map to see the nearest sensor"
                    valueFontSize={cardValueSize}
                  />
                  <MiniCard
                    k="Sensor distance"
                    v="—"
                    sub="Great-circle distance"
                    valueFontSize={cardValueSize}
                  />
                </>
              ) : (
                <>
                  <MiniCard
                    k="Closest sensor"
                    v={
                      panel.closest
                        ? metric === 'aqi'
                          ? `${pm25ToAqi(panel.closest.pm25) ?? '—'} AQI`
                          : `${panel.closest.pm25.toFixed(1)} µg/m³`
                        : '—'
                    }
                    sub="Nearest observed sensor reading"
                    valueFontSize={cardValueSize}
                  />
                  <MiniCard
                    k="Sensor distance"
                    v={
                      panel.closest ? `${milesBetweenKm(panel.closest.distKm).toFixed(2)} mi` : '—'
                    }
                    sub="Great-circle distance"
                    valueFontSize={cardValueSize}
                  />
                </>
              )}
            </View>
          ) : null}

        </ScrollView>
          </>
        )}
      </View>

      <Modal
        visible={reminderModalOpen}
        transparent
        animationType="fade"
        onRequestClose={closeReminderModal}
      >
        <View style={styles.reminderModalRoot}>
          <Pressable
            style={styles.reminderModalBackdrop}
            onPress={closeReminderModal}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
          <View style={styles.reminderModalCard}>
            <Text style={styles.reminderModalTitle}>Remind when</Text>
            <Text style={styles.reminderModalHint}>
              Tap an EPA color — we’ll notify when the estimated AQI at this spot reaches that level
              or worse. Only one location can be saved.
            </Text>
            <View style={styles.reminderColorList}>
              {EPA_AQI_CATEGORY_BANDS.slice(1).map((row, i) => {
                const index = i + 1;
                const saved = savedReminderCategoryIndex === index;
                return (
                  <Pressable
                    key={row.cat.label}
                    onPress={() => {
                      closeReminderModal();
                      void (async () => {
                        try {
                          await onReminderPickThreshold?.(index, reminderCooldownMinutes);
                        } catch {
                          /* parent shows alert */
                        }
                      })();
                    }}
                    style={({ pressed }) => [
                      styles.reminderColorRow,
                      saved && styles.reminderColorRowSaved,
                      pressed && (saved ? styles.reminderColorRowPressedSaved : styles.reminderColorRowPressed),
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`${row.cat.label}, AQI ${row.lo}–${row.hi}`}
                  >
                    <View style={[styles.reminderSwatch, { backgroundColor: row.cat.bg }]} />
                    <Text
                      style={[styles.reminderColorLabel, saved && styles.reminderColorLabelSaved]}
                      numberOfLines={2}
                    >
                      {row.cat.label}
                    </Text>
                    <Text style={[styles.reminderBandRange, saved && styles.reminderBandRangeSaved]}>
                      {row.lo}–{row.hi}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.reminderCooldownBlock}>
              <Text style={styles.reminderCooldownLabel}>Minimum time between alerts</Text>
              <Text style={styles.reminderCooldownHint}>
                After a notification, wait this long before the next one at this spot.
              </Text>
              <View style={styles.reminderCooldownChips}>
                {REMINDER_COOLDOWN_PRESETS.map((p) => {
                  const selected = reminderCooldownMinutes === p.minutes;
                  return (
                    <Pressable
                      key={p.minutes}
                      onPress={() => {
                        if (reminderCooldownMinutes === p.minutes) return;
                        setReminderCooldownMinutes(p.minutes);
                        const hasSavedReminderHere =
                          reminderBellActive &&
                          savedReminderCategoryIndex != null &&
                          savedReminderCategoryIndex >= 1;
                        if (hasSavedReminderHere) {
                          void onReminderCooldownChange?.(p.minutes);
                        }
                      }}
                      style={({ pressed }) => [
                        styles.reminderCooldownChip,
                        selected && styles.reminderCooldownChipSelected,
                        pressed && styles.reminderCooldownChipPressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Cooldown ${p.a11y}`}
                    >
                      <Text
                        style={[
                          styles.reminderCooldownChipText,
                          selected && styles.reminderCooldownChipTextSelected,
                        ]}
                        numberOfLines={1}
                      >
                        {p.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            {reminderHadClearWhenOpened && onReminderClear ? (
              <Pressable
                onPress={() => {
                  onReminderClear();
                  closeReminderModal();
                }}
                style={styles.reminderClearBtn}
                accessibilityRole="button"
                accessibilityLabel="Clear reminder for this location"
              >
                <Text style={styles.reminderClearBtnText}>Clear reminder</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Modal>

      <Modal
        visible={healthTooltipOpen}
        transparent
        animationType="fade"
        onRequestClose={closeHealthTooltip}
      >
        <View style={styles.healthTooltipModalRoot} pointerEvents="box-none">
          <Pressable
            style={styles.reminderModalBackdrop}
            onPress={closeHealthTooltip}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
          {healthTooltipAnchor ? (
            <HealthStatsTooltipBubble
              anchor={healthTooltipAnchor}
              predPm25={panel.kind === 'ok' ? panel.predPm25 : null}
              onMortalityLink={openMortalityPaperLink}
              onBmjLink={openBmjPaperLink}
              onOutdoorMaskLink={openOutdoorMaskPaperLink}
              onIndoorFilterLink={openIndoorFilterPaperLink}
              placement={healthTooltipPlacement}
              winW={winW}
              winH={winH}
            />
          ) : null}
        </View>
      </Modal>
    </LinearGradient>
  );
}

type PanelState =
  | { kind: 'placeholder' }
  | { kind: 'oob'; lat: number; lon: number }
  | { kind: 'msg'; msg: string }
  | {
      kind: 'ok';
      lat: number;
      lon: number;
      predPm25: number | null;
      predPm25Category: Pm25Category;
      predAqi: number | null;
      aqiCat: AqiCategory;
      closest: { lat: number; lon: number; pm25: number; distKm: number } | null;
    };

function CompactPanelBody({
  panel,
  metric,
  setMetric,
  heroAccent,
  heroValueSize,
  cardValueSize,
  onHealthHelpPress,
  healthHelpAnchorRef,
}: {
  panel: PanelState;
  metric: Metric;
  setMetric: (m: Metric) => void;
  heroAccent: string;
  heroValueSize: number;
  cardValueSize: number;
  onHealthHelpPress?: () => void;
  healthHelpAnchorRef: RefObject<View | null>;
}) {
  if (panel.kind === 'oob') {
    return (
      <View style={styles.compactMsgBox}>
        <Text style={styles.compactMsgBody}>
          Those coordinates aren’t inside the configured map area.
        </Text>
        <Text style={styles.compactCoordsMono}>
          {panel.lat.toFixed(5)}, {panel.lon.toFixed(5)}
        </Text>
      </View>
    );
  }
  if (panel.kind === 'msg') {
    return <Text style={styles.compactMsgBody}>{panel.msg}</Text>;
  }

  const ph = panel.kind === 'placeholder';
  const okPanel = panel.kind === 'ok';

  const heroMainValue = ph
    ? '—'
    : metric === 'aqi'
      ? panel.predAqi != null
        ? String(panel.predAqi)
        : '—'
      : panel.predPm25 != null && Number.isFinite(panel.predPm25)
        ? panel.predPm25.toFixed(1)
        : '—';

  const gradColors = ph
    ? ([hexToRgba('#cbd5e1', 0.35), 'rgba(255,255,255,0.88)'] as const)
    : ([hexToRgba(heroAccent, 0.17), 'rgba(255,255,255,0.76)'] as const);
  const shadowC = ph ? '#94a3b8' : heroAccent;

  return (
    <>
      <View style={styles.compactCoordsRow}>
        <Text style={styles.compactCoords} numberOfLines={1}>
          {ph ? '-, -.' : `${panel.lat.toFixed(5)}, ${panel.lon.toFixed(5)}`}
        </Text>
      </View>

      <LinearGradient
        colors={gradColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.compactHeroGrad, { shadowColor: shadowC }, styles.compactHeroShadow]}
      >
        <View
          style={[
            styles.compactHeroMain,
            onHealthHelpPress != null ? styles.compactHeroMainWithHelp : null,
          ]}
        >
          {onHealthHelpPress ? (
            <Pressable
              ref={healthHelpAnchorRef}
              onPress={onHealthHelpPress}
              hitSlop={8}
              style={styles.heroHelpBtnCompact}
              accessibilityRole="button"
              accessibilityLabel="Health summary for this estimate"
            >
              <Text style={styles.heroHelpBtnMarkCompact}>?</Text>
            </Pressable>
          ) : null}
          <Text style={styles.compactHeroLabel}>
            {metric === 'aqi' ? 'Predicted AQI' : 'Predicted PM2.5'}
          </Text>
          <View style={styles.compactHeroValueRow}>
            <Text style={[styles.compactHeroValue, { fontSize: heroValueSize }]}>{heroMainValue}</Text>
            <Text style={styles.compactHeroUnit}>{metric === 'aqi' ? 'AQI' : 'µg/m³'}</Text>
            <View style={styles.compactBadge}>
              <Text style={styles.compactBadgeText} numberOfLines={1}>
                {ph ? 'No data' : metric === 'aqi' ? panel.aqiCat.label : panel.predPm25Category.label}
              </Text>
            </View>
          </View>
        </View>
        <View style={styles.compactToggle}>
          <View style={styles.metricToggleCompact}>
            <Pressable
              onPress={() => setMetric('pm25')}
              style={[styles.metricPillCompact, metric === 'pm25' && styles.metricPillActive]}
            >
              <Text
                style={[styles.metricPillTextCompact, metric === 'pm25' && styles.metricPillTextActive]}
              >
                PM2.5
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setMetric('aqi')}
              style={[styles.metricPillCompact, metric === 'aqi' && styles.metricPillActive]}
            >
              <Text style={[styles.metricPillTextCompact, metric === 'aqi' && styles.metricPillTextActive]}>
                AQI
              </Text>
            </Pressable>
          </View>
        </View>
      </LinearGradient>

      {ph || okPanel ? (
        <View style={styles.compactCardsRow}>
          <MiniCard
            k="Closest sensor"
            v={
              ph
                ? '—'
                : panel.closest
                  ? metric === 'aqi'
                    ? `${pm25ToAqi(panel.closest.pm25) ?? '—'} AQI`
                    : `${panel.closest.pm25.toFixed(1)} µg/m³`
                  : '—'
            }
            sub={ph ? 'Click the map to see the nearest sensor' : 'Nearest observed sensor reading'}
            valueFontSize={cardValueSize}
            compact
          />
          <MiniCard
            k="Sensor distance"
            v={
              ph || !panel.closest ? '—' : `${milesBetweenKm(panel.closest.distKm).toFixed(2)} mi`
            }
            sub="Great-circle distance"
            valueFontSize={cardValueSize}
            compact
          />
        </View>
      ) : null}
    </>
  );
}

function MiniCard({
  k,
  v,
  sub,
  valueFontSize,
  compact: compactCard,
}: {
  k: string;
  v: string;
  sub: string;
  valueFontSize: number;
  compact?: boolean;
}) {
  return (
    <View style={[styles.mini, compactCard && styles.miniCompact]}>
      <Text style={[styles.miniK, compactCard && styles.miniKCompact]}>{k}</Text>
      <Text
        style={[styles.miniV, { fontSize: valueFontSize }, compactCard && styles.miniVCompact]}
        numberOfLines={compactCard ? 2 : 1}
      >
        {v}
      </Text>
      <Text style={[styles.miniSub, compactCard && styles.miniSubCompact]} numberOfLines={compactCard ? 2 : undefined}>
        {sub}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  shellOuter: {
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
    shadowColor: '#020617',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.12,
    shadowRadius: 30,
    elevation: 14,
    width: '100%',
  },
  shellOuterInline: {
    maxWidth: 520,
    alignSelf: 'stretch',
  },
  shell: {
    minWidth: 0,
  },
  shellTop: {
    paddingTop: 10,
    paddingHorizontal: 14,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  shellTopActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  chromeIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  closeBtnText: {
    fontSize: 16,
    color: '#334155',
    fontWeight: '600',
  },
  scrollView: { flexGrow: 0 },
  scroll: {
    paddingHorizontal: 22,
    paddingTop: 4,
    paddingBottom: 24,
    flexGrow: 1,
    gap: 0,
  },
  scrollNarrow: { paddingHorizontal: 16, paddingTop: 0 },
  modernTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
    marginBottom: 6,
  },
  modernTopLeft: { flex: 1, minWidth: 0 },
  metricToggleDock: {
    alignSelf: 'flex-start',
    marginLeft: 16,
    marginTop: -6,
    marginBottom: 6,
    zIndex: 20,
  },
  metricToggle: {
    flexDirection: 'row',
    gap: 10,
    padding: 6,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.12)',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 11,
    elevation: 4,
  },
  metricPill: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.1)',
    backgroundColor: '#fff',
  },
  metricPillActive: {
    backgroundColor: 'rgba(15,23,42,0.92)',
    borderColor: 'rgba(15,23,42,0.18)',
  },
  metricPillText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: '#0f172a',
  },
  metricPillTextActive: { color: 'rgba(255,255,255,0.96)' },
  eyebrow: {
    marginBottom: 6,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: '#64748b',
    textTransform: 'uppercase',
  },
  title: { fontSize: 28, fontWeight: '800', color: '#0f172a', letterSpacing: -0.8 },
  coords: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    fontVariant: ['tabular-nums'],
  },
  heroWrap: {
    marginTop: 20,
    marginBottom: 0,
  },
  hero: {
    position: 'relative',
    borderRadius: 26,
    paddingTop: 24,
    paddingHorizontal: 22,
    paddingBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.07)',
  },
  heroHelpBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    zIndex: 2,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.12)',
  },
  heroHelpBtnMark: {
    fontSize: 16,
    fontWeight: '800',
    color: '#475569',
    marginTop: -1,
  },
  heroShadow: {
    shadowOffset: { width: 0, height: 22 },
    shadowOpacity: 0.28,
    shadowRadius: 26,
    elevation: 10,
  },
  heroInner: { gap: 10 },
  heroLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: '#0f172a',
    opacity: 0.92,
    textTransform: 'uppercase',
  },
  heroRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' },
  heroValue: { fontWeight: '900', color: '#0f172a', letterSpacing: -3 },
  heroUnit: { fontSize: 15, fontWeight: '700', color: '#0f172a', paddingBottom: 10, opacity: 0.92 },
  badge: { alignSelf: 'flex-start', marginTop: 4 },
  badgeText: {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 999,
    overflow: 'hidden',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.2,
    color: '#0f172a',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  grid: { gap: 14 },
  gridAfterToggle: { marginTop: 8 },
  mini: {
    borderRadius: 20,
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 14,
    backgroundColor: 'rgba(255,255,255,0.56)',
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.06)',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  miniK: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: '#64748b',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  miniV: { fontWeight: '800', color: '#0f172a', letterSpacing: -0.5 },
  miniSub: { marginTop: 6, fontSize: 12, color: '#64748b', lineHeight: 18 },
  empty: { paddingVertical: 28, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  emptyMinH: { minHeight: 220 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: '#7c2d12', marginBottom: 8 },
  emptyBody: { fontSize: 15, color: '#475569', textAlign: 'center', lineHeight: 22 },
  emptyCoords: {
    marginTop: 10,
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    color: '#475569',
  },

  shellOuterCompact: {
    borderRadius: 18,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.1,
    shadowRadius: 18,
    elevation: 10,
  },
  shellOuterSheetFlex: {
    alignSelf: 'stretch',
  },
  shellSheetFlex: {
    minWidth: 0,
  },
  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  sheetTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
    color: '#0f172a',
    letterSpacing: -0.3,
  },
  sheetTitleActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  chromeIconBtnSheet: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  reminderModalRoot: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 22,
  },
  reminderModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15,23,42,0.45)',
  },
  reminderModalCard: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.1)',
    shadowColor: '#020617',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 12,
    zIndex: 2,
  },
  reminderModalTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  reminderModalHint: {
    fontSize: 12,
    color: '#64748b',
    lineHeight: 17,
    marginBottom: 12,
  },
  reminderColorList: {
    gap: 6,
  },
  reminderColorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(241,245,249,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.06)',
  },
  reminderColorRowSaved: {
    borderColor: '#2563eb',
    backgroundColor: 'rgba(37, 99, 235, 0.1)',
  },
  reminderColorRowPressed: {
    backgroundColor: 'rgba(226,232,240,0.95)',
  },
  reminderColorRowPressedSaved: {
    backgroundColor: 'rgba(37, 99, 235, 0.18)',
  },
  reminderSwatch: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.12)',
  },
  reminderColorLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
  reminderColorLabelSaved: {
    color: '#1d4ed8',
  },
  reminderBandRange: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    fontVariant: ['tabular-nums'],
  },
  reminderBandRangeSaved: {
    color: '#2563eb',
  },
  reminderCooldownBlock: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(15,23,42,0.08)',
  },
  reminderCooldownLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 4,
  },
  reminderCooldownHint: {
    fontSize: 11,
    color: '#64748b',
    lineHeight: 15,
    marginBottom: 10,
  },
  reminderCooldownChips: {
    flexDirection: 'row',
    alignItems: 'stretch',
    width: '100%',
    gap: 4,
  },
  reminderCooldownChip: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(241,245,249,0.95)',
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.08)',
  },
  reminderCooldownChipSelected: {
    backgroundColor: 'rgba(37, 99, 235, 0.12)',
    borderColor: '#2563eb',
  },
  reminderCooldownChipPressed: {
    opacity: 0.85,
  },
  reminderCooldownChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  reminderCooldownChipTextSelected: {
    color: '#1d4ed8',
  },
  reminderClearBtn: {
    marginTop: 14,
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  reminderClearBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#b91c1c',
  },
  healthTooltipModalRoot: {
    flex: 1,
  },
  healthTooltipWrap: {
    position: 'absolute',
    zIndex: 3,
    overflow: 'visible',
  },
  healthTooltipArrowUp: {
    position: 'absolute',
    top: -7,
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderBottomWidth: 7,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: 'rgba(255,255,255,0.98)',
    zIndex: 2,
  },
  healthTooltipArrowDown: {
    position: 'absolute',
    bottom: -7,
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderTopWidth: 7,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: 'rgba(255,255,255,0.98)',
    zIndex: 2,
  },
  healthTooltipCard: {
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.1)',
    shadowColor: '#020617',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 10,
  },
  healthTooltipTableRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  healthTooltipRowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(15,23,42,0.12)',
    marginVertical: 10,
  },
  healthTooltipSilentLeft: {
    flex: 1,
    minWidth: 0,
  },
  healthTooltipSilentRight: {
    flexShrink: 0,
    flexDirection: 'column',
    alignItems: 'flex-end',
    maxWidth: '46%',
    gap: 2,
  },
  healthTooltipErrCi: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    marginTop: 2,
  },
  healthTooltipTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 6,
  },
  healthTooltipSub: {
    fontSize: 12,
    fontWeight: '400',
    color: '#64748b',
    lineHeight: 17,
  },
  healthTooltipEmDash: {
    fontSize: 16,
    fontWeight: '700',
    color: '#94a3b8',
  },
  aqiStatsTdValueRed: {
    fontSize: 15,
    fontWeight: '800',
    color: '#dc2626',
    fontVariant: ['tabular-nums'],
  },
  healthTooltipValueGreen: {
    fontSize: 15,
    fontWeight: '800',
    color: '#15803d',
    fontVariant: ['tabular-nums'],
  },
  aqiStatsLinkInline: {
    fontSize: 12,
    fontWeight: '400',
    color: '#2563eb',
    textDecorationLine: 'underline',
  },
  sheetBody: {
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  compactMsgBox: { alignItems: 'center', paddingVertical: 4 },
  compactMsgBody: { fontSize: 12, color: '#475569', textAlign: 'center', lineHeight: 16 },
  compactCoordsMono: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: '700',
    color: '#475569',
    fontVariant: ['tabular-nums'],
  },
  compactCoordsRow: {
    marginBottom: 6,
  },
  compactCoords: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    fontVariant: ['tabular-nums'],
  },
  compactHeroGrad: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.07)',
    gap: 8,
    flexWrap: 'wrap',
  },
  heroHelpBtnCompact: {
    position: 'absolute',
    top: -2,
    right: 0,
    zIndex: 2,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.1)',
  },
  heroHelpBtnMarkCompact: {
    fontSize: 13,
    fontWeight: '800',
    color: '#475569',
    marginTop: -1,
  },
  compactHeroShadow: {
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 6,
  },
  compactHeroMain: { flex: 1, minWidth: 140, position: 'relative' },
  compactHeroMainWithHelp: { paddingRight: 26 },
  compactHeroLabel: {
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1,
    color: '#0f172a',
    opacity: 0.85,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  compactHeroValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  compactHeroValue: { fontWeight: '900', color: '#0f172a', letterSpacing: -1 },
  compactHeroUnit: { fontSize: 11, fontWeight: '700', color: '#0f172a', opacity: 0.9 },
  compactBadge: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    maxWidth: '100%',
  },
  compactBadgeText: { fontSize: 10, fontWeight: '800', color: '#0f172a' },
  compactToggle: { flexShrink: 0 },
  metricToggleCompact: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.12)',
  },
  metricPillCompact: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(15,23,42,0.1)',
    backgroundColor: '#fff',
  },
  metricPillTextCompact: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: '#0f172a',
  },
  compactCardsRow: { flexDirection: 'row', gap: 8, marginTop: 6, alignItems: 'stretch' },
  miniCompact: {
    flex: 1,
    minWidth: 0,
    paddingTop: 8,
    paddingHorizontal: 8,
    paddingBottom: 8,
    borderRadius: 12,
  },
  miniKCompact: { fontSize: 8, letterSpacing: 0.8, marginBottom: 4 },
  miniVCompact: { letterSpacing: -0.3 },
  miniSubCompact: { marginTop: 2, fontSize: 9, lineHeight: 12 },
});
