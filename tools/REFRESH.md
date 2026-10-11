# How the Wine Library stays current

## The pipeline

1. **Notion is the source of truth.** Jake's Claude chats log bottles, scores and
   notes in the Notion Wine Library (`collection://c43965be-a956-4750-be6d-5f1e25fee445`,
   under the "Wine Program" page).
2. **A GitHub Action syncs every 30 minutes** (`.github/workflows/sync.yml`). It runs
   `tools/sync_notion.py` (Notion to `tools/cellar.json` and `tools/palate.json`, no
   AI), then `tools/build.py`, commits only when something changed, and publishes the
   site. Pull a bottle in Notion and the site follows within about half an hour.
3. **A cloud routine does the judgment work** (this playbook, below): researching new
   wines, writing guest notes into Notion, curating display names, and the weekly
   Ask Jake log review. It runs Sundays, and the Action also starts it whenever a
   sync surfaces new work in `tools/pending.json`.

Manual refresh: GitHub, repo `jakeworcester-byte/wine-library`, Actions tab, "Sync
from Notion and publish," Run workflow.

## What lives where

| Data | Home |
|---|---|
| Bottles, counts, locations, scores, categories, drink windows, status, verdicts | Notion columns |
| Guest-facing text: note, pairing, caution | Notion columns **Guest Note**, **Guest Pairing**, **Guest Flag** |
| Which Notion rows make up which site wine, curated display names, color, tags | `tools/catalog.json` |
| Bottle photos and published tasting notes | `research/group-*.json`, `images/web/` |
| Palate profile and score-scale note for the chat | header of `tools/palate.json` |

`sync_notion.py` reads only whitelisted columns. It never reads Notes, Price Paid,
Buy Ceiling or Source, so nothing private can reach the site through the sync.

## Ground rules

- **Notion is the source of truth, and editing it is expected.** Write the Guest
  columns whenever they are missing or wrong. Fix identity mistakes (Wine, Producer,
  Vintage, AVA / Region) only on confirmed facts: Jake says so, or he reads it off
  the bottle. Web research alone is not enough, so an unattended run flags identity
  questions instead of editing. For an identity fix, add a dated line at the top of
  Notes in Jake's style ("LABEL CONFIRMED 2026-10-01: ...").
- **Never change** Jake Score, Repeat Buy, Status, On Hand, Location, prices, or his
  own Notes text. Never delete or archive a row. List every Notion edit in the report.
- **Never send email or messages.** The only outward actions are Notion edits and
  `git push` to `jakeworcester-byte/wine-library`.
- **Never use em dashes** (the long dash) anywhere on the site or in Guest columns.
  `build.py` refuses to write output containing one.
- **Guest-safe only.** Prices, Buy Ceiling, Source, where or how a bottle was bought,
  "under market," scoring-system talk (V5, lanes, calibration, "data point,"
  "evidence for"), and cellar logistics ("do not open," "window corrected from")
  never reach a Guest column.
- **Exception: bottle location is public.** The Location column and rack map belong
  on the site (Jake, Oct 3, 2026).

## Guest column rules (for the routine and for Jake's chats)

- **Guest Note:** one or two short sentences in Jake's first-person voice, warm,
  about how the wine drank. Keep comparisons to another vintage and trip or dinner
  context ("tasted at the winery in August 2026"). If Glass Evolution is "Built,"
  end with "Kept building in the glass." For a buy-list wine never tasted, say why
  it's on the list. A Tuesday Night score in the high 80s is a good bottle doing its
  job, not a knock. If the Notes hold no tasting impressions at all, write `-`,
  which means "nothing to show" and stops the row from being flagged again.
- **Guest Pairing:** a few words, e.g. "Prime ribeye," only when the Notes or
  Pairing Context name a real pairing.
- **Guest Flag:** a short guest-useful caution on a cellar bottle, e.g. "Saved for
  a vertical tasting." The Ask Jake chat treats it as a hold.
- Existing values in Notion are the style reference.

## Routine playbook

Start with `git pull --rebase origin main` and read `tools/pending.json` (the
Action rewrites it every sync, so it is at most 30 minutes old).

### 1. Guest notes (`needsGuestNote`)

Each item is a Notion row that has a Jake Score but an empty Guest Note. Fetch the
row with the Notion connector, read Notes, Glass Evolution, Pairing Context and
Jake Score, and write Guest Note (and Guest Pairing or Guest Flag if they apply)
following the rules above. Quote each new Guest Note in the report.

Also scan cellar rows (On Hand > 0) whose Notes say the bottle is held, reserved,
or saved for a vertical, and that have no Guest Flag: add one.

### 2. New wines (`newWines`)

Each item is a wine the sync has never seen. It is already on the site with a
provisional entry in `tools/catalog.json` (`"provisional": true`) and a placeholder
bottle.

- **First check it is really new.** If the Notion rows are a new vintage or a
  differently titled row of a wine already in `catalog.json`, point those row ids
  in `catalog.rows` at the existing slug and delete the provisional wine.
- **Curate the entry** in `catalog.wines[slug]`: `producer` and `name` cleaned up
  for display (e.g. "Taplin Cellars" / "Terra 9"), `short` (the rack map label,
  about 10 characters, enough to tell it apart from the producer's other wines:
  "Terra 9," "Taplin Cab," "OS Veeder"), `region`, `color` (red or white),
  optional `tags` (e.g. Bordeaux classification). Then remove `provisional`.
- **Research** into `research/group-weekly.json` (same shape as the other
  `research/group-*.json` files):
  - **Photo:** a clean upright bottle shot, label readable, correct producer and
    bottling (any vintage of the same label is fine). Prefer the winery site, then
    major retailers or Vivino. Download with curl using a browser User-Agent to
    `images/<slug>.<ext>`, confirm it is a real image at least 300px tall, and LOOK
    at it with the Read tool before using it. If unsure it is the right wine, set
    `image` to null (the site keeps the placeholder) and flag it.
  - **Tasting note per vintage:** winery tech sheet first, then reputable critics
    or retailers. Write 2 to 3 sentences (35 to 60 words) in your own words; never
    copy text verbatim. Record `noteVintage` (the vintage the note describes), a
    critic score only if confirmed (`{"critic": "...", "score": "..."}`), blend,
    `sourceName`, `sourceUrl`, plus a one-sentence `about` for the wine.
- New vintages of known wines also need a tasting note: run `python tools/build.py`
  and research every `! no web note` it prints for a vintage added since last week.

Tasting-record rows (not on hand) get default display names from Notion. If one
reads badly, add a `catalog.palate[<row id>]` entry with `producer`, `name`,
`region` (and `vintage`, `score` or `tried` overrides only when the default is
wrong). Existing entries are the style reference.

### 3. Build and publish

```bash
pip install --quiet pillow
python tools/build.py        # makes images/web/*.webp from new photos; prints warnings
git add tools/catalog.json research images/web
git commit -m "Cellar curation: <short summary>"
git pull --rebase origin main
git push origin main
```

Commit only those paths: the Action owns `cellar.json`, `palate.json`,
`pending.json`, `wines.json` and the root `palate.json`, and the push makes it
re-sync from Notion (picking up the Guest columns written in step 1) and publish.
Within about five minutes, `https://jakeworcester-byte.github.io/wine-library/wines.json`
should show the change. Do not fix `! rack:` warnings; report them for Jake to
correct in Notion. Only bump the `?v=N` asset queries in `index.html` if a file in
`assets/` changed.

### 4. Ask Jake question log (Sunday runs only; skip when started by the sync)

The routine's environment has `CLOUDFLARE_API_TOKEN` (D1 access only). Account
`b01cc7291822a7c352c71511ed533bee`, database `921de635-8434-422d-b56f-d3ab1971b8a9`
(`wine-chat-log`):

```bash
D1="https://api.cloudflare.com/client/v4/accounts/b01cc7291822a7c352c71511ed533bee/d1/database/921de635-8434-422d-b56f-d3ab1971b8a9/query"
curl -sS "$D1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"sql": "SELECT at, convo, turn, question, answer, searches, in_tokens, cache_read, cache_write, out_tokens, error FROM questions WHERE at >= datetime('"'"'now'"'"', '"'"'-7 days'"'"') ORDER BY at"}'
curl -sS "$D1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"sql": "DELETE FROM questions WHERE at < datetime('"'"'now'"'"', '"'"'-180 days'"'"')"}'
```

The log is anonymous: no names or IPs. Rows sharing a `convo` are one chat. If the
token is missing or rejected, skip this step and say so in the report.

Estimated cost per row at Sonnet 5 rates: (in_tokens x $2 + cache_write x $2.50
+ cache_read x $0.20 + out_tokens x $10) per million tokens, plus $0.01 per search.

### 5. Report

A short summary for Jake: what the sync shows in the cellar (bottles and wines);
new wines researched (and any photo or identity flagged for him); every Notion
edit, quoting new Guest Notes; and every `! rack:` warning from the build with the
fix Jake would make in Notion (or "the rack and library agree").

On Sunday runs, add "Ask Jake this week": number of chats and questions, the
questions (grouped by chat, lightly summarized if many), any answers that look
wrong or off-voice (quote the line), errors, and estimated spend. Don't change the
chat's prompt based on the log; suggest changes and let Jake decide. Never edit the
palate `profile` or `scaleNote` without Jake's approval; flag it if new tastings
seem to contradict the profile.
