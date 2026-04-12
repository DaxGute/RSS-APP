/**
 * Haversine distance and IDW — ported from SSF-AQI `aqi_panel.py` / `map_graph.py`.
 */

import { KM_TO_MI } from './constants/ssf';

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rKm = 6371.0088;
  const lat1r = (lat1 * Math.PI) / 180;
  const lon1r = (lon1 * Math.PI) / 180;
  const lat2r = (lat2 * Math.PI) / 180;
  const lon2r = (lon2 * Math.PI) / 180;
  const dlat = lat2r - lat1r;
  const dlon = lon2r - lon1r;
  const a =
    Math.sin(dlat / 2) ** 2 + Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dlon / 2) ** 2;
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(a)));
  return rKm * c;
}

export function milesBetweenKm(km: number): number {
  return km * KM_TO_MI;
}

/**
 * Inverse-distance weighting at (lon0, lat0); `xs` = longitudes, `ys` = latitudes.
 */
export function idwPoint(
  xs: number[],
  ys: number[],
  vs: number[],
  lon0: number,
  lat0: number,
  opts?: { power?: number; k?: number; eps?: number },
): number | null {
  const power = opts?.power ?? 2.0;
  const k = opts?.k ?? 18;
  const eps = opts?.eps ?? 1e-12;

  const x = xs.map((n) => Number(n));
  const y = ys.map((n) => Number(n));
  const v = vs.map((n) => Number(n));
  const ok = x.map((_, i) => Number.isFinite(x[i]) && Number.isFinite(y[i]) && Number.isFinite(v[i]));
  const xf = x.filter((_, i) => ok[i]);
  const yf = y.filter((_, i) => ok[i]);
  const vf = v.filter((_, i) => ok[i]);
  if (xf.length === 0) return null;

  const d2 = xf.map((xi, i) => (xi - lon0) ** 2 + (yf[i] - lat0) ** 2);
  if (d2.length === 0) return null;

  const kk = Math.max(1, Math.min(k, d2.length));
  const idx = argPartition(d2, kk - 1).slice(0, kk);
  const d2k = idx.map((i) => d2[i]);
  const vk = idx.map((i) => vf[i]);

  const minD = Math.min(...d2k);
  if (minD <= eps) {
    const j = d2k.indexOf(minD);
    return vk[j];
  }

  let num = 0;
  let den = 0;
  for (let i = 0; i < d2k.length; i++) {
    const w = 1 / (d2k[i] + eps) ** (power / 2);
    num += w * vk[i];
    den += w;
  }
  if (!(den > 0)) return null;
  return num / den;
}

/**
 * IDW at (lat0, lon0) using **great-circle distance** (km) for neighbor ordering and weights.
 * `idwPoint` uses Euclidean distance in degrees, which mis-weights neighbors at mid-latitudes
 * and can skew PM2.5 estimates vs observations.
 */
export function idwPointHaversine(
  lats: number[],
  lons: number[],
  vs: number[],
  lat0: number,
  lon0: number,
  opts?: { power?: number; k?: number; epsKm?: number },
): number | null {
  const power = opts?.power ?? 2.0;
  const k = opts?.k ?? 12;
  const epsKm = opts?.epsKm ?? 1e-6;

  const distKm: number[] = [];
  const valOk: boolean[] = [];
  for (let i = 0; i < lats.length; i++) {
    const lat = lats[i];
    const lon = lons[i];
    const v = vs[i];
    const ok = Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(Number(v));
    valOk.push(ok);
    if (!ok) {
      distKm.push(NaN);
      continue;
    }
    distKm.push(haversineKm(lat0, lon0, lat, lon));
  }

  const df: number[] = [];
  const vf: number[] = [];
  for (let i = 0; i < distKm.length; i++) {
    if (valOk[i] && Number.isFinite(distKm[i])) {
      df.push(distKm[i]);
      vf.push(Number(vs[i]));
    }
  }
  if (df.length === 0) return null;

  const kk = Math.max(1, Math.min(k, df.length));
  const idx = argPartition(df, kk - 1).slice(0, kk);
  const dk = idx.map((i) => df[i]);
  const vk = idx.map((i) => vf[i]);

  const minD = Math.min(...dk);
  if (minD <= epsKm) {
    const j = dk.indexOf(minD);
    return vk[j];
  }

  let num = 0;
  let den = 0;
  for (let i = 0; i < dk.length; i++) {
    const w = 1 / (dk[i] + epsKm) ** power;
    num += w * vk[i];
    den += w;
  }
  if (!(den > 0)) return null;
  return num / den;
}

/**
 * Haversine-space dual IDW: same neighbor set as `idwPointHaversine` on `primary`, plus
 * weighted `secondary` (ignores null secondaries in the average).
 */
export function idwPointDualHaversine(
  lats: number[],
  lons: number[],
  primary: number[],
  secondary: (number | null)[],
  lat0: number,
  lon0: number,
  opts?: { power?: number; k?: number; epsKm?: number },
): { primary: number | null; secondary: number | null } {
  const power = opts?.power ?? 2.0;
  const k = opts?.k ?? 12;
  const epsKm = opts?.epsKm ?? 1e-6;

  const df: number[] = [];
  const pf: number[] = [];
  const sf: (number | null)[] = [];
  for (let i = 0; i < lats.length; i++) {
    const lat = lats[i];
    const lon = lons[i];
    const pv = primary[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(Number(pv))) continue;
    df.push(haversineKm(lat0, lon0, lat, lon));
    pf.push(Number(pv));
    sf.push(secondary[i]);
  }
  if (df.length === 0) return { primary: null, secondary: null };

  const kk = Math.max(1, Math.min(k, df.length));
  const idx = argPartition(df, kk - 1).slice(0, kk);
  const dk = idx.map((i) => df[i]);
  const pk = idx.map((i) => pf[i]);
  const sk = idx.map((i) => sf[i]);

  const minD = Math.min(...dk);
  if (minD <= epsKm) {
    const j = dk.indexOf(minD);
    const sec = sk[j];
    return {
      primary: pk[j],
      secondary: sec != null && Number.isFinite(sec) ? sec : null,
    };
  }

  let numP = 0;
  let den = 0;
  let numS = 0;
  let denS = 0;
  for (let i = 0; i < dk.length; i++) {
    const w = 1 / (dk[i] + epsKm) ** power;
    numP += w * pk[i];
    den += w;
    const sv = sk[i];
    if (sv != null && Number.isFinite(sv)) {
      numS += w * sv;
      denS += w;
    }
  }
  if (!(den > 0)) return { primary: null, secondary: null };
  const pOut = numP / den;
  const sOut = denS > 0 ? numS / denS : null;
  return { primary: pOut, secondary: sOut };
}

/**
 * Same neighbor set and IDW weights as `idwPoint` for `primary`, plus a weighted
 * average of `secondary` at those neighbors (only finite secondary values contribute).
 */
export function idwPointDual(
  xs: number[],
  ys: number[],
  primary: number[],
  secondary: (number | null)[],
  lon0: number,
  lat0: number,
  opts?: { power?: number; k?: number; eps?: number },
): { primary: number | null; secondary: number | null } {
  const power = opts?.power ?? 2.0;
  const k = opts?.k ?? 18;
  const eps = opts?.eps ?? 1e-12;

  const x = xs.map((n) => Number(n));
  const y = ys.map((n) => Number(n));
  const pv = primary.map((n) => Number(n));
  const ok = x.map(
    (_, i) => Number.isFinite(x[i]) && Number.isFinite(y[i]) && Number.isFinite(pv[i]),
  );
  const xf = x.filter((_, i) => ok[i]);
  const yf = y.filter((_, i) => ok[i]);
  const pf = pv.filter((_, i) => ok[i]);
  const origIdx = ok.map((o, i) => (o ? i : -1)).filter((i) => i >= 0);
  const sf = origIdx.map((i) => secondary[i]);

  if (xf.length === 0) return { primary: null, secondary: null };

  const d2 = xf.map((xi, i) => (xi - lon0) ** 2 + (yf[i] - lat0) ** 2);
  const kk = Math.max(1, Math.min(k, d2.length));
  const idx = argPartition(d2, kk - 1).slice(0, kk);
  const d2k = idx.map((i) => d2[i]);
  const pk = idx.map((i) => pf[i]);
  const sk = idx.map((i) => sf[i]);

  const minD = Math.min(...d2k);
  if (minD <= eps) {
    const j = d2k.indexOf(minD);
    const sec = sk[j];
    return {
      primary: pk[j],
      secondary: sec != null && Number.isFinite(sec) ? sec : null,
    };
  }

  let numP = 0;
  let den = 0;
  let numS = 0;
  let denS = 0;
  for (let i = 0; i < d2k.length; i++) {
    const w = 1 / (d2k[i] + eps) ** (power / 2);
    numP += w * pk[i];
    den += w;
    const sv = sk[i];
    if (sv != null && Number.isFinite(sv)) {
      numS += w * sv;
      denS += w;
    }
  }
  if (!(den > 0)) return { primary: null, secondary: null };
  const pOut = numP / den;
  const sOut = denS > 0 ? numS / denS : null;
  return { primary: pOut, secondary: sOut };
}

/** Indices of n smallest elements (partial sort). */
function argPartition(d2: number[], n: number): number[] {
  const idx = d2.map((_, i) => i);
  idx.sort((a, b) => d2[a] - d2[b]);
  return idx.slice(0, n + 1);
}
