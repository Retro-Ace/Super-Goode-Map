#!/usr/bin/env node

const fs = require('fs');
const { spawnSync } = require('child_process');

const NEEDS_HELP_PATH =
  '/Users/anthonylarosa/Desktop/super_goode_locations_after_DC9MNC6x_5x_google_needs_help.csv';
const CHECKED_PATH =
  '/Users/anthonylarosa/Desktop/super_goode_locations_after_DC9MNC6x_5x_google_checked.csv';
const SCORE_PATH = '/Users/anthonylarosa/Desktop/super_goode_missing_scores_after_DC9MNC6x_5x.csv';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GOOGLE_HOST_RE = /^https?:\/\/(?:www\.google\.com\/maps\/|maps\.app\.goo\.gl\/)/i;

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

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

function renderGoogle(url) {
  const result = spawnSync(
    CHROME_PATH,
    ['--headless=new', '--disable-gpu', '--dump-dom', '--virtual-time-budget=6000', url],
    {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  return result.stdout || '';
}

function extractGooglePlace(html) {
  const titleMatch = html.match(/<title>([^<]+?) - Google Maps<\/title>/i);
  const addressMatch = html.match(/aria-label="Address: ([^"]+)/i);
  const coordMatch = [...html.matchAll(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/g)].pop()
    || [...html.matchAll(/@(-?\d+\.\d+),(-?\d+\.\d+)/g)].pop();

  const title = decodeHtmlEntities(titleMatch ? titleMatch[1] : '');
  let rawAddress = decodeHtmlEntities(addressMatch ? addressMatch[1] : '');
  if (!rawAddress && title.includes(',')) {
    const titleAddressMatch = title.match(/^.+?,\s+(.+?,\s*[^,]+,\s*(?:IL|FL|Illinois|Florida)(?:\s+\d{5}(?:-\d{4})?)?)$/i);
    if (titleAddressMatch) rawAddress = decodeHtmlEntities(titleAddressMatch[1]);
  }

  return {
    title,
    rawAddress,
    lat: coordMatch ? String(coordMatch[1]) : '',
    lng: coordMatch ? String(coordMatch[2]) : '',
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Codex manual merge)',
      Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function geocodeCity(city, state) {
  const query = [city, state].filter(Boolean).join(', ');
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=' +
    encodeURIComponent(query);
  const rows = await fetchJson(url);
  const first = Array.isArray(rows) ? rows[0] : null;
  if (!first) return null;
  return { lat: String(first.lat), lng: String(first.lon) };
}

async function geocodeAddress(address, city, state, zip = '') {
  const query = [address, city, state, zip].filter(Boolean).join(', ');
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=' +
    encodeURIComponent(query);
  const rows = await fetchJson(url);
  const first = Array.isArray(rows) ? rows[0] : null;
  if (!first) return null;
  return { lat: String(first.lat), lng: String(first.lon) };
}

function extractPinnedCity(note) {
  const match = normalizeSpace(note).match(/pin in ([A-Za-z .'-]+),?\s*(IL|FL)/i)
    || normalizeSpace(note).match(/drop the pin in ([A-Za-z .'-]+),?\s*(IL|FL)/i);
  if (!match) return null;
  return {
    city: normalizeSpace(match[1].replace(/\s+area$/i, '')),
    state: normalizeState(match[2]),
  };
}

function extractNameOverride(note) {
  const text = normalizeSpace(note);
  if (!text) return '';

  let match = text.match(/change name to\s+(.+)$/i)
    || text.match(/update name to\s+(.+)$/i)
    || text.match(/make name\s+(.+)$/i)
    || text.match(/name is\s*[:-]?\s*(.+?)(?:\s*-\s*updated link)?$/i);
  if (match) return normalizeSpace(match[1]);

  if (
    /food truck|pin in|drop the pin|wrong link|actual address|google doesn.?t have|use this|popup|pop up|mobile place|physical address/i.test(
      text,
    )
    || /https?:\/\//i.test(text)
    || text.length > 80
  ) {
    return '';
  }

  if (!/[.!?]/.test(text)) return text;

  return '';
}

function extractAddressOverride(note) {
  const text = normalizeSpace(note).replace(/,\s*$/, '');
  if (!text) return null;

  const match =
    text.match(/(\d+[A-Za-z0-9-]*\s+[^,]+,\s*[^,]+,\s*(?:IL|FL|Illinois|Florida)\s+\d{5}(?:-\d{4})?)/i)
    || text.match(/(\d+[A-Za-z0-9-]*\s+[^,]+,\s*[^,]+,\s*(?:IL|FL|Illinois|Florida))/i);
  if (!match) return null;
  return parseGoogleAddress(match[1]);
}

function buildDirectionsUrl(address, city, state) {
  const destination = [address, city, state].filter(Boolean).join(', ');
  if (!destination) return '';
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

async function main() {
  const needsHelp = parseCsv(fs.readFileSync(NEEDS_HELP_PATH, 'utf8')).rows;
  const checkedFile = parseCsv(fs.readFileSync(CHECKED_PATH, 'utf8'));
  const checkedRows = checkedFile.rows;
  const checkedByReviewUrl = new Map(checkedRows.map((row) => [row.reviewUrl, row]));
  const remaining = [];
  let updated = 0;

  for (const fix of needsHelp) {
    const target = checkedByReviewUrl.get(fix.reviewUrl);
    if (!target) {
      remaining.push({ ...fix, reason: 'missing-in-checked' });
      continue;
    }

    target.googlePlaceUrl = fix.googlePlaceUrl || target.googlePlaceUrl;
    const note = fix['Reason and what to do '] || '';
    const explicitName = extractNameOverride(note);
    const explicitAddress = extractAddressOverride(note);
    const pinnedCity = extractPinnedCity(note);

    if (pinnedCity && !explicitAddress) {
      const coords = await geocodeCity(pinnedCity.city, pinnedCity.state);
      target.city = pinnedCity.city;
      target.state = pinnedCity.state;
      target.address = '';
      if (coords) {
        target.lat = coords.lat;
        target.lng = coords.lng;
      }
      if (explicitName) target.name = explicitName;
      target.slug = slugify(target.name);
      updated += 1;
      continue;
    }

    if (!GOOGLE_HOST_RE.test(target.googlePlaceUrl)) {
      if (explicitAddress) {
        target.name = explicitName || target.name;
        target.slug = slugify(target.name);
        target.address = explicitAddress.address;
        target.city = explicitAddress.city;
        target.state = explicitAddress.state;
        target.directionsUrl = buildDirectionsUrl(target.address, target.city, target.state);
        const coords = await geocodeAddress(
          explicitAddress.address,
          explicitAddress.city,
          explicitAddress.state,
          explicitAddress.zip,
        );
        if (coords) {
          target.lat = coords.lat;
          target.lng = coords.lng;
        }
        updated += 1;
        continue;
      }
      remaining.push({ ...fix, reason: 'non-google-link-after-update' });
      continue;
    }

    let html = '';
    try {
      html = renderGoogle(target.googlePlaceUrl);
    } catch (error) {
      remaining.push({ ...fix, reason: `google-render-failed: ${error.message}` });
      continue;
    }

    const google = extractGooglePlace(html);
    if (!google.title) {
      remaining.push({ ...fix, reason: 'missing-google-title' });
      continue;
    }

    const parsedAddress = parseGoogleAddress(google.rawAddress) || explicitAddress;
    if (!parsedAddress) {
      remaining.push({ ...fix, reason: 'missing-or-unparseable-google-address', googleTitle: google.title, googleAddress: google.rawAddress });
      continue;
    }

    target.name = explicitName || google.title || target.name;
    target.slug = slugify(target.name);
    target.address = parsedAddress.address;
    target.city = parsedAddress.city;
    target.state = parsedAddress.state;
    target.directionsUrl = buildDirectionsUrl(target.address, target.city, target.state);
    if (google.lat && google.lng) {
      target.lat = google.lat;
      target.lng = google.lng;
    } else if (explicitAddress) {
      const coords = await geocodeAddress(
        parsedAddress.address,
        parsedAddress.city,
        parsedAddress.state,
        parsedAddress.zip,
      );
      if (coords) {
        target.lat = coords.lat;
        target.lng = coords.lng;
      }
    }
    updated += 1;
  }

  const mrDs = checkedByReviewUrl.get('https://www.instagram.com/reel/DLHzULbuVBC/');
  if (mrDs) {
    mrDs.name = "Mr D's Shish-Kabobs";
    mrDs.slug = slugify(mrDs.name);
    mrDs.googlePlaceUrl = 'https://maps.app.goo.gl/xcguP5YUntHMpKnw9';
    mrDs.address = '6656 W Diversey Ave';
    mrDs.city = 'Chicago';
    mrDs.state = 'IL';
    mrDs.lat = '41.9310537';
    mrDs.lng = '-87.7928576';
    mrDs.directionsUrl = buildDirectionsUrl(mrDs.address, mrDs.city, mrDs.state);
  }

  const curiousCrow = checkedByReviewUrl.get('https://www.instagram.com/reel/DJ_uGkzN9Im/');
  if (curiousCrow) {
    curiousCrow.name = 'The Curious Crow food truck';
    curiousCrow.slug = slugify(curiousCrow.name);
    curiousCrow.googlePlaceUrl =
      'https://www.google.com/maps/search/?api=1&query=The%20Curious%20Crow%20food%20truck%2C%20East%20Monroe%20Drive%2C%20Chicago%2C%20IL';
  }

  fs.writeFileSync(CHECKED_PATH, `${toCsv(checkedFile.headers, checkedRows)}\n`, 'utf8');

  const scoreRows = checkedRows
    .filter((row) => !normalizeSpace(row.score))
    .map((row) => ({ name: row.name, score: row.score || '', reviewUrl: row.reviewUrl || '' }));
  fs.writeFileSync(SCORE_PATH, `${toCsv(['name', 'score', 'reviewUrl'], scoreRows)}\n`, 'utf8');

  const unresolvedHeaders = ['name', 'reviewUrl', 'googlePlaceUrl', 'reason', 'googleTitle', 'googleAddress', 'Reason and what to do '];
  fs.writeFileSync(NEEDS_HELP_PATH, `${toCsv(unresolvedHeaders, remaining)}\n`, 'utf8');

  console.log(`Updated rows: ${updated}`);
  console.log(`Still need help: ${remaining.length}`);
  if (remaining.length) {
    remaining.forEach((row) => {
      console.log(`NEEDS_HELP\t${row.name}\t${row.reason}\t${row.googlePlaceUrl}`);
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
