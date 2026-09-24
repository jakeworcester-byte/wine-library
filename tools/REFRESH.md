# Weekly refresh playbook

How to sync the site with the Notion Wine Library. Written for an unattended run:
follow it exactly, and when something is ambiguous, leave it out and flag it in the
report instead of guessing.

## Ground rules

- **Never edit Notion.** Read only.
- **Never send email or messages.** The only outward action is `git push` to
  `jakeworcester-byte/wine-library`.
- **Never use em dashes** (the long dash) anywhere on the site. `build.py` refuses
  to write output containing one.
- **Guest-safe only.** Prices, Buy Ceiling, Source, where or how a bottle was bought,
  "under market," scoring-system talk (V5, lanes, calibration, "data point,"
  "evidence for"), and cellar logistics ("do not open," "window corrected from")
  never reach the site.

## 1. Pull stocked wines from Notion

Data source: `collection://c43965be-a956-4750-be6d-5f1e25fee445` (database
"Wine Library" under the "Wine Program" page). Query with SQL:

```sql
SELECT url, "Wine", "Producer", "Vintage", "AVA / Region", "On Hand", "Status",
       "Category", "Jake Score", "Drink Window", "Glass Evolution", "Notes"
FROM "collection://c43965be-a956-4750-be6d-5f1e25fee445"
WHERE "On Hand" > 0
```

Also pull every scored row (any status) for reference lines:

```sql
SELECT "Wine", "Producer", "Vintage", "Jake Score"
FROM "collection://c43965be-a956-4750-be6d-5f1e25fee445"
WHERE "Jake Score" IS NOT NULL AND "Jake Score" <> ''
```

`On Hand` is the source of truth for whether a bottle is in the cellar. Ignore the
Status field. Two rows for the same wine and vintage are merged: add their On Hand.

## 2. Diff against `tools/cellar.json`

Match Notion rows to existing entries by wine identity and vintage (producer names
vary in Notion, e.g. "Taplin" vs "Taplin Cellars"; use judgment, and check the
existing slugs first). Classify every change:

- **Removed** (in cellar.json, no longer On Hand > 0): delete that vintage. If no
  vintages remain, delete the wine and its `images/web/<slug>.webp`.
- **Count change:** update `onHand`.
- **New vintage of an existing wine:** add it under the existing slug.
- **New wine:** add a new slug (kebab-case, producer + wine, no vintage), then do
  step 3.
- **New or changed Jake Score, notes, category, or drink window:** update.

If nothing changed, stop here: no commit, and report "no changes."

## 3. Research any new wine

For each new slug or new vintage, add an entry to `research/group-weekly.json`
(same shape as the other `research/group-*.json` files):

- **Photo:** a clean upright bottle shot, label readable, correct producer and
  bottling (any vintage of the same label is fine). Prefer the winery site, then
  major retailers or Vivino. Download with curl using a browser User-Agent to
  `images/<slug>.<ext>`, confirm it is a real image at least 300px tall, and LOOK
  at it with the Read tool before using it. If unsure it is the right wine, set
  `image` to null (the site shows a placeholder bottle) and flag it.
- **Tasting note per vintage:** winery tech sheet first, then reputable critics or
  retailers. Write 2 to 3 sentences (35 to 60 words) in your own words; never copy
  text verbatim. Record `noteVintage` (the vintage the note actually describes),
  a critic score only if confirmed (`{"critic": "...", "score": "..."}`), blend,
  `sourceName`, `sourceUrl`, plus a one-sentence `about` for the wine.

## 4. Write `tools/cellar.json` entries

Per vintage:

- `onHand`, `category` (Notion Category or null).
- `window` and `peak`: split Notion's Drink Window, e.g.
  `"2029-2042 (peak 2032-2038), est."` (Notion puts a long dash before "est.")
  becomes `window: "2029-2042"`, `peak: "2032-2038"`. Keep "Now" as written
  (`"Now-2027"`). Drop "est.," the dash, and any commentary after the ranges,
  including hints like "(drink early)".
- `jakeScore`: Notion Jake Score, only when present.
- `jakeNote`: only when the Notion Notes contain real tasting impressions. Rewrite
  them for guests in Jake's first-person voice, short and warm, keeping any
  comparison to another vintage and any trip or dinner context ("tasted at the
  winery in August 2026"). If Glass Evolution is "Built," end with "Kept building
  in the glass." If the notes are only logistics or system talk, leave `jakeNote`
  out entirely. Existing examples in cellar.json are the style reference.
- `flag`: short guest-useful caution only, e.g. "Saved for a vertical tasting."

Per wine: `producer` and `name` cleaned up for display (e.g. "Taplin Cellars" /
"Terra 9"), `region`, `color` (red or white), optional `tags` (e.g. Bordeaux
classification), and `otherScores`: every scored vintage of the same wine from the
second query, as `{"vintage": "2019", "score": "94-95"}`.

Set `snapshotDate` to today (YYYY-MM-DD).

## 5. Build, check, publish

```bash
cd "Projects/Wine Library"
python tools/build.py        # prints counts and warns on anything missing
git add -A
git commit -m "Weekly cellar sync: <short summary>"
git pull --rebase origin main
git push origin main
```

Fix any `! missing` or `! no web note` warnings for wines added this run before
committing. Only bump the `?v=N` asset query in `index.html` if you changed
`assets/app.js` or `assets/styles.css` (a normal sync does not).

Verify the deploy: within about 3 minutes,
`https://jakeworcester-byte.github.io/wine-library/wines.json` should show the new
`updated` date and bottle count.

## 6. Report

End with a short summary for Jake: bottles and wines now in the cellar; what was
added, removed, and changed; any new Jake's Notes (quote the guest version); and
anything flagged for him to check (uncertain photo, wine identity, note from a
different vintage).
