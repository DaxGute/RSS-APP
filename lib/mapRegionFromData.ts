import type { CurrentKrigingRow } from './database.types';
import { SSF_BBOX } from './constants/ssf';
import type { SensorPoint } from './sensorTypes';

/** Viewport rectangle (center + span), same shape as the former `react-native-maps` Region. */
export type MapRegion = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

/** Initial/fixed viewport: exactly the SSF bounding box (no extra padding). */
export function regionFromSsfBbox(): MapRegion {
  const { nwLat, nwLon, seLat, seLon } = SSF_BBOX;
  return {
    latitude: (nwLat + seLat) / 2,
    longitude: (nwLon + seLon) / 2,
    latitudeDelta: Math.abs(nwLat - seLat),
    longitudeDelta: Math.abs(seLon - nwLon),
  };
}

/**
 * Map viewport for SSF: always the static bbox above (pan/zoom limits applied in `SsfMap`).
 * Sensor/kriging args are kept for call-site stability.
 */
export function regionFromSensorData(_sensors: SensorPoint[], _kriging: CurrentKrigingRow[]): MapRegion {
  return regionFromSsfBbox();
}

/** True if the point lies inside the rectangle implied by `region` (center ± half deltas). */
export function coordinateInRegion(lat: number, lon: number, region: MapRegion): boolean {
  const latMin = region.latitude - region.latitudeDelta / 2;
  const latMax = region.latitude + region.latitudeDelta / 2;
  const lonMin = region.longitude - region.longitudeDelta / 2;
  const lonMax = region.longitude + region.longitudeDelta / 2;
  return lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax;
}

/** ~1e-4° ≈ 11 m — avoids dropping edge cells to float error; optional pipeline bbox mismatch. */
const REGION_SLACK_DEG = 2e-4;

/** Like `coordinateInRegion`, but expands the box by `slackDeg` on each side (default `REGION_SLACK_DEG`). */
export function coordinateInRegionSlack(
  lat: number,
  lon: number,
  region: MapRegion,
  slackDeg: number = REGION_SLACK_DEG,
): boolean {
  const latMin = region.latitude - region.latitudeDelta / 2 - slackDeg;
  const latMax = region.latitude + region.latitudeDelta / 2 + slackDeg;
  const lonMin = region.longitude - region.longitudeDelta / 2 - slackDeg;
  const lonMax = region.longitude + region.longitudeDelta / 2 + slackDeg;
  return lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax;
}

const SSF_NORTH = SSF_BBOX.nwLat;
const SSF_SOUTH = SSF_BBOX.seLat;
const SSF_WEST = SSF_BBOX.nwLon;
const SSF_EAST = SSF_BBOX.seLon;
const SSF_SPAN_LAT = SSF_NORTH - SSF_SOUTH;
const SSF_SPAN_LON = SSF_EAST - SSF_WEST;

/**
 * Adjusts `region` so the visible map rectangle (center ± half deltas) lies fully inside the SSF bbox.
 * Unlike SDK camera-target bounds, this matches what the user actually sees.
 */
export function clampMapRegionToSsfBbox(region: MapRegion): MapRegion {
  let latD = Math.min(region.latitudeDelta, SSF_SPAN_LAT);
  let lonD = Math.min(region.longitudeDelta, SSF_SPAN_LON);

  const halfLat = latD / 2;
  const halfLon = lonD / 2;

  let minLat = SSF_SOUTH + halfLat;
  let maxLat = SSF_NORTH - halfLat;
  let minLon = SSF_WEST + halfLon;
  let maxLon = SSF_EAST - halfLon;

  let lat = region.latitude;
  let lon = region.longitude;

  if (minLat > maxLat) {
    latD = SSF_SPAN_LAT;
    minLat = maxLat = (SSF_NORTH + SSF_SOUTH) / 2;
  }
  if (minLon > maxLon) {
    lonD = SSF_SPAN_LON;
    minLon = maxLon = (SSF_WEST + SSF_EAST) / 2;
  }

  lat = Math.min(Math.max(lat, minLat), maxLat);
  lon = Math.min(Math.max(lon, minLon), maxLon);

  return {
    latitude: lat,
    longitude: lon,
    latitudeDelta: latD,
    longitudeDelta: lonD,
  };
}

const CLAMP_EPS = 1e-7;

export function regionNeedsSsfBboxClamp(region: MapRegion): boolean {
  const c = clampMapRegionToSsfBbox(region);
  return (
    Math.abs(c.latitude - region.latitude) > CLAMP_EPS ||
    Math.abs(c.longitude - region.longitude) > CLAMP_EPS ||
    Math.abs(c.latitudeDelta - region.latitudeDelta) > CLAMP_EPS ||
    Math.abs(c.longitudeDelta - region.longitudeDelta) > CLAMP_EPS
  );
}
