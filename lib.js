// Pure helpers (no DOM, no Firebase) so they can be unit-tested in Node.

export const DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
export const PRICE_RANGES = { 1: 'under €15', 2: '€15–30', 3: '€30–60', 4: 'over €60' };

/**
 * Parse a simplified OpenStreetMap opening_hours string.
 * Supports: "24/7", "Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off", several ranges per day
 * ("12:00-14:30,18:00-23:00"), overnight ranges ("18:00-02:00"), day lists ("Mo,We,Fr").
 * Returns an array of 7 days (Mo..Su) of [startMin, endMin] intervals, or null if unknown/unparseable.
 */
export function parseHours(str) {
  if (!str || !str.trim()) return null;
  const s = str.trim();
  if (/^24\/7$/i.test(s)) return Array.from({ length: 7 }, () => [[0, 1440]]);
  const week = Array.from({ length: 7 }, () => null);
  let any = false;
  for (const raw of s.split(';')) {
    const rule = raw.trim();
    if (!rule) continue;
    const m = rule.match(
      /^(.*?)\s*((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})(?:\s*,\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})*|off|closed)$/i
    );
    if (!m) return null;
    const dayPart = m[1].trim();
    const days = [];
    if (!dayPart) {
      for (let d = 0; d < 7; d++) days.push(d);
    } else {
      for (const tok of dayPart.split(',')) {
        const t = tok.trim().toLowerCase();
        if (t === 'ph' || t === 'sh') continue; // holidays: ignored
        const rm = t.match(/^([a-z]{2})(?:\s*-\s*([a-z]{2}))?$/);
        if (!rm) return null;
        const a = DAYS.indexOf(rm[1]);
        const b = rm[2] ? DAYS.indexOf(rm[2]) : a;
        if (a < 0 || b < 0) return null;
        for (let d = a; ; d = (d + 1) % 7) {
          days.push(d);
          if (d === b) break;
        }
      }
      if (!days.length) continue;
    }
    let intervals = [];
    if (!/^(off|closed)$/i.test(m[2])) {
      for (const part of m[2].split(',')) {
        const t = part.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
        if (!t) return null;
        const start = +t[1] * 60 + +t[2];
        let end = +t[3] * 60 + +t[4];
        if (end <= start) end += 1440; // overnight
        intervals.push([start, end]);
      }
    }
    for (const d of days) week[d] = intervals;
    any = true;
  }
  if (!any) return null;
  return week.map((x) => x || []);
}

/** true / false, or null when hours are missing or can't be understood. */
export function isOpenNow(str, now = new Date()) {
  const week = parseHours(str);
  if (!week) return null;
  const d = (now.getDay() + 6) % 7; // Monday = 0
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = week[d].some(([a, b]) => mins >= a && mins < b);
  const spill = week[(d + 6) % 7].some(([, b]) => b > 1440 && mins < b - 1440);
  return today || spill;
}

export function haversine(a, b) {
  const R = 6371000;
  const t = (x) => (x * Math.PI) / 180;
  const dLat = t(b.lat - a.lat);
  const dLon = t(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Average walking speed 5 km/h ≈ 83 m per minute, applied to the straight-line distance. */
export function walkMinutes(m) {
  return Math.max(1, Math.round(m / 83.3));
}

export function fmtDistance(m) {
  if (m < 1000) return Math.max(10, Math.round(m / 10) * 10) + ' m';
  return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
}

/** Average of the rated criteria only (0 = not rated). Returns 0 when nothing is rated. */
export function avgRating(r) {
  const v = [r?.food, r?.vibe, r?.value].filter((x) => x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

export function cityFrom(a = {}) {
  if ((a['ISO3166-2-lvl4'] || '') === 'BE-BRU' || /brussel|bruxelles/i.test(a.state || '')) return 'Brussels';
  const c = a.city || a.town || a.village || a.municipality || a.county || '';
  return c.replace(/^city of /i, '');
}

/** Convert a Nominatim result into our place fields. */
export function placeFromNominatim(r) {
  const a = r.address || {};
  const city = cityFrom(a);
  const street = [a.road || a.pedestrian || a.footway || '', a.house_number || ''].join(' ').trim();
  const muni = (a.city || a.town || a.village || a.municipality || city).replace(/^city of /i, '');
  const zipCity = [a.postcode || '', muni].join(' ').trim();
  const address = [street, zipCity].filter(Boolean).join(', ') || (r.display_name || '');
  return {
    name: r.name || '',
    address,
    city,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    hours: r.extratags?.opening_hours || '',
  };
}

export function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Nearest city (by centroid of its places) within maxKm of pos, else null. */
export function nearestCity(places, pos, maxKm = 40) {
  const g = {};
  for (const p of places) {
    if (!p.city || p.lat == null || p.lon == null) continue;
    (g[p.city] ||= []).push(p);
  }
  let best = null;
  let bestD = Infinity;
  for (const [city, arr] of Object.entries(g)) {
    const c = {
      lat: arr.reduce((s, p) => s + p.lat, 0) / arr.length,
      lon: arr.reduce((s, p) => s + p.lon, 0) / arr.length,
    };
    const d = haversine(pos, c);
    if (d < bestD) {
      bestD = d;
      best = city;
    }
  }
  return bestD <= maxKm * 1000 ? best : null;
}
