#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT_DIR, "sponsor-ads");
const IMAGES_DIR = path.join(OUTPUT_DIR, "images");
const OUTPUT_JSON = path.join(OUTPUT_DIR, "sponsor-ads.json");
const FEED_VERSION = 1;
const PLACEMENT = "app_launch_banner";
const CHICAGO_TIME_ZONE = "America/Chicago";

const DEFAULT_PUBLIC_BASE_URL = "https://retro-ace.github.io/Super-Goode-Map";
const PUBLIC_BASE_URL = (
  process.env.SPONSOR_ADS_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL
).replace(/\/+$/, "");

const ALLOWED_LABELS = new Set([
  "Featured Local Partner",
  "Sponsored Local Listing",
  "Local Sponsor",
  "Featured Realtor",
  "Featured Business",
]);

const HEADER_ALIASES = new Map([
  ["active", "active"],
  ["adid", "id"],
  ["approved", "approved"],
  ["approvedforpublish", "approved"],
  ["businessname", "sponsorName"],
  ["campaignenddate", "endsAt"],
  ["campaignid", "id"],
  ["campaignstartdate", "startsAt"],
  ["creativeimageurl", "imageSourceUrl"],
  ["enddate", "endsAt"],
  ["endsat", "endsAt"],
  ["imageurl", "imageSourceUrl"],
  ["label", "label"],
  ["linkurl", "linkUrl"],
  ["placement", "placement"],
  ["sponsorbusinessname", "sponsorName"],
  ["sponsorlinkurl", "linkUrl"],
  ["sponsorname", "sponsorName"],
  ["startdate", "startsAt"],
  ["startsat", "startsAt"],
  ["targeturl", "linkUrl"],
  ["url", "linkUrl"],
  ["weight", "weight"],
]);

function normalizeHeader(header) {
  return String(header || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function cleanString(value) {
  return String(value || "").trim();
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    if (char !== "\r") {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);

  return rows.filter((csvRow) => csvRow.some((value) => cleanString(value)));
}

function rowsToObjects(rows) {
  const [headers, ...bodyRows] = rows;

  if (!headers || headers.length === 0) {
    return [];
  }

  const canonicalHeaders = headers.map((header) => {
    const key = normalizeHeader(header);
    return HEADER_ALIASES.get(key) || key;
  });

  return bodyRows.map((row) => {
    const record = {};

    canonicalHeaders.forEach((header, index) => {
      if (!header) {
        return;
      }

      record[header] = cleanString(row[index]);
    });

    return record;
  });
}

function isAffirmative(value) {
  const normalized = cleanString(value).toLowerCase();
  return ["yes", "y", "true", "approved", "publish", "1"].includes(normalized);
}

function isNegative(value) {
  const normalized = cleanString(value).toLowerCase();
  return ["no", "n", "false", "inactive", "0"].includes(normalized);
}

function slugify(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function toHttpsUrl(value, { requireImage = false } = {}) {
  const text = cleanString(value);

  if (!text) {
    return null;
  }

  try {
    const parsed = new URL(text);

    if (parsed.protocol !== "https:") {
      return null;
    }

    if (requireImage) {
      const pathname = parsed.pathname.toLowerCase();
      if (!/\.(jpe?g|png)$/.test(pathname)) {
        return null;
      }
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function imageExtensionFromUrl(imageUrl) {
  const pathname = new URL(imageUrl).pathname.toLowerCase();
  const match = pathname.match(/\.(jpe?g|png)$/);

  if (!match) {
    return null;
  }

  return match[1] === "jpeg" ? "jpg" : match[1];
}

function parseDateOnly(value) {
  const text = cleanString(value);
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
    };
  }

  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (slashMatch) {
    return {
      year: Number(slashMatch[3]),
      month: Number(slashMatch[1]),
      day: Number(slashMatch[2]),
    };
  }

  return null;
}

function addDays(dateParts, days) {
  const date = new Date(
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + days)
  );

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function offsetMinutesForTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(date);

  const timeZoneName = parts.find((part) => part.type === "timeZoneName")?.value;

  if (!timeZoneName || timeZoneName === "GMT") {
    return 0;
  }

  const match = timeZoneName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);

  if (!match) {
    return 0;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || 0);

  return sign * (hours * 60 + minutes);
}

function chicagoMidnightToUtcIso(dateParts) {
  const localTimestamp = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    0,
    0,
    0
  );
  let offset = offsetMinutesForTimeZone(new Date(localTimestamp), CHICAGO_TIME_ZONE);
  let utcTimestamp = localTimestamp - offset * 60 * 1000;

  offset = offsetMinutesForTimeZone(new Date(utcTimestamp), CHICAGO_TIME_ZONE);
  utcTimestamp = localTimestamp - offset * 60 * 1000;

  return new Date(utcTimestamp).toISOString();
}

function parseCampaignTimestamp(value, role) {
  const text = cleanString(value);

  if (!text) {
    return null;
  }

  if (text.includes("T")) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const dateParts = parseDateOnly(text);

  if (!dateParts) {
    return null;
  }

  return chicagoMidnightToUtcIso(role === "end" ? addDays(dateParts, 1) : dateParts);
}

function parseWeight(value) {
  const text = cleanString(value);

  if (!text) {
    return 1;
  }

  const parsed = Number(text);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    return null;
  }

  return parsed;
}

function publicImageUrl(filename) {
  return `${PUBLIC_BASE_URL}/sponsor-ads/images/${filename}`;
}

function sanitizeSponsorRow(row, seenIds) {
  if (!isAffirmative(row.approved)) {
    return { skipped: true, reason: "not approved" };
  }

  const sponsorName = cleanString(row.sponsorName);
  const label = cleanString(row.label);
  const placement = cleanString(row.placement) || PLACEMENT;
  const startsAt = parseCampaignTimestamp(row.startsAt, "start");
  const endsAt = parseCampaignTimestamp(row.endsAt, "end");
  const weight = parseWeight(row.weight);
  const imageSourceUrl = toHttpsUrl(row.imageSourceUrl, { requireImage: true });

  if (!sponsorName) {
    return { skipped: true, reason: "missing sponsorName" };
  }

  if (!ALLOWED_LABELS.has(label)) {
    return { skipped: true, reason: `invalid label for ${sponsorName}` };
  }

  if (placement !== PLACEMENT) {
    return { skipped: true, reason: `invalid placement for ${sponsorName}` };
  }

  if (!imageSourceUrl) {
    return { skipped: true, reason: `invalid image URL for ${sponsorName}` };
  }

  if (!startsAt || !endsAt || new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    return { skipped: true, reason: `invalid campaign dates for ${sponsorName}` };
  }

  if (weight === null) {
    return { skipped: true, reason: `invalid weight for ${sponsorName}` };
  }

  const idSource =
    cleanString(row.id) ||
    `${sponsorName}-${startsAt.slice(0, 7)}`;
  const id = slugify(idSource);

  if (!id) {
    return { skipped: true, reason: `invalid id for ${sponsorName}` };
  }

  if (seenIds.has(id)) {
    return { skipped: true, reason: `duplicate id ${id}` };
  }

  seenIds.add(id);

  const extension = imageExtensionFromUrl(imageSourceUrl);
  const staticImageFilename = `${id}.${extension}`;
  const linkUrl = toHttpsUrl(row.linkUrl);
  const active = cleanString(row.active) ? !isNegative(row.active) : true;

  return {
    skipped: false,
    imageSourceUrl,
    staticImageFilename,
    ad: {
      id,
      active,
      sponsorName,
      label,
      placement: PLACEMENT,
      imageUrl: publicImageUrl(staticImageFilename),
      ...(linkUrl ? { linkUrl } : {}),
      startsAt,
      endsAt,
      weight,
    },
  };
}

async function downloadImage(imageUrl, outputPath) {
  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(`image fetch failed with ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
}

async function cleanStaleImages(keepFilenames) {
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  const entries = await fs.readdir(IMAGES_DIR, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .filter((entry) => /\.(jpe?g|png)$/i.test(entry.name))
      .filter((entry) => !keepFilenames.has(entry.name))
      .map((entry) => fs.unlink(path.join(IMAGES_DIR, entry.name)))
  );
}

async function writeFeed(ads) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const feed = {
    version: FEED_VERSION,
    ads,
  };

  await fs.writeFile(`${OUTPUT_JSON}.tmp`, `${JSON.stringify(feed, null, 2)}\n`);
  await fs.rename(`${OUTPUT_JSON}.tmp`, OUTPUT_JSON);
}

async function main() {
  const csvUrl = cleanString(process.env.SPONSOR_ADS_SHEET_CSV_URL);

  if (!csvUrl) {
    throw new Error("SPONSOR_ADS_SHEET_CSV_URL is required.");
  }

  const response = await fetch(csvUrl);

  if (!response.ok) {
    throw new Error(`Sponsor sheet fetch failed with ${response.status}.`);
  }

  const csv = await response.text();
  const rows = rowsToObjects(parseCsv(csv));
  const seenIds = new Set();
  const accepted = [];
  const skipped = [];

  for (const row of rows) {
    const result = sanitizeSponsorRow(row, seenIds);

    if (result.skipped) {
      skipped.push(result.reason);
      continue;
    }

    try {
      await fs.mkdir(IMAGES_DIR, { recursive: true });
      await downloadImage(
        result.imageSourceUrl,
        path.join(IMAGES_DIR, result.staticImageFilename)
      );
      accepted.push(result);
    } catch (error) {
      skipped.push(`${result.ad.id}: ${error.message}`);
    }
  }

  accepted.sort((first, second) => first.ad.id.localeCompare(second.ad.id));

  await cleanStaleImages(new Set(accepted.map((entry) => entry.staticImageFilename)));
  await writeFeed(accepted.map((entry) => entry.ad));

  console.log(
    `Wrote ${accepted.length} sponsor ad(s) to ${path.relative(ROOT_DIR, OUTPUT_JSON)}.`
  );

  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} row(s):`);
    skipped.forEach((reason) => console.log(`- ${reason}`));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
