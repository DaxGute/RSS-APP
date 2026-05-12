/** South San Francisco map bounds — matches SSF-AQI `app.py`. */
export const NW_LAT = 37.7000;
export const NW_LNG = -122.4600;
export const SE_LAT = 37.6200;
export const SE_LNG = -122.3600;

export const SSF_BBOX = {
  nwLat: NW_LAT,
  nwLon: NW_LNG,
  seLat: SE_LAT,
  seLon: SE_LNG,
} as const;

/** Corners for `MapView.setMapBoundaries` (pan/zoom clamped inside this rectangle). */
export const SSF_MAP_BOUNDARIES = {
  northEast: { latitude: NW_LAT, longitude: SE_LNG },
  southWest: { latitude: SE_LAT, longitude: NW_LNG },
} as const;

export const POLL_INTERVAL_MS = 30_000;

/** Extra window on each end of rolling 24h queries so pipeline `time` and client clocks do not clip rows. */
export const ROLLING_24H_TIME_WINDOW_BUFFER_MS = 15 * 60 * 1000;

export const KM_TO_MI = 0.621371192237334;
