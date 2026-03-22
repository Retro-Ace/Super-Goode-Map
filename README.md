# Super-Goode-Map
Super Goode Food Map Interactive

## Add restaurants online
Use a private Google Form or Google Sheet as the intake source, then publish the sheet as CSV.

1. Create a Google Sheet with these columns: `name`, `score`, `subtitle`, `reviewUrl`, `directionsUrl`, `address`, `city`, `state`, `notes`, `approved`.
2. If you want form entry, point a Google Form at that sheet.
3. Publish the sheet as CSV and copy the published CSV URL.
4. Add this GitHub secret:
   - `GOOGLE_SHEET_CSV_URL`
5. Run the GitHub Action in `.github/workflows/sync-sheet.yml` on a schedule or manually.
6. Only rows with `approved = yes` publish.
7. The action downloads the CSV, merges approved rows into `data/locations.json`, preserves stronger existing data, avoids duplicates, and commits the updated data back to the repo.

## How to add a new restaurant
1. Open `admin/add-review.html`.
2. Enter the restaurant info.
3. Copy the generated JSON.
4. Paste it into `data/new-reviews.json`.
5. Run `node scripts/update_locations.js`.
6. Review the console output.
7. Commit and push.

Use `data/manual-fixes.json` for permanent overrides. If you want to keep the intake file after a merge, run `node scripts/update_locations.js --keep-new-reviews`. The sheet sync script uses the same merge rules under the hood and only changes the ingestion source to a published CSV URL.
