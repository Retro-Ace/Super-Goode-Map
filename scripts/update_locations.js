#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const {
  buildFullAddress,
  enrichLocationEntry,
  hasUsableGooglePlaceUrl,
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

function normalizeRequestType(value) {
  const key = normalizeText(value).toLowerCase();
  if (['remove location', 'remove', 'delete location', 'delete'].includes(key)) return 'remove';
  return 'add';
}

function normalizeComparableText(value) {
  return normalizeText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const addressTokenMap = new Map([
  ['n', 'north'],
  ['s', 'south'],
  ['e', 'east'],
  ['w', 'west'],
  ['ne', 'northeast'],
  ['nw', 'northwest'],
  ['se', 'southeast'],
  ['sw', 'southwest'],
  ['st', 'street'],
  ['street', 'street'],
  ['rd', 'road'],
  ['road', 'road'],
  ['ave', 'avenue'],
  ['avenue', 'avenue'],
  ['blvd', 'boulevard'],
  ['boulevard', 'boulevard'],
  ['dr', 'drive'],
  ['drive', 'drive'],
  ['ln', 'lane'],
  ['lane', 'lane'],
  ['ct', 'court'],
  ['court', 'court'],
  ['cir', 'circle'],
  ['circle', 'circle'],
  ['pl', 'place'],
  ['place', 'place'],
  ['pkwy', 'parkway'],
  ['parkway', 'parkway'],
  ['ter', 'terrace'],
  ['terrace', 'terrace'],
  ['trl', 'trail'],
  ['trail', 'trail'],
  ['hwy', 'highway'],
  ['highway', 'highway'],
  ['ste', 'suite'],
  ['suite', 'suite'],
  ['apt', 'apartment'],
  ['apartment', 'apartment'],
  ['fl', 'floor'],
  ['floor', 'floor'],
]);

function normalizeAddress(value) {
  const text = normalizeComparableText(value);
  if (!text) return '';
  return text
    .split(' ')
    .filter(Boolean)
    .map((token) => addressTokenMap.get(token) || token)
    .join(' ');
}

function normalizeUrlIdentity(value) {
  const text = cleanOptionalString(value);
  if (!text) return '';
  try {
    const url = new URL(text);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin.toLowerCase()}${path}`;
  } catch (err) {
    return normalizeComparableText(text);
  }
}

function hasFiniteCoordinates(entry) {
  return Number.isFinite(entry?.lat) && Number.isFinite(entry?.lng);
}

function distanceMeters(a, b) {
  const lat1 = Number(a.lat);
  const lng1 = Number(a.lng);
  const lat2 = Number(b.lat);
  const lng2 = Number(b.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const lat1Rad = toRad(lat1);
  const lat2Rad = toRad(lat2);
  const aValue = (Math.sin(dLat / 2) ** 2)
    + Math.cos(lat1Rad) * Math.cos(lat2Rad) * (Math.sin(dLng / 2) ** 2);
  const c = 2 * Math.atan2(Math.sqrt(aValue), Math.sqrt(1 - aValue));
  return earthRadiusMeters * c;
}

function samePlaceByReviewUrl(existing, incoming) {
  const existingKey = normalizeUrlIdentity(existing.reviewUrl);
  const incomingKey = normalizeUrlIdentity(incoming.reviewUrl);
  return !!existingKey && existingKey === incomingKey;
}

function samePlaceByAddress(existing, incoming) {
  if (normalizeName(existing.name) !== normalizeName(incoming.name)) return false;
  const existingAddress = normalizeAddress(existing.address);
  const incomingAddress = normalizeAddress(incoming.address);
  if (!existingAddress || !incomingAddress || existingAddress !== incomingAddress) return false;
  const existingState = normalizeComparableText(existing.state);
  const incomingState = normalizeComparableText(incoming.state);
  return !existingState || !incomingState || existingState === incomingState;
}

function samePlaceByExactLocation(existing, incoming) {
  if (normalizeName(existing.name) !== normalizeName(incoming.name)) return false;
  const existingAddress = normalizeAddress(existing.address);
  const incomingAddress = normalizeAddress(incoming.address);
  const existingCity = normalizeComparableText(existing.city);
  const incomingCity = normalizeComparableText(incoming.city);
  const existingState = normalizeComparableText(existing.state);
  const incomingState = normalizeComparableText(incoming.state);

  return !!existingAddress
    && !!incomingAddress
    && !!existingCity
    && !!incomingCity
    && !!existingState
    && !!incomingState
    && existingAddress === incomingAddress
    && existingCity === incomingCity
    && existingState === incomingState;
}

function hasExactLocationFields(entry) {
  return !!(
    normalizeAddress(entry.address)
    && normalizeComparableText(entry.city)
    && normalizeComparableText(entry.state)
  );
}

function samePlaceByCoordinates(existing, incoming) {
  if (normalizeName(existing.name) !== normalizeName(incoming.name)) return false;
  if (!hasFiniteCoordinates(existing) || !hasFiniteCoordinates(incoming)) return false;
  return distanceMeters(existing, incoming) <= 50;
}

function hasMaterialLocationConflict(existing, incoming) {
  if (normalizeName(existing.name) !== normalizeName(incoming.name)) return false;
  if (samePlaceByReviewUrl(existing, incoming) || samePlaceByAddress(existing, incoming) || samePlaceByCoordinates(existing, incoming)) {
    return false;
  }

  const existingAddress = normalizeAddress(existing.address);
  const incomingAddress = normalizeAddress(incoming.address);
  if (existingAddress && incomingAddress && existingAddress !== incomingAddress) {
    return true;
  }

  const existingState = normalizeComparableText(existing.state);
  const incomingState = normalizeComparableText(incoming.state);
  if (existingState && incomingState && existingState !== incomingState) {
    return true;
  }

  const existingCity = normalizeComparableText(existing.city);
  const incomingCity = normalizeComparableText(incoming.city);
  if (existingCity && incomingCity && existingCity !== incomingCity && (existingAddress || incomingAddress)) {
    return true;
  }

  if (hasFiniteCoordinates(existing) && hasFiniteCoordinates(incoming) && !samePlaceByCoordinates(existing, incoming)) {
    return true;
  }

  return false;
}

function createIndexes(locations) {
  const byName = new Map();
  const byReviewUrl = new Map();

  for (let i = 0; i < locations.length; i += 1) {
    const nameKey = normalizeName(locations[i].name);
    if (nameKey) {
      const bucket = byName.get(nameKey) || [];
      bucket.push(i);
      byName.set(nameKey, bucket);
    }

    const reviewKey = normalizeUrlIdentity(locations[i].reviewUrl);
    if (reviewKey) {
      const bucket = byReviewUrl.get(reviewKey) || [];
      bucket.push(i);
      byReviewUrl.set(reviewKey, bucket);
    }
  }

  return { byName, byReviewUrl };
}

function addIndexEntry(indexes, entry, rowIndex) {
  const nameKey = normalizeName(entry.name);
  if (nameKey) {
    const bucket = indexes.byName.get(nameKey) || [];
    bucket.push(rowIndex);
    indexes.byName.set(nameKey, bucket);
  }

  const reviewKey = normalizeUrlIdentity(entry.reviewUrl);
  if (reviewKey) {
    const bucket = indexes.byReviewUrl.get(reviewKey) || [];
    if (!bucket.includes(rowIndex)) {
      bucket.push(rowIndex);
      indexes.byReviewUrl.set(reviewKey, bucket);
    }
  }
}

function updateIndexEntry(indexes, beforeEntry, afterEntry, rowIndex) {
  const beforeReviewKey = normalizeUrlIdentity(beforeEntry.reviewUrl);
  if (beforeReviewKey) {
    const bucket = (indexes.byReviewUrl.get(beforeReviewKey) || []).filter((idx) => idx !== rowIndex);
    if (bucket.length) indexes.byReviewUrl.set(beforeReviewKey, bucket);
    else indexes.byReviewUrl.delete(beforeReviewKey);
  }

  const afterReviewKey = normalizeUrlIdentity(afterEntry.reviewUrl);
  if (afterReviewKey) {
    const bucket = indexes.byReviewUrl.get(afterReviewKey) || [];
    if (!bucket.includes(rowIndex)) {
      bucket.push(rowIndex);
      indexes.byReviewUrl.set(afterReviewKey, bucket);
    }
  }
}

function findExistingMatch(entry, locations, indexes) {
  const reviewKey = normalizeUrlIdentity(entry.reviewUrl);
  if (reviewKey) {
    const reviewMatches = indexes.byReviewUrl.get(reviewKey) || [];
    if (reviewMatches.length === 1) {
      return { type: 'match', matchIndex: reviewMatches[0], reason: 'reviewUrl' };
    }
    if (reviewMatches.length > 1) {
      return { type: 'ambiguous', reason: 'reviewUrl', candidates: reviewMatches };
    }
  }

  const nameKey = normalizeName(entry.name);
  const candidates = indexes.byName.get(nameKey) || [];
  if (!candidates.length) {
    return { type: 'new', reason: 'no-name-match' };
  }

  const addressMatches = candidates.filter((idx) => samePlaceByAddress(locations[idx], entry));
  if (addressMatches.length === 1) {
    return { type: 'match', matchIndex: addressMatches[0], reason: 'address' };
  }
  if (addressMatches.length > 1) {
    return { type: 'ambiguous', reason: 'address', candidates: addressMatches };
  }

  const coordinateMatches = candidates.filter((idx) => samePlaceByCoordinates(locations[idx], entry));
  if (coordinateMatches.length === 1) {
    return { type: 'match', matchIndex: coordinateMatches[0], reason: 'coordinates' };
  }
  if (coordinateMatches.length > 1) {
    return { type: 'ambiguous', reason: 'coordinates', candidates: coordinateMatches };
  }

  if (candidates.length === 1) {
    const existing = locations[candidates[0]];
    if (hasMaterialLocationConflict(existing, entry)) {
      return { type: 'new', reason: 'different-location' };
    }
    return { type: 'match', matchIndex: candidates[0], reason: 'legacy-name-fallback' };
  }

  const conflictingCandidates = candidates.filter((idx) => hasMaterialLocationConflict(locations[idx], entry));
  if (conflictingCandidates.length === candidates.length) {
    return { type: 'new', reason: 'different-location' };
  }

  return { type: 'ambiguous', reason: 'same-name-multiple-locations', candidates };
}

function hasRemovalIdentity(entry) {
  return !!(
    normalizeUrlIdentity(entry.reviewUrl)
    || hasExactLocationFields(entry)
    || hasFiniteCoordinates(entry)
  );
}

function findRemovalMatch(entry, locations, indexes) {
  const nameKey = normalizeName(entry.name);
  const candidates = indexes.byName.get(nameKey) || [];
  if (!candidates.length) {
    return { type: 'not-found', reason: 'no-name-match' };
  }

  const reviewKey = normalizeUrlIdentity(entry.reviewUrl);
  if (reviewKey) {
    const reviewMatches = (indexes.byReviewUrl.get(reviewKey) || [])
      .filter((idx) => normalizeName(locations[idx].name) === nameKey);
    if (reviewMatches.length === 1) {
      return { type: 'match', matchIndex: reviewMatches[0], reason: 'reviewUrl' };
    }
    if (reviewMatches.length > 1) {
      return { type: 'ambiguous', reason: 'reviewUrl', candidates: reviewMatches };
    }
  }

  const exactLocationMatches = candidates.filter((idx) => samePlaceByExactLocation(locations[idx], entry));
  if (exactLocationMatches.length === 1) {
    return { type: 'match', matchIndex: exactLocationMatches[0], reason: 'exact-location' };
  }
  if (exactLocationMatches.length > 1) {
    return { type: 'ambiguous', reason: 'exact-location', candidates: exactLocationMatches };
  }

  const coordinateMatches = candidates.filter((idx) => samePlaceByCoordinates(locations[idx], entry));
  if (coordinateMatches.length === 1) {
    return { type: 'match', matchIndex: coordinateMatches[0], reason: 'coordinates' };
  }
  if (coordinateMatches.length > 1) {
    return { type: 'ambiguous', reason: 'coordinates', candidates: coordinateMatches };
  }

  return { type: 'not-found', reason: 'no-exact-location-match', candidates };
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
  const requestType = normalizeRequestType(raw.requestType);
  const entry = {
    requestType,
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
  const controlsByName = new Map();
  for (const entry of entries) {
    const fix = fixes.get(normalizeName(entry.name));
    if (!fix || typeof fix !== 'object' || Array.isArray(fix)) continue;
    const rawControls = fix._controls;
    const controls = rawControls && typeof rawControls === 'object' && !Array.isArray(rawControls)
      ? rawControls
      : {};
    if (Object.keys(controls).length) {
      controlsByName.set(normalizeName(entry.name), controls);
    }
    const before = clone(entry);
    for (const [key, value] of Object.entries(fix)) {
      if (key === '_controls') continue;
      entry[key] = value;
    }
    if (JSON.stringify(before) !== JSON.stringify(entry)) {
      touched.push(entry.name);
    }
  }

  const unresolved = Object.keys(manualFixes || {}).filter((name) => {
    return !entries.some((entry) => normalizeName(entry.name) === normalizeName(name));
  });

  return { touched, unresolved, controlsByName };
}

function formatList(items) {
  if (!items.length) return ['- none'];
  return items.map((item) => `- ${item}`);
}

async function main() {
  const summary = {
    added: [],
    removed: [],
    updated: [],
    skipped: [],
    ambiguous: [],
    autoPlaceUrls: [],
    clearedPlaceUrls: [],
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
    let indexes = createIndexes(locations);
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
      if (entry.requestType === 'add' && isBlockedTemporaryEntry(entry.name)) {
        summary.skipped.push(`${entry.name} (temporary/test entry)`);
        resolvedRows.add(rowIndex);
        continue;
      }
      if (entry.requestType === 'add' && !Number.isFinite(entry.score)) {
        summary.errors.push(`${entry.name}: score is required and must be a number.`);
        continue;
      }

      const key = normalizeName(entry.name);
      if (!key) {
        summary.errors.push(`${entry.name}: could not normalize restaurant name.`);
        continue;
      }

      if (entry.requestType === 'remove') {
        if (!hasRemovalIdentity(entry)) {
          summary.errors.push(`${entry.name}: remove request is missing exact location identity (reviewUrl, address/city/state, or coordinates).`);
          continue;
        }

        const removal = findRemovalMatch(entry, locations, indexes);
        if (removal.type === 'ambiguous') {
          const count = removal.candidates?.length || 0;
          summary.ambiguous.push(`${entry.name} (${count} candidate removal matches via ${removal.reason})`);
          continue;
        }
        if (removal.type !== 'match') {
          summary.skipped.push(`${entry.name} (remove target not found)`);
          continue;
        }

        const [removed] = locations.splice(removal.matchIndex, 1);
        indexes = createIndexes(locations);
        summary.removed.push(`${removed.name} (${removed.address || 'no address'}, ${removed.city || 'no city'}, ${removed.state || 'no state'})`);
        resolvedRows.add(rowIndex);
        continue;
      }

      const matchResult = findExistingMatch(entry, locations, indexes);
      if (matchResult.type === 'ambiguous') {
        const count = matchResult.candidates?.length || 0;
        summary.ambiguous.push(`${entry.name} (${count} candidate matches in locations.json via ${matchResult.reason})`);
        continue;
      }

      if (matchResult.type === 'match') {
        const matchIndex = matchResult.matchIndex;
        const before = clone(locations[matchIndex]);
        const merged = mergeEntry(locations[matchIndex], entry);
        locations[matchIndex] = merged.entry;
        updateIndexEntry(indexes, before, merged.entry, matchIndex);
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
      addIndexEntry(indexes, next, newIndex);
      enrichmentTargets.add(newIndex);
      summary.added.push(entry.name);
      resolvedRows.add(rowIndex);
    }

    const manualResult = applyManualFixes(locations, manualFixes);
    summary.updated.push(...manualResult.touched.filter((name) => !summary.updated.includes(name)));
    for (const name of manualResult.touched) {
      const matches = indexes.byName.get(normalizeName(name)) || [];
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
      if (!hasUsableCoordinates(entry) || shouldGenerateDirectionsUrl(entry) || !hasUsableGooglePlaceUrl(entry)) {
        enrichmentTargets.add(i);
      }
    }

    for (const targetIndex of enrichmentTargets) {
      const entry = locations[targetIndex];
      if (!entry) continue;
      const before = clone(entry);
      const controls = manualResult.controlsByName.get(normalizeName(entry.name)) || {};
      const changed = await enrichLocationEntry(entry, geocodeCache, summary, controls);
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
    console.log('Removed:');
    formatList(summary.removed).forEach((line) => console.log(line));
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
    console.log('Auto-generated Google place URLs:');
    formatList(summary.autoPlaceUrls).forEach((line) => console.log(line));
    console.log('');
    console.log('Cleared weak Google place URLs:');
    formatList(summary.clearedPlaceUrls).forEach((line) => console.log(line));
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
