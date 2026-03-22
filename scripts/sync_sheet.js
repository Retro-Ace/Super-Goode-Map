#!/usr/bin/env node

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const UPDATE_SCRIPT = path.join(ROOT, 'scripts', 'update_locations.js');
const APPROVED_VALUES = new Set(['yes', 'y', 'true', '1', 'approved', 'publish']);
const BLOCKED_TEMPORARY_NAMES = new Set(['test burger', 'test pizza place']);

function normalizeText(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanOptional(value) {
  const text = normalizeText(value);
  return text || '';
}

function cleanState(value) {
  return (cleanOptional(value) || 'IL').toUpperCase();
}

function coerceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isApproved(value) {
  return APPROVED_VALUES.has(normalizeText(value).toLowerCase());
}

function sanitizeRow(row) {
  const name = cleanOptional(row.name);
  const score = coerceNumber(row.score);
  if (!name || !Number.isFinite(score)) return null;

  return {
    name,
    score,
    subtitle: cleanOptional(row.subtitle),
    address: cleanOptional(row.address),
    city: cleanOptional(row.city) || 'Chicago',
    state: cleanState(row.state),
    lat: null,
    lng: null,
    directionsUrl: cleanOptional(row.directionsUrl),
    reviewUrl: cleanOptional(row.reviewUrl),
    sourceType: 'sheet',
    confidence: 'medium',
    notes: cleanOptional(row.notes),
  };
}

function temporaryNameKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isBlockedTemporaryEntry(value) {
  const key = temporaryNameKey(value);
  return BLOCKED_TEMPORARY_NAMES.has(key) || /^test\b/.test(key) || /^demo\b/.test(key) || /^sample\b/.test(key) || /^placeholder\b/.test(key) || /^temp(?:orary)?\b/.test(key);
}

function headerKey(header) {
  return normalizeText(header).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function canonicalField(header) {
  const key = headerKey(header);
  if (!key) return null;
  if (['name', 'restaurant name', 'restaurant', 'place name'].includes(key)) return 'name';
  if (['score', 'rating'].includes(key)) return 'score';
  if (['subtitle', 'category', 'category / subtitle', 'type'].includes(key)) return 'subtitle';
  if (['reviewurl', 'review video url', 'review video', 'review', 'video url'].includes(key)) return 'reviewUrl';
  if (['directionsurl', 'directions url', 'map url', 'google maps url'].includes(key)) return 'directionsUrl';
  if (['address', 'street address'].includes(key)) return 'address';
  if (key === 'city') return 'city';
  if (key === 'state') return 'state';
  if (['notes', 'note'].includes(key)) return 'notes';
  if (['approved', 'publish', 'publish status'].includes(key)) return 'approved';
  return null;
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

function rowsToObjects(values) {
  if (!Array.isArray(values) || !values.length) return [];
  const [headers, ...rows] = values;
  if (!Array.isArray(headers) || !headers.length) return [];

  const fields = headers.map(canonicalField);
  return rows.map((row) => {
    const obj = {};
    fields.forEach((field, index) => {
      if (!field) return;
      obj[field] = row?.[index] ?? '';
    });
    return obj;
  });
}

async function fetchCsvRows() {
  const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;
  if (!csvUrl) {
    throw new Error('Missing GOOGLE_SHEET_CSV_URL secret.');
  }

  const response = await fetch(csvUrl, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`CSV fetch failed: ${response.status} ${await response.text()}`);
  }

  const csvText = await response.text();
  const values = parseCsv(csvText);
  return {
    url: csvUrl,
    values,
  };
}

async function main() {
  const tmpPath = path.join(os.tmpdir(), `super-goode-sheet-import-${process.pid}.json`);

  try {
    const { url, values } = await fetchCsvRows();
    const rows = rowsToObjects(values);
    const approved = rows.filter((row) => isApproved(row.approved));
    const blocked = approved.filter((row) => isBlockedTemporaryEntry(row.name));
    const importable = approved.filter((row) => !isBlockedTemporaryEntry(row.name));
    const imported = importable
      .map((row) => sanitizeRow(row))
      .filter(Boolean);
    const invalid = importable.length - imported.length;
    const skipped = rows.length - approved.length;

    await fs.writeFile(tmpPath, `${JSON.stringify(imported, null, 2)}\n`, 'utf8');

    console.log(`CSV source: ${url}`);
    console.log(`Rows read: ${rows.length}`);
    console.log(`Approved rows: ${approved.length}`);
    console.log(`Blocked temporary rows: ${blocked.length}`);
    console.log(`Skipped rows: ${skipped}`);
    console.log(`Invalid approved rows: ${invalid}`);
    console.log(`Temp intake: ${tmpPath}`);
    console.log('');

    const result = spawnSync('node', [UPDATE_SCRIPT, '--input', tmpPath, '--keep-new-reviews'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });

    if (result.status !== 0) {
      process.exitCode = result.status || 1;
    }
  } catch (err) {
    console.error('Errors:');
    console.error(`- ${err.message}`);
    process.exitCode = 1;
  } finally {
    try {
      await fs.unlink(tmpPath);
    } catch (_) {
      // ignore cleanup failures
    }
  }
}

main();
