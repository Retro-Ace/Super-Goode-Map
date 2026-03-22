# Super-Goode-Map
Super Goode Food Map Interactive

## How to add a new restaurant
1. Open `admin/add-review.html`.
2. Enter the restaurant info.
3. Copy the generated JSON.
4. Paste it into `data/new-reviews.json`.
5. Run `node scripts/update_locations.js`.
6. Review the console output.
7. Commit and push.

Use `data/manual-fixes.json` for permanent overrides. If you want to keep the intake file after a merge, run `node scripts/update_locations.js --keep-new-reviews`.
