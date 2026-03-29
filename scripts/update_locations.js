#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const {
  buildFullAddress,
  enrichLocationEntry,
  hasUsableCoordinates,
  readGeocodeCache,
  shouldGenerateDirectionsUrl,
  writeGeocodeCache,
} = require('./location_enrichment');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LOCATIONS_PATH = path.join(DATA_DIR, 'locations.json');
const ROOT_LOCATIONS_PATH = path.join(ROOT, 'locations.json');
const NEW_REVIEWS_PATH = path.join(DATA_DIR, 'new-reviews.json');
const MANUAL_FIXES_PATH = path.join(DATA_DIR, 'manual-fixes.json');

const argv = process.argv.slice(2);
const args = new Set(argv.filter((arg) => arg.startsWith('--')).map((arg) => arg.split('=')[0]));
const keepNewReviews = args.has('--keep-new-reviews');
const inputArgIndex = argv.findIndex((arg) => arg === '--input' || arg.startsWith('--input='));
const inputOverride = inputArgIndex >= 0
  ? (argv[inputArgIndex].includes('=') ? argv[inputArgIndex].split('=').slice(1).join('=') : argv[inputArgIndex + 1])
  : null;
const intakePath = inputOverride ? path.resolve(ROOT, inputOverride) : NEW_REVIEWS_PATH;
const intakeLabel = path.basename(intakePath);

const confidenceRank = {
  low: 0,
  medium: 1,
  high: 2,
};

const blockedTemporaryNames = new Set([
  'test burger',
  'test pizza place',
]);

function decodeHtmlEntities(input) {
  const str = String(input ?? '');
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function normalizeText(value) {
  return decodeHtmlEntities(value)
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return normalizeText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function temporaryNameKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isBlockedTemporaryEntry(value) {
  const key = temporaryNameKey(value);
  return blockedTemporaryNames.has(key) || /^test\b/.test(key) || /^demo\b/.test(key) || /^sample\b/.test(key) || /^placeholder\b/.test(key) || /^temp(?:orary)?\b/.test(key);
}

function cleanString(value) {
  const text = normalizeText(value);
  return text;
}

function cleanOptionalString(value) {
  const text = cleanString(value);
  return text || '';
}

function cleanState(value) {
  return cleanOptionalString(value).toUpperCase() || 'IL';
}

function coerceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sanitizeEntry(raw) {
  const entry = {
    name: cleanString(raw.name),
    score: coerceNumber(raw.score),
    subtitle: cleanOptionalString(raw.subtitle),
    address: cleanOptionalString(raw.address),
    city: cleanOptionalString(raw.city) || 'Chicago',
    state: cleanState(raw.state),
    lat: coerceNumber(raw.lat),
    lng: coerceNumber(raw.lng),
    googlePlaceUrl: cleanOptionalString(raw.googlePlaceUrl),
    directionsUrl: cleanOptionalString(raw.directionsUrl),
    reviewUrl: cleanOptionalString(raw.reviewUrl),
    sourceType: cleanOptionalString(raw.sourceType) || 'manual',
    confidence: cleanOptionalString(raw.confidence) || 'medium',
    notes: cleanOptionalString(raw.notes),
  };

  return entry;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJsonText(text, fallback) {
  if (!text.trim()) return fallback;
  return JSON.parse(text);
}

async function readJsonFile(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return readJsonText(text, fallback);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function writeJsonFile(filePath, value) {
  return fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function confidenceValue(value) {
  return confidenceRank[String(value || '').toLowerCase()] ?? 0;
}

function upgradeConfidence(existing, incoming) {
  return confidenceValue(incoming) > confidenceValue(existing) ? incoming : existing;
}

function mergeEntry(existing, incoming) {
  const before = clone(existing);
  const next = { ...existing };

  const copyIfMissing = (key) => {
    const current = next[key];
    const source = incoming[key];
    if (current === null || current === undefined || current === '' || current === 'null') {
      if (source !== null && source !== undefined && source !== '') next[key] = source;
    }
  };

  copyIfMissing('subtitle');
  copyIfMissing('address');
  copyIfMissing('city');
  copyIfMissing('state');
  copyIfMissing('lat');
  copyIfMissing('lng');
  copyIfMissing('googlePlaceUrl');
  copyIfMissing('directionsUrl');
  copyIfMissing('reviewUrl');
  copyIfMissing('sourceType');
  copyIfMissing('notes');

  if (next.score === null || next.score === undefined || Number.isNaN(next.score)) {
    next.score = incoming.score;
  }

  next.confidence = upgradeConfidence(next.confidence, incoming.confidence);

  return {
    entry: next,
    changed: JSON.stringify(before) !== JSON.stringify(next),
  };
}

function applyManualFixes(entries, manualFixes) {
  const fixes = new Map();
  for (const [name, fix] of Object.entries(manualFixes || {})) {
    fixes.set(normalizeName(name), fix);
  }

  const touched = [];
  for (const entry of entries) {
    const fix = fixes.get(normalizeName(entry.name));
    if (!fix || typeof fix !== 'object' || Array.isArray(fix)) continue;
    const before = clone(entry);
    for (const [key, value] of Object.entries(fix)) {
      entry[key] = value;
    }
    if (JSON.stringify(before) !== JSON.stringify(entry)) {
      touched.push(entry.name);
    }
  }

  const unresolved = Object.keys(manualFixes || {}).filter((name) => {
    return !entries.some((entry) => normalizeName(entry.name) === normalizeName(name));
  });

  return { touched, unresolved };
}

function formatList(items) {
  if (!items.length) return ['- none'];
  return items.map((item) => `- ${item}`);
}

async function main() {
  const summary = {
    added: [],
    updated: [],
    skipped: [],
    ambiguous: [],
    autoGeocoded: [],
    autoDirections: [],
    geocodeFailed: [],
    errors: [],
  };

  try {
    const [locationsRaw, newReviewsRaw, manualFixesRaw] = await Promise.all([
      readJsonFile(LOCATIONS_PATH, []),
      readJsonFile(intakePath, []),
      readJsonFile(MANUAL_FIXES_PATH, {}),
    ]);
    const geocodeCache = await readGeocodeCache();

    const locations = Array.isArray(locationsRaw) ? locationsRaw.map((item) => sanitizeEntry(item)) : [];
    const incoming = Array.isArray(newReviewsRaw) ? newReviewsRaw : [];
    const manualFixes = manualFixesRaw && typeof manualFixesRaw === 'object' ? manualFixesRaw : {};
    const resolvedRows = new Set();
    const enrichmentTargets = new Set();

    const index = new Map();
    for (let i = 0; i < locations.length; i += 1) {
      const key = normalizeName(locations[i].name);
      if (!key) continue;
      const bucket = index.get(key) || [];
      bucket.push(i);
      index.set(key, bucket);
    }

    const seenIncoming = new Set();
    for (const [rowIndex, raw] of incoming.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        summary.errors.push(`Invalid review row: ${JSON.stringify(raw)}`);
        continue;
      }

      const entry = sanitizeEntry(raw);
      if (!entry.name) {
        summary.errors.push('Skipped an entry with a missing restaurant name.');
        continue;
      }
      if (isBlockedTemporaryEntry(entry.name)) {
        summary.skipped.push(`${entry.name} (temporary/test entry)`);
        resolvedRows.add(rowIndex);
        continue;
      }
      if (!Number.isFinite(entry.score)) {
        summary.errors.push(`${entry.name}: score is required and must be a number.`);
        continue;
      }

      const key = normalizeName(entry.name);
      if (!key) {
        summary.errors.push(`${entry.name}: could not normalize restaurant name.`);
        continue;
      }

      if (seenIncoming.has(key)) {
        summary.skipped.push(`${entry.name} (duplicate in ${intakeLabel})`);
        resolvedRows.add(rowIndex);
        continue;
      }
      seenIncoming.add(key);

      const matches = index.get(key) || [];
      if (matches.length > 1) {
        summary.ambiguous.push(`${entry.name} (${matches.length} matches in locations.json)`);
        continue;
      }

      if (matches.length === 1) {
        const matchIndex = matches[0];
        const merged = mergeEntry(locations[matchIndex], entry);
        locations[matchIndex] = merged.entry;
        enrichmentTargets.add(matchIndex);
        if (merged.changed) {
          summary.updated.push(entry.name);
        } else {
          summary.skipped.push(`${entry.name} (unchanged)`);
        }
        resolvedRows.add(rowIndex);
        continue;
      }

      const next = {
        name: entry.name,
        score: entry.score,
        subtitle: entry.subtitle || '',
        address: entry.address || '',
        city: entry.city || 'Chicago',
        state: entry.state || 'IL',
        lat: entry.lat ?? null,
        lng: entry.lng ?? null,
        googlePlaceUrl: entry.googlePlaceUrl || '',
        directionsUrl: entry.directionsUrl || '',
        reviewUrl: entry.reviewUrl || '',
        sourceType: entry.sourceType || 'manual',
        confidence: entry.confidence || 'medium',
        notes: entry.notes || '',
      };

      locations.push(next);
      const newIndex = locations.length - 1;
      index.set(key, [newIndex]);
      enrichmentTargets.add(newIndex);
      summary.added.push(entry.name);
      resolvedRows.add(rowIndex);
    }

    const manualResult = applyManualFixes(locations, manualFixes);
    summary.updated.push(...manualResult.touched.filter((name) => !summary.updated.includes(name)));
    for (const name of manualResult.touched) {
      const matches = index.get(normalizeName(name)) || [];
      for (const matchIndex of matches) {
        enrichmentTargets.add(matchIndex);
      }
    }
    for (const missing of manualResult.unresolved) {
      summary.errors.push(`Manual fix target not found: ${missing}`);
    }

    for (let i = 0; i < locations.length; i += 1) {
      const entry = locations[i];
      const fullAddress = buildFullAddress(entry);
      if (!fullAddress) continue;
      if (!hasUsableCoordinates(entry) || shouldGenerateDirectionsUrl(entry)) {
        enrichmentTargets.add(i);
      }
    }

    for (const targetIndex of enrichmentTargets) {
      const entry = locations[targetIndex];
      if (!entry) continue;
      const before = clone(entry);
      const changed = await enrichLocationEntry(entry, geocodeCache, summary);
      if (changed && !summary.added.includes(entry.name) && !summary.updated.includes(entry.name)) {
        summary.updated.push(entry.name);
      } else if (!changed && JSON.stringify(before) !== JSON.stringify(entry) && !summary.updated.includes(entry.name)) {
        summary.updated.push(entry.name);
      }
    }

    if (!summary.errors.length) {
      // no-op
    }

    if (!process.argv.includes('--dry-run')) {
      await writeJsonFile(LOCATIONS_PATH, locations);
      await writeJsonFile(ROOT_LOCATIONS_PATH, locations);
      await writeGeocodeCache(geocodeCache);
      if (keepNewReviews) {
        await writeJsonFile(intakePath, incoming);
      } else {
        await writeJsonFile(
          intakePath,
          incoming.filter((_, idx) => !resolvedRows.has(idx)),
        );
      }
    }

    console.log('Added:');
    formatList(summary.added).forEach((line) => console.log(line));
    console.log('');
    console.log('Updated:');
    formatList(summary.updated).forEach((line) => console.log(line));
    console.log('');
    console.log('Skipped:');
    formatList(summary.skipped).forEach((line) => console.log(line));
    console.log('');
    console.log('Ambiguous:');
    formatList(summary.ambiguous).forEach((line) => console.log(line));
    console.log('');
    console.log('Auto-generated directions URLs:');
    formatList(summary.autoDirections).forEach((line) => console.log(line));
    console.log('');
    console.log('Auto-geocoded:');
    formatList(summary.autoGeocoded).forEach((line) => console.log(line));
    console.log('');
    console.log('Geocode failures:');
    formatList(summary.geocodeFailed).forEach((line) => console.log(line));
    console.log('');
    console.log('Errors:');
    formatList(summary.errors).forEach((line) => console.log(line));
  } catch (err) {
    console.error('Errors:');
    console.error(`- ${err.message}`);
    process.exitCode = 1;
  }
}

main();
