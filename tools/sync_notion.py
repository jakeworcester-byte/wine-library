"""Sync the site's data files from the Notion Wine Library. No AI involved.

Reads every row of the Notion "Wine Library" data source and writes:
  tools/cellar.json   wines with On Hand > 0, grouped by wine and vintage
  tools/palate.json   the tasting record: logged wines not in the cellar
  tools/pending.json  work for the weekly cloud routine (new wines to research,
                      tasted rows that still need a Guest Note)

Only whitelisted fields leave Notion. Prices, Buy Ceiling, Source and the raw
Notes column are never read. Guest-facing text comes only from the Guest Note,
Guest Pairing and Guest Flag columns.

tools/catalog.json holds what Notion doesn't: which rows belong to which site
wine (slug), curated display names, color and tags. New rows are matched to an
existing wine by title; anything unmatched becomes a provisional entry and is
listed in pending.json for the routine to research and curate.

Usage:
  NOTION_TOKEN=... python tools/sync_notion.py          # live
  python tools/sync_notion.py --rows rows.json          # from a saved dump (testing)
Exit code 0 always means the files are valid; it prints "no changes" when the
cellar and tasting record are unchanged (the snapshot date is then left alone).
"""
import argparse
import datetime
import json
import os
import re
import sys
import unicodedata
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
DATA_SOURCE = "c43965be-a956-4750-be6d-5f1e25fee445"
NOTION_VERSION = "2025-09-03"

ROLE = {"Bridge / Pre-Dinner": "Pre-Dinner"}
VERDICT = {"Yes": "buy again", "Likely": "buy again", "Conditional": "depends",
           "Situational": "depends", "TBD": "depends", "No": "not for me"}
WHITE_WORDS = re.compile(r"blanc|chardonnay|riesling|sauvignon blanc|pinot gris|grigio|white|ros[eé]|sparkling|cr[eé]mant|champagne", re.I)


# ---------------------------------------------------------------- Notion

def plain(prop):
    """Notion property -> plain Python value."""
    t = prop.get("type")
    v = prop.get(t)
    if t in ("title", "rich_text"):
        return "".join(x.get("plain_text", "") for x in v).strip() or None
    if t == "number":
        return v
    if t in ("select", "status"):
        return v["name"] if v else None
    if t == "date":
        return v["start"] if v else None
    return None


def fetch_rows(token):
    rows, cursor = [], None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        req = urllib.request.Request(
            f"https://api.notion.com/v1/data_sources/{DATA_SOURCE}/query",
            data=json.dumps(body).encode(), method="POST",
            headers={"Authorization": f"Bearer {token}", "Notion-Version": NOTION_VERSION,
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            page = json.load(r)
        for p in page["results"]:
            if p.get("in_trash") or p.get("archived"):
                continue
            row = {name: plain(prop) for name, prop in p["properties"].items()}
            row["id"] = p["id"].replace("-", "")
            rows.append(row)
        if not page.get("has_more"):
            return rows
        cursor = page["next_cursor"]


# ---------------------------------------------------------------- helpers

def ascii_words(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.findall(r"[a-z0-9]+", s)


def title_key(row):
    return " ".join(ascii_words(row.get("Wine")))


def slugify(*parts):
    return "-".join(w for p in parts for w in ascii_words(p))[:60].strip("-")


def strip_producer(producer, wine):
    """'Taplin Terra 9' with producer 'Taplin' -> 'Terra 9'."""
    if producer and wine and wine.lower().startswith(producer.lower()):
        rest = wine[len(producer):].strip(" -,")
        return rest or wine
    return wine


def clean_score(s):
    if not s or "projected" in s.lower():
        return None
    return s.strip()


def parse_window(raw):
    """'2029-2042 (peak 2032-2038) — est.' -> ('2029-2042', '2032-2038')."""
    if not raw:
        return None, None
    text = raw.replace("–", "-").replace("—", " - ")
    m = re.match(r"\s*((?:Now|\d{4})\s*-\s*\d{4})", text, re.I)
    window = re.sub(r"\s+", "", m.group(1)) if m else None
    if window and window.lower().startswith("now"):
        window = "Now" + window[3:]
    p = re.search(r"peak\s+((?:now|\d{4})\s*-\s*\d{4})", text, re.I)
    peak = re.sub(r"\s+", "", p.group(1)) if p else None
    if peak and peak.lower().startswith("now"):
        peak = "Now" + peak[3:]
    return window, peak


def on_hand(row):
    return (row.get("On Hand") or 0) > 0


BLANK = {"-", "—", "none", "n/a"}  # "-" in a Guest column means "nothing to show, on purpose"


def guest(row, col):
    """Guest text, or None. A '-' placeholder reads as None but still counts as filled in."""
    val = (row.get(col) or "").strip()
    return None if not val or val.lower() in BLANK else val


def filled(row, col):
    return bool((row.get(col) or "").strip())


def load(name, default=None):
    path = os.path.join(TOOLS, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save(name, data):
    with open(os.path.join(TOOLS, name), "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")


# ---------------------------------------------------------------- build

def build(rows, catalog):
    wines_meta = catalog["wines"]
    row_map = catalog["rows"]
    palate_meta = catalog["palate"]
    pending = {"newWines": [], "needsGuestNote": []}

    # 1. Give every row its slug (if it belongs to a site wine) and vintage key.
    title_to_slug = {}
    for row in rows:
        m = row_map.get(row["id"])
        if m:
            title_to_slug.setdefault((title_key(row), (row.get("Producer") or "").lower()), m["slug"])
    for row in rows:
        m = row_map.get(row["id"])
        if m:
            row["_slug"], row["_vintage"] = m["slug"], m.get("vintage") or row.get("Vintage") or "NV"
            continue
        row["_vintage"] = row.get("Vintage") or "NV"
        row["_slug"] = title_to_slug.get((title_key(row), (row.get("Producer") or "").lower()))
        if row["_slug"] is None and on_hand(row):
            # A wine the site has never seen: give it a provisional entry so it
            # shows up right away, and record the row so later runs reuse it.
            base = slugify(row.get("Producer"), strip_producer(row.get("Producer"), row.get("Wine")))
            slug, n = base, 2
            while slug in wines_meta:
                slug, n = f"{base}-{n}", n + 1
            producer = row.get("Producer") or ""
            name = strip_producer(producer, row.get("Wine"))
            wines_meta[slug] = {
                "producer": producer, "name": name,
                "short": producer.split()[0] if producer else name,
                "region": row.get("AVA / Region") or "",
                "color": "white" if row.get("Category") == "White" or WHITE_WORDS.search(row.get("Wine") or "") else "red",
                "provisional": True,
            }
            row["_slug"] = slug
            title_to_slug[(title_key(row), (row.get("Producer") or "").lower())] = slug
        if row["_slug"]:
            row_map[row["id"]] = {"slug": row["_slug"]}
            catalog["_dirty"] = True

    for slug, meta in wines_meta.items():
        if meta.get("provisional"):
            ids = [i for i, m in row_map.items() if m["slug"] == slug]
            pending["newWines"].append({"slug": slug, "notionIds": ids,
                                        "producer": meta["producer"], "name": meta["name"]})

    # 2. Cellar: on-hand rows grouped by wine and vintage.
    cellar = {}
    for row in sorted(rows, key=lambda r: r["_vintage"]):
        if not on_hand(row):
            continue
        slug, vin = row["_slug"], row["_vintage"]
        meta = {k: v for k, v in wines_meta[slug].items() if k != "provisional"}
        w = cellar.setdefault(slug, {**meta, "vintages": {}})
        v = w["vintages"].get(vin)
        window, peak = parse_window(row.get("Drink Window"))
        if v is None:
            v = w["vintages"][vin] = {"location": None, "onHand": 0, "category": row.get("Category"),
                                     "window": window, "peak": peak}
        v["onHand"] += int(row["On Hand"])
        if row.get("Location"):
            v["location"] = ", ".join(x for x in (v["location"], row["Location"]) if x)
        for key, col in (("jakeScore", "Jake Score"), ("jakeNote", "Guest Note"), ("flag", "Guest Flag")):
            val = clean_score(row.get(col)) if key == "jakeScore" else guest(row, col)
            if val and key not in v:
                v[key] = val
    for slug, w in cellar.items():
        scored = sorted({(r["_vintage"], clean_score(r.get("Jake Score"))) for r in rows
                         if r["_slug"] == slug and clean_score(r.get("Jake Score"))})
        # Only useful when some vintage on hand can point at a score from another vintage.
        if any(y != v for y, _ in scored for v in w["vintages"]):
            w["otherScores"] = [{"vintage": y, "score": s} for y, s in scored]
        w["vintages"] = dict(sorted(w["vintages"].items()))
    order = [s for s in wines_meta if s in cellar]
    cellar = {s: cellar[s] for s in order}

    # 3. Tasting record: rows not on hand that have a score or a guest note.
    palate = []
    seen = set()
    ordered = sorted(rows, key=lambda r: (list(palate_meta).index(r["id"]) if r["id"] in palate_meta else 10**6, r.get("Wine") or ""))
    for row in ordered:
        if on_hand(row):
            continue
        score = clean_score(row.get("Jake Score"))
        take = guest(row, "Guest Note")
        if not score and not take and row["id"] not in palate_meta:
            continue
        meta = palate_meta.get(row["id"])
        if meta is None:
            # A cellar wine that's been drunk keeps its curated cellar name.
            site = wines_meta.get(row["_slug"]) if row["_slug"] else None
            meta = {k: site[k] for k in ("producer", "name", "region")} if site else {}
        producer = meta.get("producer") or row.get("Producer") or ""
        status = row.get("Status")
        on_list = status == "Acquisition Candidate"
        entry = {
            "producer": producer,
            "name": meta.get("name") or strip_producer(producer, row.get("Wine")),
            "vintage": meta["vintage"] if "vintage" in meta else (row.get("Vintage") or None),
            "region": meta.get("region") or row.get("AVA / Region"),
            "role": ROLE.get(row.get("Category"), row.get("Category")),
            "score": meta["score"] if "score" in meta else score,
            "tried": meta["tried"] if "tried" in meta else bool(score) or not on_list,
            "onList": on_list,
            "verdict": "not for me" if status == "Eliminated" else VERDICT.get(row.get("Repeat Buy")),
            "take": take,
        }
        if guest(row, "Guest Pairing"):
            entry["pairing"] = guest(row, "Guest Pairing")
        key = (entry["producer"], entry["name"], entry["vintage"])
        if key in seen:
            continue
        seen.add(key)
        palate.append(entry)
        if score and not filled(row, "Guest Note"):
            pending["needsGuestNote"].append({"notionId": row["id"], "wine": row.get("Wine"), "vintage": row.get("Vintage")})

    # Cellar rows that were tasted but have no guest note yet.
    for row in rows:
        if on_hand(row) and clean_score(row.get("Jake Score")) and not filled(row, "Guest Note"):
            pending["needsGuestNote"].append({"notionId": row["id"], "wine": row.get("Wine"), "vintage": row.get("Vintage")})
    return cellar, palate, pending


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", help="read rows from a JSON dump instead of the Notion API")
    ap.add_argument("--dump", help="also save the fetched rows to this path")
    args = ap.parse_args()

    if args.rows:
        with open(args.rows, encoding="utf-8") as f:
            rows = json.load(f)
    else:
        token = os.environ.get("NOTION_TOKEN")
        if not token:
            sys.exit("NOTION_TOKEN is not set")
        rows = fetch_rows(token)
    if args.dump:
        with open(args.dump, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=0)
    if len(rows) < 20:
        sys.exit(f"only {len(rows)} rows came back from Notion; refusing to overwrite the site data")

    catalog = load("catalog.json")
    cellar, palate, pending = build(rows, catalog)

    old_cellar = load("cellar.json", {})
    old_palate = load("palate.json", {})
    changed = (old_cellar.get("wines") != cellar) or (old_palate.get("wines") != palate)
    today = datetime.date.today().isoformat()
    snapshot = today if changed else old_cellar.get("snapshotDate", today)

    save("cellar.json", {"_about": old_cellar.get("_about"), "snapshotDate": snapshot, "wines": cellar})
    save("palate.json", {"_about": old_palate.get("_about"), "scaleNote": old_palate.get("scaleNote"),
                         "profile": old_palate.get("profile"), "wines": palate})
    save("pending.json", pending)
    if catalog.pop("_dirty", False):
        # newly linked rows and provisional wines, so later runs reuse the same slugs
        save("catalog.json", catalog)

    bottles = sum(v["onHand"] for w in cellar.values() for v in w["vintages"].values())
    print(f"{len(rows)} Notion rows -> {len(cellar)} wines, {bottles} bottles; {len(palate)} in the tasting record")
    print(f"pending: {len(pending['newWines'])} new wines, {len(pending['needsGuestNote'])} rows need a Guest Note")
    print("changed" if changed else "no changes")


if __name__ == "__main__":
    main()
