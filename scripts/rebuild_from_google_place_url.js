#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_INPUT_PATH = '/Users/anthonylarosa/Desktop/super_goode_locations_after_DC9MNC6x_5x.csv';
const DEFAULT_OUTPUT_PATH =
  '/Users/anthonylarosa/Desktop/super_goode_locations_after_DC9MNC6x_5x_google_checked.csv';
const DEFAULT_UNRESOLVED_PATH =
  '/Users/anthonylarosa/Desktop/super_goode_locations_after_DC9MNC6x_5x_google_needs_help.csv';
const DEFAULT_SCORE_PATH = '/Users/anthonylarosa/Desktop/super_goode_missing_scores_after_DC9MNC6x_5x.csv';
const INPUT_PATH = process.argv[2] || DEFAULT_INPUT_PATH;
const OUTPUT_PATH = process.argv[3] || DEFAULT_OUTPUT_PATH;
const UNRESOLVED_PATH = process.argv[4] || DEFAULT_UNRESOLVED_PATH;
const SCORE_PATH = process.argv[5] || DEFAULT_SCORE_PATH;
const ONLY_NAMES = new Set(
  String(process.argv[6] || '')
    .split('|')
    .map((value) => normalizeName(value))
    .filter(Boolean),
);
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GOOGLE_MAPS_HOST_RE = /^https?:\/\/www\.google\.com\/maps\/search\//i;
const GOOGLE_RENDER_BUDGET_MS = 6000;
const CHROME_TIMEOUT_MS = 30000;
const GEOCODER_DELAY_MS = 250;

const geocodeCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSpace(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return normalizeSpace(
    String(value ?? '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))),
  );
}

function normalizeState(value) {
  const raw = normalizeSpace(value).toLowerCase();
  const map = {
    illinois: 'IL',
    il: 'IL',
    florida: 'FL',
    fl: 'FL',
  };
  return map[raw] || raw.toUpperCase();
}

function normalizeName(value) {
  return normalizeSpace(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleMatchesName(title, name) {
  const left = normalizeName(title);
  const right = normalizeName(name);
  if (!left || !right) return false;
  const compactLeft = left.replace(/\s+/g, '');
  const compactRight = right.replace(/\s+/g, '');
  if (compactLeft === compactRight || compactLeft.includes(compactRight) || compactRight.includes(compactLeft)) {
    return true;
  }

  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = right.split(' ').filter(Boolean);
  const shared = rightTokens.filter((token) =>
    [...leftTokens].some((leftToken) => leftToken === token || leftToken.startsWith(token) || token.startsWith(leftToken)),
  );
  return shared.length >= Math.max(2, Math.ceil(rightTokens.length * 0.6));
}

function splitCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quoted) {
      if (ch === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === ',') {
      out.push(current);
      current = '';
    } else if (ch === '"') {
      quoted = true;
    } else {
      current += ch;
    }
  }

  out.push(current);
  return out;
}

function parseCsv(text) {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line, index, items) => !(index === items.length - 1 && line === ''));
  const headers = splitCsvLine(lines[0] || '');
  const rows = lines.slice(1).map((line) => {
    const parts = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = parts[index] ?? '';
    });
    return row;
  });
  return { headers, rows };
}

function escapeCsv(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers, rows) {
  return [headers.join(',')]
    .concat(rows.map((row) => headers.map((header) => escapeCsv(row[header] ?? '')).join(',')))
    .join('\n');
}

function renderGoogleMaps(url) {
  const result = spawnSync(
    CHROME_PATH,
    [
      '--headless=new',
      '--disable-gpu',
      '--dump-dom',
      `--virtual-time-budget=${GOOGLE_RENDER_BUDGET_MS}`,
      url,
    ],
    {
      encoding: 'utf8',
      timeout: CHROME_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw result.error;
  }

  return result.stdout || '';
}

function extractGooglePlace(html) {
  const titleMatch = html.match(/<title>([^<]+?) - Google Maps<\/title>/i);
  const addressMatch = html.match(/aria-label="Address: ([^"]+)/i);

  const title = decodeHtmlEntities(titleMatch ? titleMatch[1] : '');
  let rawAddress = decodeHtmlEntities(addressMatch ? addressMatch[1] : '');

  if (!rawAddress && title.includes(',')) {
    const titleAddressMatch = title.match(/^.+?,\s+(.+?,\s*[^,]+,\s*(?:IL|FL|Illinois|Florida)(?:\s+\d{5}(?:-\d{4})?)?)$/i);
    if (titleAddressMatch) {
      rawAddress = decodeHtmlEntities(titleAddressMatch[1]);
    }
  }

  return {
    title,
    rawAddress,
  };
}

function parseGoogleAddress(rawAddress) {
  const cleaned = normalizeSpace(rawAddress).replace(/,?\s*USA$/i, '');
  let match = cleaned.match(/^(.*?),\s*([^,]+),\s*(IL|FL|Illinois|Florida)\s+(\d{5}(?:-\d{4})?)$/i);
  if (match) {
    return {
      address: normalizeSpace(match[1]),
      city: normalizeSpace(match[2]),
      state: normalizeState(match[3]),
      zip: normalizeSpace(match[4]),
    };
  }

  match = cleaned.match(/^(.*?),\s*([^,]+),\s*(IL|FL|Illinois|Florida)$/i);
  if (match) {
    return {
      address: normalizeSpace(match[1]),
      city: normalizeSpace(match[2]),
      state: normalizeState(match[3]),
      zip: '',
    };
  }

  return null;
}

function haversineKm(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some((value) => !Number.isFinite(value))) return null;
  const radius = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const left =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(left)));
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Codex location rebuild)',
      Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}`);
  }

  return response.json();
}

async function geocodeAddress(address, city, state, zip) {
  const full = [address, city, state, zip].filter(Boolean).join(', ');
  const key = full.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  let nominatim = null;
  let census = null;

  try {
    const nominatimUrl =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&countrycodes=us&q=' +
      encodeURIComponent(full);
    const rows = await fetchJson(nominatimUrl, 'nominatim');
    const first = Array.isArray(rows) ? rows[0] : null;
    if (first) {
      nominatim = {
        lat: Number(first.lat),
        lng: Number(first.lon),
      };
    }
  } catch {
    nominatim = null;
  }

  await sleep(GEOCODER_DELAY_MS);

  try {
    const censusUrl =
      'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=2020&format=json&address=' +
      encodeURIComponent(full);
    const data = await fetchJson(censusUrl, 'census');
    const first = data?.result?.addressMatches?.[0];
    if (first?.coordinates) {
      census = {
        lat: Number(first.coordinates.y),
        lng: Number(first.coordinates.x),
      };
    }
  } catch {
    census = null;
  }

  let chosen = null;
  let disagreementKm = null;
  if (nominatim && census) {
    disagreementKm = haversineKm(nominatim.lat, nominatim.lng, census.lat, census.lng);
    if (disagreementKm !== null && disagreementKm > 1.5) {
      geocodeCache.set(key, { ok: false, reason: 'geocoder-disagreement', disagreementKm });
      return geocodeCache.get(key);
    }
    chosen = nominatim;
  } else {
    chosen = nominatim || census;
  }

  if (!chosen) {
    geocodeCache.set(key, { ok: false, reason: 'geocode-failed' });
    return geocodeCache.get(key);
  }

  const out = {
    ok: true,
    lat: String(chosen.lat),
    lng: String(chosen.lng),
    disagreementKm,
  };
  geocodeCache.set(key, out);
  return out;
}

function needsLocation(row) {
  return !normalizeSpace(row.address) || !normalizeSpace(row.city) || !normalizeSpace(row.lat) || !normalizeSpace(row.lng);
}

async function main() {
  const { headers, rows } = parseCsv(fs.readFileSync(INPUT_PATH, 'utf8'));
  const filteredRows = ONLY_NAMES.size
    ? rows.filter((row) => ONLY_NAMES.has(normalizeName(row.name)))
    : rows;
  const outputRows = [];
  const unresolvedRows = [];

  console.log(`Loaded ${rows.length} rows from ${INPUT_PATH}`);
  console.log(`Processing ${filteredRows.length} rows`);

  for (let index = 0; index < filteredRows.length; index += 1) {
    const row = filteredRows[index];
    const next = { ...row };

    if (!needsLocation(row)) {
      outputRows.push(next);
      continue;
    }

      console.log(`[${index + 1}/${filteredRows.length}] checking ${row.name}`);

    if (normalizeName(row.name) === normalizeName('A Biker Dude')) {
      unresolvedRows.push({
        name: row.name,
        reviewUrl: row.reviewUrl,
        googlePlaceUrl: row.googlePlaceUrl,
        reason: 'moving-popup',
        googleTitle: '',
        googleAddress: '',
      });
      outputRows.push(next);
      continue;
    }

    if (!GOOGLE_MAPS_HOST_RE.test(row.googlePlaceUrl || '')) {
      unresolvedRows.push({
        name: row.name,
        reviewUrl: row.reviewUrl,
        googlePlaceUrl: row.googlePlaceUrl,
        reason: 'non-google-place-url',
        googleTitle: '',
        googleAddress: '',
      });
      outputRows.push(next);
      continue;
    }

    let html = '';
    try {
      html = renderGoogleMaps(row.googlePlaceUrl);
    } catch (error) {
      unresolvedRows.push({
        name: row.name,
        reviewUrl: row.reviewUrl,
        googlePlaceUrl: row.googlePlaceUrl,
        reason: `google-render-failed: ${error.message}`,
        googleTitle: '',
        googleAddress: '',
      });
      outputRows.push(next);
      continue;
    }

    const google = extractGooglePlace(html);
    if (!google.title) {
      unresolvedRows.push({
        name: row.name,
        reviewUrl: row.reviewUrl,
        googlePlaceUrl: row.googlePlaceUrl,
        reason: 'missing-google-title',
        googleTitle: '',
        googleAddress: google.rawAddress,
      });
      outputRows.push(next);
      continue;
    }

    if (!titleMatchesName(google.title, row.name)) {
      unresolvedRows.push({
        name: row.name,
        reviewUrl: row.reviewUrl,
        googlePlaceUrl: row.googlePlaceUrl,
        reason: 'google-title-mismatch',
        googleTitle: google.title,
        googleAddress: google.rawAddress,
      });
      outputRows.push(next);
      continue;
    }

    const parsedAddress = parseGoogleAddress(google.rawAddress);
    if (!parsedAddress) {
      unresolvedRows.push({
        name: row.name,
        reviewUrl: row.reviewUrl,
        googlePlaceUrl: row.googlePlaceUrl,
        reason: 'missing-or-unparseable-google-address',
        googleTitle: google.title,
        googleAddress: google.rawAddress,
      });
      outputRows.push(next);
      continue;
    }

    const geocoded = await geocodeAddress(
      parsedAddress.address,
      parsedAddress.city,
      parsedAddress.state,
      parsedAddress.zip,
    );
    if (!geocoded.ok) {
      unresolvedRows.push({
        name: row.name,
        reviewUrl: row.reviewUrl,
        googlePlaceUrl: row.googlePlaceUrl,
        reason: geocoded.reason,
        googleTitle: google.title,
        googleAddress: google.rawAddress,
      });
      outputRows.push(next);
      continue;
    }

    next.address = parsedAddress.address;
    next.city = parsedAddress.city;
    next.state = parsedAddress.state;
    next.lat = geocoded.lat;
    next.lng = geocoded.lng;
    outputRows.push(next);
  }

  fs.writeFileSync(OUTPUT_PATH, `${toCsv(headers, outputRows)}\n`, 'utf8');

  const scoreRows = outputRows
    .filter((row) => !normalizeSpace(row.score))
    .map((row) => ({
      name: row.name,
      score: row.score || '',
      reviewUrl: row.reviewUrl || '',
    }));
  fs.writeFileSync(SCORE_PATH, `${toCsv(['name', 'score', 'reviewUrl'], scoreRows)}\n`, 'utf8');

  fs.writeFileSync(
    UNRESOLVED_PATH,
    `${toCsv(['name', 'reviewUrl', 'googlePlaceUrl', 'reason', 'googleTitle', 'googleAddress'], unresolvedRows)}\n`,
    'utf8',
  );

  console.log(`Wrote corrected CSV: ${OUTPUT_PATH}`);
  console.log(`Wrote unresolved CSV: ${UNRESOLVED_PATH}`);
  console.log(`Wrote missing-score CSV: ${SCORE_PATH}`);
  console.log(`Resolved rows: ${outputRows.filter((row) => !needsLocation(row)).length}/${outputRows.length}`);
  console.log(`Needs help: ${unresolvedRows.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
