#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'data', 'locations.json');
const MIRROR_PATH = path.join(ROOT, 'locations.json');
const CSV_PATH = path.join(ROOT, 'super_goode_locations.csv');
const INDEX_PATH = path.join(ROOT, 'index.html');
const DEFAULT_HEADERS = [
  'name',
  'score',
  'subtitle',
  'address',
  'city',
  'state',
  'lat',
  'lng',
  'reviewUrl',
  'googlePlaceUrl',
  'directionsUrl',
  'sourceType',
  'confidence',
  'notes',
];
const CANONICAL_EXPORT_FIELDS = new Set(DEFAULT_HEADERS);

function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stringifyCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value);
}

function escapeCsv(value) {
  const text = stringifyCell(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsv(text) {
  const rows = [];
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  let row = [];
  let cell = '';
  let i = 0;
  let inQuotes = false;

  const pushCell = () => {
    row.push(cell);
    cell = '';
  };

  const pushRow = () => {
    if (row.length || cell.length) {
      pushCell();
      rows.push(row);
    }
    row = [];
  };

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushCell();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (next === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }

    cell += ch;
    i += 1;
  }

  if (inQuotes) {
    throw new Error('CSV parse failed: unterminated quoted field.');
  }

  if (cell.length || row.length) {
    pushRow();
  }

  return rows;
}

async function readExistingCsv() {
  try {
    const raw = await fs.readFile(CSV_PATH, 'utf8');
    const rows = parseCsv(raw);
    if (!rows.length) {
      return { headers: [...DEFAULT_HEADERS], rowMap: new Map() };
    }

    const [headers, ...values] = rows;
    const rowMap = new Map();
    for (const valueRow of values) {
      const row = {};
      headers.forEach((header, index) => {
        row[header] = valueRow[index] ?? '';
      });
      const key = normalizeName(row.name);
      if (key && !rowMap.has(key)) {
        rowMap.set(key, row);
      }
    }

    return { headers, rowMap };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { headers: [...DEFAULT_HEADERS], rowMap: new Map() };
    }
    throw err;
  }
}

function determineHeaders(existingHeaders, locations) {
  const headers = existingHeaders.length ? [...existingHeaders] : [...DEFAULT_HEADERS];
  if (!headers.includes('googlePlaceUrl')) {
    const directionsIndex = headers.indexOf('directionsUrl');
    if (directionsIndex >= 0) {
      headers.splice(directionsIndex, 0, 'googlePlaceUrl');
    } else {
      headers.push('googlePlaceUrl');
    }
  }
  const locationKeys = new Set(headers);

  for (const location of locations) {
    for (const key of Object.keys(location || {})) {
      if (locationKeys.has(key)) continue;
      headers.push(key);
      locationKeys.add(key);
    }
  }

  return headers;
}

function buildCsvText(locations, headers, rowMap) {
  const lines = [headers.map(escapeCsv).join(',')];

  for (const location of locations) {
    const preserved = rowMap.get(normalizeName(location.name)) || {};
    const line = headers.map((header) => {
      if (CANONICAL_EXPORT_FIELDS.has(header)) {
        return escapeCsv(location[header] ?? '');
      }
      if (Object.prototype.hasOwnProperty.call(location, header)) {
        return escapeCsv(location[header]);
      }
      return escapeCsv(preserved[header] ?? '');
    });
    lines.push(line.join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}

function replaceEmbeddedData(indexHtml, locations) {
  const replacement = `const DATA = ${JSON.stringify(locations)};`;
  const pattern = /const DATA = \[[\s\S]*?\];/;
  if (!pattern.test(indexHtml)) {
    throw new Error('Failed to locate embedded DATA array in index.html.');
  }
  return indexHtml.replace(pattern, replacement);
}

async function main() {
  const locations = JSON.parse(await fs.readFile(SOURCE_PATH, 'utf8'));
  if (!Array.isArray(locations)) {
    throw new Error('data/locations.json must contain an array.');
  }

  const [{ headers: existingHeaders, rowMap }, indexHtml] = await Promise.all([
    readExistingCsv(),
    fs.readFile(INDEX_PATH, 'utf8'),
  ]);

  const headers = determineHeaders(existingHeaders, locations);
  const csvText = buildCsvText(locations, headers, rowMap);
  const mirroredJson = stringifyJson(locations);
  const nextIndexHtml = replaceEmbeddedData(indexHtml, locations);

  await Promise.all([
    fs.writeFile(MIRROR_PATH, mirroredJson, 'utf8'),
    fs.writeFile(CSV_PATH, csvText, 'utf8'),
    fs.writeFile(INDEX_PATH, nextIndexHtml, 'utf8'),
  ]);

  console.log(`Refreshed static artifacts from ${path.relative(ROOT, SOURCE_PATH)}.`);
  console.log(`- Mirror: ${path.relative(ROOT, MIRROR_PATH)}`);
  console.log(`- CSV rows: ${locations.length}`);
  console.log(`- CSV headers: ${headers.length}`);
  console.log(`- Embedded fallback rows: ${locations.length}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
