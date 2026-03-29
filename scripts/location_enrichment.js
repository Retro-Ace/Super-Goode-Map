const fs = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GEOCODE_CACHE_PATH = path.join(ROOT, 'data', 'geocode-cache.json');
const GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
const GEOCODER_HEADERS = {
  'User-Agent': 'Super-Goode-Map/1.0 (web-map data enrichment)',
  Accept: 'application/json',
};

let lastGeocodeRequestAt = 0;

function normalizeAddressPart(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildFullAddress(entry) {
  const address = normalizeAddressPart(entry.address);
  const city = normalizeAddressPart(entry.city);
  const state = normalizeAddressPart(entry.state).toUpperCase();
  const parts = [address, city, state].filter(Boolean);
  if (!parts.length) return '';
  return `${parts.join(', ')}, USA`;
}

function buildDirectionsUrl(entry) {
  const destination = buildFullAddress(entry);
  if (!destination) return '';
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

function buildGooglePlaceQuery(entry) {
  const name = normalizeAddressPart(entry?.name);
  const address = normalizeAddressPart(entry?.address);
  const city = normalizeAddressPart(entry?.city);
  const state = normalizeAddressPart(entry?.state).toUpperCase();
  const locationParts = [address, city, state].filter(Boolean);

  // Require a street-level-ish address before auto-generating a place-style URL.
  // This avoids turning city-only or popup-style rows into misleading place links.
  if (!name || !locationParts.length || !/\d/.test(address)) return '';
  return [name, ...locationParts].join(', ');
}

function buildGooglePlaceUrl(entry) {
  const query = buildGooglePlaceQuery(entry);
  if (!query) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function hasUsableGooglePlaceUrl(entry) {
  if (!entry?.googlePlaceUrl) return false;
  try {
    const parsed = new URL(String(entry.googlePlaceUrl));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isFiniteCoordinate(value) {
  if (value === null || value === undefined || value === '') return false;
  const num = Number(value);
  return Number.isFinite(num);
}

function hasUsableCoordinates(entry) {
  if (!isFiniteCoordinate(entry.lat) || !isFiniteCoordinate(entry.lng)) return false;
  const lat = Number(entry.lat);
  const lng = Number(entry.lng);
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

function hasUsableDirectionsUrl(entry) {
  if (!entry?.directionsUrl) return false;
  try {
    const parsed = new URL(String(entry.directionsUrl));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function shouldGenerateDirectionsUrl(entry) {
  return !hasUsableGooglePlaceUrl(entry) && !hasUsableDirectionsUrl(entry);
}

function cacheKeyForAddress(address) {
  return normalizeAddressPart(address).toLowerCase();
}

async function readGeocodeCache() {
  try {
    const raw = await fs.readFile(GEOCODE_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeGeocodeCache(cache) {
  await fs.writeFile(GEOCODE_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocodeAddress(address, cache) {
  const key = cacheKeyForAddress(address);
  if (!key) {
    return { status: 'missing-address', result: null, cached: false };
  }

  const cached = cache[key];
  if (cached) {
    if (cached.status === 'ok' && isFiniteCoordinate(cached.lat) && isFiniteCoordinate(cached.lng)) {
      return {
        status: 'ok',
        cached: true,
        result: {
          lat: Number(cached.lat),
          lng: Number(cached.lng),
          displayName: cached.displayName || '',
        },
      };
    }
    return { status: cached.status || 'not-found', result: null, cached: true };
  }

  const waitMs = Math.max(0, 1150 - (Date.now() - lastGeocodeRequestAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  const url = new URL(GEOCODER_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('q', address);

  lastGeocodeRequestAt = Date.now();
  const response = await fetch(url, { headers: GEOCODER_HEADERS });
  if (!response.ok) {
    throw new Error(`Geocoder request failed (${response.status}) for "${address}"`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows) || !rows.length) {
    cache[key] = {
      status: 'not-found',
      updatedAt: new Date().toISOString(),
    };
    return { status: 'not-found', result: null, cached: false };
  }

  const first = rows[0];
  const result = {
    lat: Number(first.lat),
    lng: Number(first.lon),
    displayName: first.display_name || '',
  };

  if (!isFiniteCoordinate(result.lat) || !isFiniteCoordinate(result.lng)) {
    cache[key] = {
      status: 'invalid',
      updatedAt: new Date().toISOString(),
    };
    return { status: 'invalid', result: null, cached: false };
  }

  cache[key] = {
    status: 'ok',
    lat: result.lat,
    lng: result.lng,
    displayName: result.displayName,
    updatedAt: new Date().toISOString(),
  };

  return { status: 'ok', result, cached: false };
}

async function enrichLocationEntry(entry, cache, summary) {
  const fullAddress = buildFullAddress(entry);
  let changed = false;

  if (!hasUsableGooglePlaceUrl(entry)) {
    const googlePlaceUrl = buildGooglePlaceUrl(entry);
    if (googlePlaceUrl) {
      entry.googlePlaceUrl = googlePlaceUrl;
      summary.autoPlaceUrls.push(`${entry.name} -> ${entry.googlePlaceUrl}`);
      changed = true;
    }
  }

  if (shouldGenerateDirectionsUrl(entry) && fullAddress) {
    entry.directionsUrl = buildDirectionsUrl(entry);
    summary.autoDirections.push(`${entry.name} -> ${entry.directionsUrl}`);
    changed = true;
  }

  if (hasUsableCoordinates(entry) || !fullAddress) {
    return changed;
  }

  try {
    const geocoded = await geocodeAddress(fullAddress, cache);
    if (geocoded.status === 'ok' && geocoded.result) {
      entry.lat = geocoded.result.lat;
      entry.lng = geocoded.result.lng;
      summary.autoGeocoded.push(
        geocoded.cached
          ? `${entry.name} (${fullAddress}) [cache]`
          : `${entry.name} (${fullAddress})`,
      );
      changed = true;
      return changed;
    }

    summary.geocodeFailed.push(`${entry.name} (${fullAddress}) [${geocoded.status}]`);
    return changed;
  } catch (err) {
    summary.geocodeFailed.push(`${entry.name} (${fullAddress}) [${err.message}]`);
    return changed;
  }
}

module.exports = {
  GEOCODE_CACHE_PATH,
  buildDirectionsUrl,
  buildFullAddress,
  buildGooglePlaceUrl,
  buildGooglePlaceQuery,
  enrichLocationEntry,
  hasUsableGooglePlaceUrl,
  hasUsableCoordinates,
  hasUsableDirectionsUrl,
  readGeocodeCache,
  shouldGenerateDirectionsUrl,
  writeGeocodeCache,
};
