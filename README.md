# Super-Goode-Map
Super Goode Food Map Interactive

## Add restaurants online
Use a private Google Form or Google Sheet as the intake source.

1. Create a Google Sheet with these columns: `name`, `score`, `subtitle`, `reviewUrl`, `directionsUrl`, `address`, `city`, `state`, `notes`, `approved`.
2. If you want form entry, point a Google Form at that sheet.
3. Share the sheet with the service account email from your GitHub secret.
4. Add these repo secrets:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_FILE`
   - `GOOGLE_SHEETS_SPREADSHEET_ID`
5. Optionally set the repo variable `GOOGLE_SHEETS_RANGE` if your data is not on `Sheet1!A1:Z`.
6. Run the GitHub Action in `.github/workflows/sync-sheet.yml` on a schedule or manually.
7. Only rows with `approved = yes` publish.
8. The action merges approved rows into `data/locations.json`, preserves stronger existing data, avoids duplicates, and commits the updated data back to the repo.

## How to add a new restaurant
1. Open `admin/add-review.html`.
2. Enter the restaurant info.
3. Copy the generated JSON.
4. Paste it into `data/new-reviews.json`.
5. Run `node scripts/update_locations.js`.
6. Review the console output.
7. Commit and push.

Use `data/manual-fixes.json` for permanent overrides. If you want to keep the intake file after a merge, run `node scripts/update_locations.js --keep-new-reviews`. The sheet sync script uses the same merge rules under the hood.
