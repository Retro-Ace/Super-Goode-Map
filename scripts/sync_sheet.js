#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const UPDATE_SCRIPT = path.join(ROOT, 'scripts', 'update_locations.js');
const DEFAULT_RANGE = 'Sheet1!A1:Z';
const APPROVED_VALUES = new Set(['yes', 'y', 'true', '1', 'approved', 'publish']);

const argv = process.argv.slice(2);
const getArg = (name) => {
  const index = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index < 0) return null;
  const current = argv[index];
  if (current.includes('=')) return current.split('=').slice(1).join('=');
  return argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : null;
};

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

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function readCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  const text = raw || (filePath ? require('fs').readFileSync(filePath, 'utf8') : '');
  if (!text) {
    throw new Error('Missing Google service account credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE.');
  }
  const credentials = JSON.parse(text);
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Service account JSON must include client_email and private_key.');
  }
  return credentials;
}

function createJwt(credentials, scope) {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claims = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = signer.sign(credentials.private_key);
  return `${header}.${claims}.${base64Url(signature)}`;
}

async function fetchAccessToken(credentials) {
  const assertion = createJwt(credentials, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Token exchange did not return an access token.');
  }
  return data.access_token;
}

async function fetchSheetRows() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || getArg('spreadsheet-id');
  if (!spreadsheetId) {
    throw new Error('Missing spreadsheet ID. Set GOOGLE_SHEETS_SPREADSHEET_ID or pass --spreadsheet-id.');
  }

  const range = process.env.GOOGLE_SHEETS_RANGE || getArg('range') || DEFAULT_RANGE;
  const credentials = readCredentials();
  const token = await fetchAccessToken(credentials);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Sheet fetch failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return {
    range,
    values: Array.isArray(data.values) ? data.values : [],
  };
}

async function main() {
  const tmpPath = path.join(os.tmpdir(), `super-goode-sheet-import-${process.pid}.json`);

  try {
    const { range, values } = await fetchSheetRows();
    const rows = rowsToObjects(values);
    const approved = rows.filter((row) => isApproved(row.approved));
    const imported = approved
      .map((row) => sanitizeRow(row))
      .filter(Boolean);
    const invalid = approved.length - imported.length;
    const skipped = rows.length - approved.length;

    await fs.writeFile(tmpPath, `${JSON.stringify(imported, null, 2)}\n`, 'utf8');

    console.log(`Google Sheet range: ${range}`);
    console.log(`Rows read: ${rows.length}`);
    console.log(`Approved rows: ${approved.length}`);
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
