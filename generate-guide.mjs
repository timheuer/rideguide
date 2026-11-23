import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(root, "rides.yaml");
const outputPath = resolve(root, "ride-guide.html");
const indexPath = resolve(root, "index.html");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requireText(value, field, rideNumber) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`rides[${rideNumber}].${field} must be a non-empty string.`);
  }

  return value.trim();
}

function validateRide(ride, index) {
  const field = `rides[${index}]`;
  if (ride === null || typeof ride !== "object" || Array.isArray(ride)) {
    throw new Error(`${field} must be an object.`);
  }

  const routeName = requireText(ride.route_name, "route_name", index);
  const routeValue = requireText(ride.gpx_url, "gpx_url", index);
  let routeUrl;
  try {
    routeUrl = new URL(routeValue);
  } catch {
    throw new Error(`${field}.gpx_url must be a valid http(s) URL.`);
  }
  if (routeUrl.protocol !== "https:" && routeUrl.protocol !== "http:") {
    throw new Error(`${field}.gpx_url must be a valid http(s) URL.`);
  }

  const description = requireText(ride.description, "description", index);
  const startLocation = requireText(ride.start_location, "start_location", index);
  if (ride.distance === null || typeof ride.distance !== "object" || Array.isArray(ride.distance)) {
    throw new Error(`${field}.distance must include kilometers (or miles).`);
  }

  const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const { kilometers, miles } = ride.distance;
  if (!positive(kilometers) && !positive(miles)) {
    throw new Error(`${field}.distance.kilometers must be a positive number.`);
  }
  // Kilometers win when present; miles are derived and rounded up to a whole number.
  const km = positive(kilometers) ? kilometers : miles * 1.609344;
  const derivedMiles = positive(kilometers) ? Math.ceil(kilometers * 0.621371) : miles;

  if (ride.gpx_file !== undefined && (typeof ride.gpx_file !== "string" || ride.gpx_file.trim() === "")) {
    throw new Error(`${field}.gpx_file must be a non-empty path when provided.`);
  }

  return {
    routeName,
    gpxFile: ride.gpx_file?.trim(),
    routeUrl: routeUrl.href,
    description,
    startLocation,
    miles: derivedMiles,
    kilometers: Math.round(km),
  };
}

const FEET_PER_METER = 3.28084;

function haversine(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

function parseGpx(text) {
  const tag = /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  const points = [];
  for (const match of text.matchAll(tag)) {
    const lat = Number(/\blat\s*=\s*["']([^"']+)["']/.exec(match[2])?.[1]);
    const lon = Number(/\blon\s*=\s*["']([^"']+)["']/.exec(match[2])?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eleText = /<ele>\s*([^<\s]+)\s*<\/ele>/.exec(match[3] ?? "")?.[1];
    const ele = eleText === undefined ? NaN : Number(eleText);
    points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }
  return points;
}

function buildTrack(points) {
  if (points.length < 2) return null;
  let dist = 0;
  const pts = points.map((p, i) => {
    if (i > 0) dist += haversine(points[i - 1], p);
    return { ...p, dist };
  });

  const hasEle = pts.every((p) => p.ele !== null);
  let gain = 0;
  let loss = 0;
  if (hasEle) {
    // Smooth, then ignore changes under a threshold to avoid GPS noise inflating climbing.
    const smooth = pts.map((_, i) => {
      const slice = pts.slice(Math.max(0, i - 3), i + 4);
      return slice.reduce((sum, p) => sum + p.ele, 0) / slice.length;
    });
    let ref = smooth[0];
    for (const e of smooth) {
      if (e - ref >= 3) { gain += e - ref; ref = e; }
      else if (ref - e >= 3) { loss += ref - e; ref = e; }
    }
    pts.forEach((p, i) => { p.sele = smooth[i]; });
  }

  return { pts, hasEle, totalMeters: dist, gainMeters: gain, lossMeters: loss };
}

async function loadTrack(ride) {
  if (!ride.gpxFile) return null;
  let text;
  try {
    text = await readFile(resolve(root, ride.gpxFile), "utf8");
  } catch {
    console.warn(`Warning: could not read GPX file "${ride.gpxFile}" for ${ride.routeName}; map and elevation skipped.`);
    return null;
  }
  const track = buildTrack(parseGpx(text));
  if (!track) console.warn(`Warning: "${ride.gpxFile}" has no usable track points; map and elevation skipped.`);
  return track;
}

const num = (n) => Math.round(n * 10) / 10;

function directionArrows(xy, spacing = 120) {
  const total = xy.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - xy[i - 1][0], p[1] - xy[i - 1][1]) : 0), 0);
  if (total < spacing) return "";
  let out = "";
  let walked = 0;
  let next = spacing / 2;
  for (let i = 1; i < xy.length; i++) {
    const [x0, y0] = xy[i - 1];
    const [x1, y1] = xy[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    while (seg > 0 && walked + seg >= next) {
      const t = (next - walked) / seg;
      const angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
      out += `<path d="M-4 -6.5L3 0L-4 6.5" transform="translate(${num(x0 + (x1 - x0) * t)} ${num(y0 + (y1 - y0) * t)}) rotate(${num(angle)})" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
      next += spacing;
    }
    walked += seg;
  }
  return out;
}

function renderMap(track) {
  const W = 800;
  const H = 420;
  const { pts } = track;
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const world = (lat, lon, z) => {
    const scale = 256 * 2 ** z;
    const s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * scale, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale];
  };

  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  let z = 16;
  for (; z > 2; z--) {
    const [x1, y1] = world(maxLat, minLon, z);
    const [x2, y2] = world(minLat, maxLon, z);
    if (x2 - x1 <= W * 0.8 && y2 - y1 <= H * 0.8) break;
  }

  const [cx1, cy1] = world(maxLat, minLon, z);
  const [cx2, cy2] = world(minLat, maxLon, z);
  const originX = (cx1 + cx2) / 2 - W / 2;
  const originY = (cy1 + cy2) / 2 - H / 2;
  const maxTile = 2 ** z;

  let tiles = "";
  for (let tx = Math.floor(originX / 256); tx <= Math.floor((originX + W) / 256); tx++) {
    for (let ty = Math.floor(originY / 256); ty <= Math.floor((originY + H) / 256); ty++) {
      if (ty < 0 || ty >= maxTile) continue;
      const wrappedX = ((tx % maxTile) + maxTile) % maxTile;
      tiles += `<image href="https://tile.openstreetmap.org/${z}/${wrappedX}/${ty}.png" x="${num(tx * 256 - originX)}" y="${num(ty * 256 - originY)}" width="256" height="256"/>`;
    }
  }

  const xy = pts.map((p) => {
    const [x, y] = world(p.lat, p.lon, z);
    return [x - originX, y - originY];
  });
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${num(x)} ${num(y)}`).join("");
  const arrows = directionArrows(xy);
  const [sx, sy] = xy[0];
  const [ex, ey] = xy[xy.length - 1];

  return `<svg class="map" data-coordinates="${escapeHtml(JSON.stringify(pts.map((p) => [p.lon, p.lat])))}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Route map" preserveAspectRatio="xMidYMid slice">
          <rect width="${W}" height="${H}" fill="#e8ece6"/>
          ${tiles}
          <path class="route-line" d="${line}" fill="none" stroke="#fffefa" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
          <path class="route-line" d="${line}" fill="none" stroke="#c4622d" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
          <g class="route-arrows">${arrows}</g>
          <circle cx="${num(sx)}" cy="${num(sy)}" r="7" fill="#173c38" stroke="#fffefa" stroke-width="3"/>
          <circle cx="${num(ex)}" cy="${num(ey)}" r="7" fill="#c4622d" stroke="#fffefa" stroke-width="3"/>
          <circle class="route-position" cx="${num(sx)}" cy="${num(sy)}" r="6" fill="#173c38" stroke="#fffefa" stroke-width="3"/>
          <text x="${W - 8}" y="${H - 8}" text-anchor="end" font-size="11" fill="#2b3a37" stroke="#fffefa" stroke-width="3" paint-order="stroke">&copy; OpenStreetMap contributors</text>
        </svg>`;
}

function niceStep(range, target) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
}

function renderElevation(track) {
  const W = 800, H = 190;
  const m = { l: 52, r: 16, t: 14, b: 30 };
  const totalKm = track.totalMeters / 1000;
  const step = Math.max(1, Math.floor(track.pts.length / 400));
  const sampled = track.pts.filter((_, i) => i % step === 0 || i === track.pts.length - 1);
  const metres = sampled.map((p) => p.sele);
  const lo = Math.min(...metres), hi = Math.max(...metres);
  const yStep = niceStep(Math.max(hi - lo, 20), 4);
  const yMin = Math.floor(lo / yStep) * yStep;
  const yMax = Math.max(Math.ceil(hi / yStep) * yStep, yMin + yStep);
  const px = (km) => m.l + (km / totalKm) * (W - m.l - m.r);
  const py = (v) => m.t + (1 - (v - yMin) / (yMax - yMin)) * (H - m.t - m.b);

  let grid = "";
  for (let v = yMin; v <= yMax + 1e-6; v += yStep) {
    grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${num(py(v))}" y2="${num(py(v))}" stroke="#dce2dc"/><text x="${m.l - 8}" y="${num(py(v) + 4)}" text-anchor="end">${Math.round(v).toLocaleString("en-US")}</text>`;
  }
  const xStep = niceStep(totalKm, 6);
  for (let v = 0; v <= totalKm + 1e-6; v += xStep) {
    grid += `<text x="${num(px(v))}" y="${H - 8}" text-anchor="middle">${num(v)}</text>`;
  }

  const coords = sampled.map((p, i) => `${num(px(p.dist / 1000))} ${num(py(metres[i]))}`);
  const base = num(py(yMin));
  const area = `M${px(0)} ${base}L${coords.join("L")}L${num(px(totalKm))} ${base}Z`;

  return `<svg class="elevation" viewBox="0 0 ${W} ${H}" role="img" aria-label="Elevation profile">
          <g font-size="11" fill="#61716c">${grid}</g>
          <path d="${area}" fill="#315a52" fill-opacity=".22"/>
          <path d="M${coords.join("L")}" fill="none" stroke="#173c38" stroke-width="2" stroke-linejoin="round"/>
          <text x="${m.l}" y="11" font-size="10" fill="#61716c">m</text>
          <text x="${W - m.r}" y="${H - 8}" font-size="10" text-anchor="end" fill="#61716c">km</text>
        </svg>`;
}

const metric = (meters) => Math.round(meters).toLocaleString("en-US");

function renderTrack(track, index) {
  if (!track) return "";
  let elevation = "";
  if (track.hasEle) {
    const elevations = track.pts.map((p) => p.sele);
    elevation = `
      <div class="profile">
        <h3>Elevation profile</h3>
        <ul class="profile-stats">
          <li><strong>${metric(track.gainMeters)} m</strong> climbing</li>
          <li><strong>${metric(track.lossMeters)} m</strong> descending</li>
          <li><strong>${metric(Math.max(...elevations))} m</strong> high point</li>
          <li><strong>${metric(Math.min(...elevations))} m</strong> low point</li>
        </ul>
        ${renderElevation(track)}
      </div>`;
  }
  return `
      <div class="route-map">
        <h3>Route map</h3>
        <div class="map-frame">
          ${renderMap(track)}
          <div class="follow-map" hidden aria-label="Perspective route map"></div>
          <button class="map-play" type="button" hidden>Play route</button>
        </div>
        <div class="map-controls" hidden>
          <label for="route-speed-${index}">Draw speed</label>
          <input id="route-speed-${index}" type="range" min="0.5" max="3" step="0.25" value="1">
          <output for="route-speed-${index}">1&times;</output>
          <label class="follow-control" hidden><input type="checkbox"> Perspective follow</label>
          <span class="follow-status" role="status"></span>
        </div>
      </div>${elevation}`;
}

function renderDescription(description) {
  return description
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim().replace(/\s*\n\s*/g, " "))
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n");
}

function renderRide(ride, index) {
  const number = String(index + 1).padStart(2, "0");
  const id = `ride-${index + 1}`;
  return `
    <article class="ride-card" id="${id}">
      <header class="ride-header">
        <p class="eyebrow">Ride ${number}</p>
        <h2>${escapeHtml(ride.routeName)}</h2>
      </header>
      <div class="ride-facts">
        <div class="fact">
          <span class="fact-label">Distance</span>
          <span class="fact-value">${escapeHtml(ride.kilometers)} <span class="unit">km</span></span>
          <span class="fact-secondary">${escapeHtml(ride.miles)} mi</span>
        </div>
        ${ride.track?.hasEle ? `<div class="fact">
          <span class="fact-label">Elevation gain</span>
          <span class="fact-value">${metric(ride.track.gainMeters)} <span class="unit">m</span></span>
          <span class="fact-secondary">${Math.round(ride.track.gainMeters * FEET_PER_METER).toLocaleString("en-US")} ft</span>
        </div>` : ""}
        <div class="fact">
          <span class="fact-label">Start</span>
          <span class="fact-value fact-location">${escapeHtml(ride.startLocation)}</span>
        </div>
      </div>
      ${renderTrack(ride.track, index)}
      <div class="route-notes">
        <h3>Route notes</h3>
        <div class="description">${renderDescription(ride.description)}</div>
      </div>
      <a class="route-link" href="${escapeHtml(ride.routeUrl)}" target="_blank" rel="noopener noreferrer">
        <span>Open route on Strava</span>
        <span class="arrow" aria-hidden="true">&rarr;</span>
      </a>
    </article>`;
}

function renderIndex(ride, index) {
  return `
    <a class="index-row" href="#ride-${index + 1}">
      <span class="index-number">${String(index + 1).padStart(2, "0")}</span>
      <span class="index-name">${escapeHtml(ride.routeName)}</span>
      <span class="index-distance">${escapeHtml(ride.kilometers)} km</span>
    </a>`;
}

export async function buildHtml() {
  const mapboxToken = process.env.MAPBOX_PUBLIC_TOKEN?.trim() ?? "";
  if (mapboxToken && !mapboxToken.startsWith("pk.")) {
    throw new Error("MAPBOX_PUBLIC_TOKEN must be a Mapbox public token starting with pk.");
  }
  const yamlText = await readFile(sourcePath, "utf8");
  const data = parse(yamlText);
  if (data === null || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.rides)) {
    throw new Error("rides.yaml must contain a top-level rides list.");
  }
  if (data.rides.length === 0) {
    throw new Error("rides.yaml must contain at least one ride.");
  }

  const rides = data.rides.map(validateRide);
  for (const ride of rides) {
    ride.track = await loadTrack(ride);
  }
  const rideCount = rides.length;
  const rideLabel = rideCount === 1 ? "ride" : "rides";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">${mapboxToken ? `\n  <meta name="mapbox-token" content="${escapeHtml(mapboxToken)}">` : ""}
  <title>Ride Guide</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --display: "Outfit", "Avenir Next", "Segoe UI", system-ui, sans-serif;
      color-scheme: light;
      --ink: #1b302e;
      --muted: #61716c;
      --pine: #173c38;
      --pine-light: #315a52;
      --sand: #f0eee6;
      --paper: #fffefa;
      --line: #dce2dc;
      --clay: #d58c63;
    }

    * { box-sizing: border-box; }

    html { scroll-behavior: smooth; }

    body {
      margin: 0;
      background: var(--sand);
      color: var(--ink);
      font-family: "Aptos", "Segoe UI", Arial, sans-serif;
      font-size: 16px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }

    a { color: inherit; }

    .guide {
      width: min(100% - 40px, 1080px);
      margin: 36px auto 72px;
    }

    .cover {
      position: relative;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      padding: 22px 32px;
      border-radius: 14px;
      background: linear-gradient(128deg, #173c38 0%, #234b44 57%, #315a52 100%);
      border-bottom: 4px solid #d58c63;
      color: #fffefa;
    }

    .cover-sub {
      color: #f2c5a5;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .15em;
      text-transform: uppercase;
    }

    .eyebrow {
      margin: 0 0 12px;
      color: var(--pine-light);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .15em;
      text-transform: uppercase;
    }

    .cover .eyebrow { color: #f2c5a5; }

    h1, h2, h3, p { margin-top: 0; }

    h1 {
      margin: 0;
      font-family: var(--display);
      font-size: clamp(26px, 4vw, 34px);
      font-weight: 700;
      letter-spacing: -.01em;
      line-height: 1.1;
    }

    .contents {
      margin-top: 24px;
      padding: 26px 32px;
      border: 1px solid rgb(27 48 46 / 8%);
      border-radius: 16px;
      background: var(--paper);
      box-shadow: 0 10px 32px rgb(27 48 46 / 5%);
    }

    .contents h2 {
      margin: 0 0 8px;
      font-family: var(--display);
      font-size: 24px;
      font-weight: 600;
    }

    .contents-note {
      margin-bottom: 16px;
      color: var(--muted);
      font-size: 13px;
    }

    .index-row {
      display: grid;
      grid-template-columns: 42px 1fr auto;
      gap: 12px;
      align-items: baseline;
      padding: 11px 0;
      border-top: 1px solid var(--line);
      text-decoration: none;
    }

    .index-row:hover .index-name { color: var(--pine-light); }
    .index-number, .index-distance { color: var(--muted); font-size: 13px; }
    .index-name { font-family: var(--display); font-size: 18px; font-weight: 500; }

    .ride-card {
      margin-top: 28px;
      padding: clamp(28px, 5vw, 52px);
      border: 1px solid rgb(27 48 46 / 8%);
      border-radius: 18px;
      background: var(--paper);
      box-shadow: 0 10px 32px rgb(27 48 46 / 5%);
      scroll-margin-top: 24px;
    }

    .ride-header {
      padding-bottom: 24px;
      border-bottom: 1px solid var(--line);
    }

    .ride-header h2 {
      margin: 0;
      font-family: var(--display);
      font-size: clamp(32px, 6vw, 46px);
      font-weight: 700;
      letter-spacing: -.02em;
      line-height: 1.08;
      overflow-wrap: anywhere;
    }

    .ride-facts {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 18px;
      padding: 24px 0;
      border-bottom: 1px solid var(--line);
    }

    .fact { min-width: 0; }

    .fact-label {
      display: block;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
    }

    .fact-value {
      display: block;
      color: var(--pine);
      font-size: 24px;
      font-weight: 650;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .fact-value .unit { font-size: 15px; font-weight: 500; }
    .fact-secondary { color: var(--muted); font-size: 13px; }
    .fact-location { font-size: 19px; }

    .route-map, .profile { padding-top: 24px; }
    .route-map h3, .profile h3 {
      margin-bottom: 10px;
      color: var(--pine-light);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .13em;
      text-transform: uppercase;
    }
    .map { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 10px; }
    .map-frame { position: relative; }
    .map-frame .follow-map { position: absolute; inset: 0; overflow: hidden; border-radius: 10px; }
    .follow-map[hidden] { display: none; }
    .follow-position { width: 14px; height: 14px; border: 3px solid #fffefa; border-radius: 50%; background: #173c38; }
    .map-play {
      position: absolute;
      z-index: 1;
      bottom: 14px;
      left: 14px;
      border: 1px solid var(--paper);
      border-radius: 999px;
      padding: 9px 15px;
      background: var(--pine);
      color: var(--paper);
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      cursor: pointer;
    }
    .map-play:hover { background: var(--pine-light); }
    .map-play:focus-visible, .map-controls input:focus-visible { outline: 3px solid #c4622d; outline-offset: 3px; }
    .map-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 10px; color: var(--pine); font-size: 13px; font-weight: 650; }
    .map-controls[hidden] { display: none; }
    .map-controls input[type="range"] { width: 150px; accent-color: var(--pine); }
    .follow-control { display: inline-flex; align-items: center; gap: 6px; }
    .follow-control[hidden] { display: none; }
    .follow-control input { accent-color: var(--pine); }
    .follow-status { color: var(--muted); font-weight: 500; }
    .route-map.is-drawing .route-arrows { visibility: hidden; }
    .route-position { visibility: hidden; }
    .route-map.is-drawing .route-position { visibility: visible; }
    .elevation { display: block; width: 100%; height: auto; }
    .profile-stats { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 0 0 8px; padding: 0; color: var(--muted); font-size: 13px; list-style: none; }
    .profile-stats strong { color: var(--pine); }

    .route-notes { padding: 25px 0 8px; }

    .route-notes h3 {
      margin-bottom: 10px;
      color: var(--pine-light);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .13em;
      text-transform: uppercase;
    }

    .description { max-width: 720px; color: #344542; }
    .description p { margin-bottom: 12px; }
    .description p:last-child { margin-bottom: 0; }

    .route-link {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      margin-top: 26px;
      border-radius: 999px;
      padding: 11px 17px;
      background: var(--pine);
      color: #fffefa;
      font-size: 13px;
      font-weight: 650;
      text-decoration: none;
    }

    .route-link:hover { background: var(--pine-light); }
    .arrow { color: #f2c5a5; font-size: 17px; line-height: 1; }

    @media (max-width: 600px) {
      .guide { width: min(100% - 24px, 1080px); margin-top: 12px; }
      .cover { padding: 18px 20px; flex-direction: column; gap: 6px; }
      .contents { padding: 22px 20px; }
      .ride-card { margin-top: 16px; border-radius: 14px; }
      .ride-facts { grid-template-columns: 1fr 1fr; gap: 12px; }
    }

    @media print {
      @page { size: letter; margin: 0; }

      :root {
        --ink: #1b302e;
        --muted: #52635e;
        --pine: #173c38;
        --pine-light: #315a52;
        --sand: #fff;
        --paper: #fff;
        --line: #d3dad4;
      }

      body {
        background: #fff;
        font-size: 10.5pt;
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }

      .guide { width: 100%; margin: 0; padding: 0 .62in; }
      .cover { border-radius: 0; margin-top: .62in; }

      .contents {
        margin-top: 0;
        box-shadow: none;
        break-after: page;
        page-break-after: always;
      }

      .ride-card {
        margin: 0;
        padding: .25in 0;
        border: 0;
        border-radius: 0;
        box-shadow: none;
      }

      .ride-card + .ride-card { break-before: page; page-break-before: always; }
      .ride-card { padding: .62in 0 0; break-inside: avoid; }
      .ride-header { padding-bottom: 10px; }
      .ride-header h2 { font-size: 28pt; }
      .eyebrow { margin-bottom: 6px; }
      .ride-facts { padding: 12px 0; gap: 12px; }
      .fact-value { font-size: 18pt; }
      .fact-location { font-size: 14pt; }
      .route-map, .profile { padding-top: 12px; }
      .route-map h3, .profile h3 { margin-bottom: 6px; }
      .map { height: 3in; }
      .map-play, .map-controls { display: none; }
      .follow-map { display: none !important; }
      .route-line { stroke-dasharray: none !important; stroke-dashoffset: 0 !important; }
      .route-map.is-drawing .route-arrows { visibility: visible; }
      .route-map.is-drawing .route-position { visibility: hidden; }
      .profile-stats { margin-bottom: 2px; }
      .route-notes { padding: 12px 0 0; }
      .description { max-width: none; }
      .route-link { margin-top: 12px; padding: 8px 14px; }
      .ride-header, .ride-facts, .route-link, .route-map, .profile { break-inside: avoid; }
      .route-link { border: 1px solid var(--pine); background: transparent; color: var(--pine); }
      .route-link .arrow { color: var(--pine); }
      a { text-decoration: none; }
    }
  </style>
</head>
<body>
  <main class="guide">
    <section class="cover" aria-labelledby="guide-title">
      <h1 id="guide-title">Ride Guide</h1>
      <span class="cover-sub">Arizona Camp 2026</span>
    </section>

    <nav class="contents" aria-labelledby="contents-title">
      <h2 id="contents-title">This week's rides</h2>
      <p class="contents-note">${rideCount} ${rideLabel} in this guide</p>
      ${rides.map(renderIndex).join("")}
    </nav>

    ${rides.map(renderRide).join("")}


  </main>
  <script>
    const mapboxToken = document.querySelector('meta[name="mapbox-token"]')?.content;
    let mapboxLoading;
    function loadMapbox() {
      if (!mapboxLoading) {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = "https://api.mapbox.com/mapbox-gl-js/v3.15.0/mapbox-gl.css";
        const script = document.createElement("script");
        script.src = "https://api.mapbox.com/mapbox-gl-js/v3.15.0/mapbox-gl.js";
        const load = (element) => new Promise((resolve, reject) => {
          element.onload = resolve;
          element.onerror = () => reject(new Error("Could not load Mapbox GL JS."));
          document.head.appendChild(element);
        });
        mapboxLoading = Promise.all([load(css), load(script)]).catch((error) => {
          css.remove();
          script.remove();
          mapboxLoading = null;
          throw error;
        });
      }
      return mapboxLoading;
    }

    document.querySelectorAll(".route-map").forEach((map) => {
      const button = map.querySelector(".map-play");
      const controls = map.querySelector(".map-controls");
      const speed = controls.querySelector('input[type="range"]');
      const output = controls.querySelector("output");
      const lines = [...map.querySelectorAll(".route-line")];
      const position = map.querySelector(".route-position");
      const followControl = controls.querySelector(".follow-control");
      const followToggle = followControl.querySelector("input");
      const followStatus = controls.querySelector(".follow-status");
      const followContainer = map.querySelector(".follow-map");
      const svg = map.querySelector(".map");
      const length = lines[0].getTotalLength();
      if (!Number.isFinite(length) || length <= 0) return;

      let progress = 0;
      let frame = null;
      let lastTime = null;
      let started = false;
      let followMap = null;
      let followMarker = null;

      const routePoints = lines[0].getAttribute("d").slice(1).split("L").map((pair) => {
        const [x, y] = pair.split(" ").map(Number);
        return { x, y };
      });
      const distances = [0];
      for (let i = 1; i < routePoints.length; i++) {
        distances.push(distances[i - 1] + Math.hypot(routePoints[i].x - routePoints[i - 1].x, routePoints[i].y - routePoints[i - 1].y));
      }
      const coordinates = JSON.parse(svg.dataset.coordinates);
      const mercatorPoints = coordinates.map(([lon, lat]) => [
        lon * Math.PI / 180,
        Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)),
      ]);
      const mercatorDistances = [0];
      for (let i = 1; i < mercatorPoints.length; i++) {
        mercatorDistances.push(mercatorDistances[i - 1] + Math.hypot(
          mercatorPoints[i][0] - mercatorPoints[i - 1][0],
          mercatorPoints[i][1] - mercatorPoints[i - 1][1],
        ));
      }

      function updateFollow() {
        if (!followMap) return;
        const distance = length * progress;
        const ahead = lines[0].getPointAtLength(Math.min(length, distance + 10));
        const behind = lines[0].getPointAtLength(Math.max(0, distance - 10));
        const bearing = Math.atan2(ahead.x - behind.x, behind.y - ahead.y) * 180 / Math.PI;
        let low = 0, high = distances.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (distances[middle] <= distance) low = middle + 1;
          else high = middle;
        }
        const end = Math.min(low, coordinates.length - 1);
        const start = Math.max(0, end - 1);
        const span = distances[end] - distances[start];
        const fraction = progress >= 1 ? 1 : span > 0 ? Math.max(0, Math.min(1, (distance - distances[start]) / span)) : 0;
        const location = coordinates[start].map((value, i) => value + (coordinates[end][i] - value) * fraction);
        const total = mercatorDistances[mercatorDistances.length - 1];
        const drawn = !started || progress >= 1 ? 1 : (mercatorDistances[start] + (mercatorDistances[end] - mercatorDistances[start]) * fraction) / total;
        followMap.setPaintProperty("route-outline", "line-trim-offset", [drawn, 1]);
        followMap.setPaintProperty("route-line", "line-trim-offset", [drawn, 1]);
        followMarker.setLngLat(location);
        followMap.jumpTo({ center: location, bearing });
      }

      function stopFollow(message) {
        if (followMap) followMap.remove();
        followMap = null;
        followMarker = null;
        followContainer.hidden = true;
        followToggle.checked = false;
        followStatus.textContent = message;
      }

      async function startFollow() {
        followToggle.disabled = true;
        followStatus.textContent = "Loading perspective map...";
        let instance;
        try {
          await loadMapbox();
          followContainer.hidden = false;
          instance = new mapboxgl.Map({
            container: followContainer,
            accessToken: mapboxToken,
            style: "mapbox://styles/mapbox/outdoors-v12",
            center: coordinates[0],
            zoom: 14,
            pitch: 60,
            logoPosition: "top-left",
            interactive: false,
          });
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Mapbox map timed out.")), 20000);
            instance.once("load", () => { clearTimeout(timeout); resolve(); });
            instance.once("error", (event) => { clearTimeout(timeout); reject(event.error); });
          });
          instance.addSource("terrain", { type: "raster-dem", url: "mapbox://mapbox.mapbox-terrain-dem-v1", tileSize: 512, maxzoom: 14 });
          instance.setTerrain({ source: "terrain" });
          instance.addSource("route", { type: "geojson", lineMetrics: true, data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } } });
          instance.addLayer({ id: "route-outline", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#fffefa", "line-width": 7 } });
          instance.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#c4622d", "line-width": 4 } });
          const marker = document.createElement("div");
          marker.className = "follow-position";
          followMarker = new mapboxgl.Marker({ element: marker }).setLngLat(coordinates[0]).addTo(instance);
          followMap = instance;
          updateFollow();
          followStatus.textContent = "";
          instance.on("error", (event) => {
            console.error("Perspective map error:", event.error);
            stopFollow("Perspective map failed to load; showing the standard map.");
          });
        } catch (error) {
          console.error("Perspective map error:", error);
          if (instance) instance.remove();
          stopFollow("Perspective map failed to load; showing the standard map.");
        } finally {
          followToggle.disabled = false;
        }
      }

      function draw() {
        lines.forEach((line) => {
          line.style.strokeDasharray = length + " " + length;
          line.style.strokeDashoffset = length * (1 - progress);
        });
        const point = lines[0].getPointAtLength(length * progress);
        position.setAttribute("cx", point.x);
        position.setAttribute("cy", point.y);
        updateFollow();
      }

      function tick(time) {
        if (lastTime !== null) {
          const duration = followMap ? 60000 : 12000;
          progress = Math.min(1, progress + (time - lastTime) * Number(speed.value) / duration);
        }
        lastTime = time;
        draw();
        if (progress < 1) {
          frame = requestAnimationFrame(tick);
        } else {
          frame = null;
          map.classList.remove("is-drawing");
          button.textContent = "Replay route";
        }
      }

      button.addEventListener("click", () => {
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
          button.textContent = "Resume route";
          return;
        }
        if (!started || progress >= 1) progress = 0;
        started = true;
        lastTime = null;
        map.classList.add("is-drawing");
        draw();
        button.textContent = "Pause route";
        frame = requestAnimationFrame(tick);
      });

      speed.addEventListener("input", () => {
        output.textContent = speed.value + "×";
      });
      followToggle.addEventListener("change", () => {
        if (followToggle.checked) startFollow();
        else stopFollow("");
      });
      if (mapboxToken) followControl.hidden = false;
      button.hidden = false;
      controls.hidden = false;
    });
  </script>
</body>
</html>
`;

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = await buildHtml();
  await writeFile(outputPath, html, "utf8");
  await writeFile(indexPath, html, "utf8");
  console.log(`Generated ${outputPath}`);
  console.log(`Generated ${indexPath}`);
}
