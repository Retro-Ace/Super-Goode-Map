# Sponsor Ads Publishing Workflow

This repo publishes the static sponsor ad feed consumed by the Super Goode mobile app. It does not use an ad network, tracking SDK, login system, backend database, or the restaurant data pipeline.

## Static outputs

- Feed URL: `https://retro-ace.github.io/Super-Goode-Map/sponsor-ads/sponsor-ads.json`
- Feed file: `sponsor-ads/sponsor-ads.json`
- Creative image folder: `sponsor-ads/images/`
- Creative template: `1200 x 360 px`
- Creative ratio: `10:3`
- Creative formats: `.jpg`, `.jpeg`, or `.png`

The mobile app should point `EXPO_PUBLIC_SPONSOR_ADS_FEED_URL` at the feed URL only after the publishing workflow is ready.

## Google Form fields

Create a Google Form named `Super Goode Sponsor Ad Intake` with these respondent-facing fields:

- Sponsor name: required short answer.
- Sponsor link URL: optional short answer. Must be HTTPS when provided.
- Campaign start date: required date.
- Campaign end date: required date. This is the last local calendar day the ad should run.
- Creative image link (Dropbox or Google Drive): required short answer. Use a public Dropbox share link, public Google Drive file share link, or public direct HTTPS `.jpg`, `.jpeg`, or `.png` URL for a `1200 x 360 px` creative.
- Approved: required multiple choice with `Yes` and `No`.
- Notes: optional paragraph.

Do not expose sponsor label, active state, campaign ID, placement, weight, or amount charged on the public form. The feed still contains required `label` metadata, but the sync script defaults it to `Featured Local Partner` when the Sheet does not provide a label.

Do not use Google Form private file uploads for v1 unless a future Google Drive API credential flow is added. The current GitHub Action expects a public Dropbox link, public Google Drive file link, or direct HTTPS image URL that it can fetch without signing in.

## Google Sheet approval columns

Link the form to a response Sheet. The form should create the `Approved` response column. Then add these editor-only columns to the right side of the response columns:

- `Active`: optional. Blank means active. Use `No` to publish the row as inactive.
- `Campaign ID`: optional slug override. Blank generates an ID from sponsor name and campaign month.
- `Placement`: optional. Blank defaults to `app_launch_banner`.
- `Weight`: optional integer `1` through `10`. Blank defaults to `1`; higher values make the ad more likely to be selected when multiple eligible ads are active.
- `Amount charged`: optional manual bookkeeping field for internal records only. It is ignored by the app feed.

Only rows with `Approved` set to `Yes` are considered for the static feed. Inactive rows can remain in the feed with `active: false`; the app filters them out.

## Sheet publishing

Publish the response Sheet tab as CSV:

1. Open the linked response Sheet.
2. Use `File -> Share -> Publish to web`.
3. Choose the response tab.
4. Choose `Comma-separated values (.csv)`.
5. Publish and copy the generated CSV URL.
6. Add the URL as the GitHub repository secret `SPONSOR_ADS_SHEET_CSV_URL`.

Optional repository variable:

- `SPONSOR_ADS_PUBLIC_BASE_URL`: public GitHub Pages base URL. Defaults to `https://retro-ace.github.io/Super-Goode-Map`.

## GitHub Action

The `Sync Sponsor Ads` workflow runs `scripts/sync_sponsor_ads.js`.

It:

- fetches the published Sheet CSV,
- reads approved sponsor rows,
- validates sponsor fields,
- downloads approved public sponsor creatives from direct HTTPS image URLs, Dropbox share links, or Google Drive file share links into `sponsor-ads/images/`,
- writes `sponsor-ads/sponsor-ads.json`,
- removes stale managed JPG/PNG files from `sponsor-ads/images/`,
- commits only sponsor feed/image changes when output changes.

Invalid rows are skipped. A valid Sheet with no approved rows writes:

```json
{
  "version": 1,
  "ads": []
}
```

## Feed schema

The published feed is:

```json
{
  "version": 1,
  "ads": [
    {
      "id": "lindsey-harrison-may-2026",
      "active": true,
      "sponsorName": "Lindsey Harrison Real Estate",
      "label": "Featured Local Partner",
      "placement": "app_launch_banner",
      "imageUrl": "https://retro-ace.github.io/Super-Goode-Map/sponsor-ads/images/lindsey-harrison-may-2026.jpg",
      "linkUrl": "https://example.com",
      "startsAt": "2026-05-01T05:00:00.000Z",
      "endsAt": "2026-06-01T05:00:00.000Z",
      "weight": 1
    }
  ]
}
```

Date-only Sheet values are interpreted as America/Chicago local calendar dates. End dates are inclusive in the Sheet and are converted to the next local midnight in the JSON feed.

## Validation rules

- `Approved` must be affirmative (`Yes`, `Y`, `True`, `Approved`, `Publish`, or `1`) before a row is considered.
- `Sponsor name` is required.
- `Sponsor label` is not needed on the form or Sheet. If no label column exists, the feed label defaults to `Featured Local Partner`.
- `Placement` must be blank or `app_launch_banner`.
- `Creative image link` must be HTTPS and must be either a direct `.jpg`, `.jpeg`, or `.png` URL, a public Dropbox share link, or a public Google Drive file share link.
- Downloaded creative bytes must resolve to JPG or PNG before the row is accepted.
- `Sponsor link URL` is optional. Invalid or non-HTTPS links are stripped.
- `Campaign start date` and `Campaign end date` are required.
- The generated `endsAt` timestamp must be after `startsAt`.
- `Weight` defaults to `1` and must be an integer from `1` to `10`.
- `Amount charged` is ignored by the feed and can contain any internal bookkeeping value.
- IDs must be unique after slug generation. Duplicate IDs are skipped.

## Operating checklist

- Keep sponsor ads separate from `data/locations.json`.
- Keep sponsor creatives at `1200 x 360 px`.
- Use public Dropbox links, public Google Drive file links, or direct HTTPS image URLs before approval.
- Set `Approved` to `Yes` only after the creative, link, and dates are correct.
- Keep `Weight` and `Amount charged` as editor-only Sheet fields; do not add them to the public form.
- Run the GitHub Action manually after urgent sponsor changes.
- Confirm the feed URL loads JSON before enabling or changing the app env var.
