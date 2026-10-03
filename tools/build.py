"""Build wines.json for the site.

Inputs:
  tools/cellar.json        guest-safe snapshot of the Notion Wine Library
  research/group-*.json    web research: bottle photos, published tasting notes
Output:
  wines.json               one entry per wine + vintage, read by assets/app.js

Images in images/ are normalized to web-friendly WebP (max 720px tall) in
images/web/ so the page stays light on a phone.

Each vintage's `location` (Notion's Location field, e.g. "B4, B5" or "UP, C4")
becomes a `locations` list, and wines.json gets a `rack` index of slot to wine
for the rack map. Rack problems print as warnings; they never stop the build.
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EM_DASH = "—"
EN_DASH = "–"
RACK_COLS = 9
SLOT = re.compile(r"^[A-Z][1-9]$")
SPOTS = {"UP": "upstairs", "FR": "fridge"}


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def clean(text):
    if not text:
        return text
    # House rule: no em dashes anywhere on the site.
    return text.replace(EM_DASH, ", ").replace(EN_DASH, "-").replace(" ,", ",").strip()


def web_image(src):
    """Return a normalized WebP path for an image, or the original if PIL is missing."""
    if not src:
        return None
    full = os.path.join(ROOT, src)
    if not os.path.exists(full):
        print(f"  ! missing image file {src}")
        return None
    try:
        from PIL import Image
    except ImportError:
        return src
    out_rel = "images/web/" + os.path.splitext(os.path.basename(src))[0] + ".webp"
    out = os.path.join(ROOT, out_rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    from PIL import ImageChops
    im = Image.open(full)
    im = im.convert("RGBA") if im.mode in ("P", "LA", "RGBA") else im.convert("RGB")
    # Trim empty margins (transparent or near-white) so the bottle fills the frame.
    if im.mode == "RGBA":
        box = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    else:
        diff = ImageChops.difference(im, Image.new("RGB", im.size, (255, 255, 255))).convert("L")
        box = diff.point(lambda p: 255 if p > 18 else 0).getbbox()
    if box:
        pad = round(0.03 * (box[3] - box[1]))
        im = im.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                      min(im.width, box[2] + pad), min(im.height, box[3] + pad)))
    if im.height > 720:
        im = im.resize((round(im.width * 720 / im.height), 720), Image.LANCZOS)
    im.save(out, "WEBP", quality=84)
    return out_rel


def parse_location(raw, label, warnings):
    """'b4, B5 ,up' -> ['B4', 'B5', 'UP']. Unreadable tokens are dropped with a warning."""
    tokens = []
    for tok in re.split(r"[,;]", raw or ""):
        tok = re.sub(r"\s+", "", tok).upper()
        if not tok:
            continue
        if SLOT.match(tok) or tok in SPOTS:
            tokens.append(tok)
        else:
            warnings.append(f"{label}: can't read location '{tok}'")
    return tokens


def build_rack(entries, warnings):
    """Reverse index for the rack map, or None when no wine has a location yet."""
    slots, lists, labels = {}, {"upstairs": [], "fridge": []}, {}
    for e in entries:
        locs = e["locations"]
        label = labels[e["id"]] = f"{e['producer']} {e['name']} {e['vintage']}"
        for tok in locs:
            if SLOT.match(tok):
                if tok in slots:
                    other = slots[tok]
                    who = "listed twice" if other == e["id"] else f"also claimed by {labels[other]}"
                    warnings.append(f"slot {tok}: {label} {who}")
                    continue
                slots[tok] = e["id"]
        for code, spot in SPOTS.items():
            n = locs.count(code)
            if n:
                # A wine stored only in one spot has all its bottles there.
                lists[spot].append({"id": e["id"], "n": e["onHand"] if set(locs) == {code} else n})
        basement = [t for t in locs if SLOT.match(t)]
        if locs and len(basement) == len(locs) and len(basement) != e["onHand"]:
            warnings.append(f"{label}: {e['onHand']} on hand but {len(basement)} rack slots listed")
    if not slots and not lists["upstairs"] and not lists["fridge"]:
        return None
    top = max((s[0] for s in slots), default=None)
    return {"rows": ord(top) - ord("A") + 1 if top else 0, "cols": RACK_COLS, "slots": dict(sorted(slots.items())), **lists}


def main():
    cellar = load(os.path.join(ROOT, "tools", "cellar.json"))
    research = {}
    for path in sorted(glob.glob(os.path.join(ROOT, "research", "group-*.json"))):
        research.update(load(path))

    entries = []
    rack_warnings = []
    for slug, wine in cellar["wines"].items():
        r = research.get(slug, {})
        if not r:
            print(f"  ! no research for {slug}")
        image = web_image(r.get("image"))
        for vintage, v in wine["vintages"].items():
            web = (r.get("vintages") or {}).get(vintage)
            if web:
                web = {k: clean(val) if isinstance(val, str) else val for k, val in web.items()}
            else:
                print(f"  ! no web note for {slug} {vintage}")
            others = [o for o in wine.get("otherScores", []) if o["vintage"] != vintage]
            label = f"{wine['producer']} {wine['name']} {vintage}"
            # A stale Location on an empty row never reaches the map.
            locations = parse_location(v.get("location"), label, rack_warnings) if v["onHand"] > 0 else []
            entries.append({
                "id": f"{slug}-{vintage}".lower().replace(" ", "-").replace("(", "").replace(")", ""),
                "slug": slug,
                "producer": wine["producer"],
                "name": wine["name"],
                "short": wine.get("short") or wine["producer"].replace("Château ", "").split()[0],
                "vintage": vintage,
                "region": wine["region"],
                "color": wine.get("color", "red"),
                "tags": wine.get("tags", []),
                "category": v.get("category"),
                "onHand": v["onHand"],
                "locations": locations,
                "window": v.get("window"),
                "peak": v.get("peak"),
                "jakeScore": v.get("jakeScore"),
                "jakeNote": clean(v.get("jakeNote")),
                "flag": v.get("flag"),
                "otherScores": [] if v.get("jakeScore") else others,
                "image": image,
                "imageSource": r.get("imageSource"),
                "blend": clean((web or {}).get("blend") or r.get("blend")),
                "about": clean(r.get("about")),
                "web": web,
            })

    rack = build_rack(entries, rack_warnings)
    out = {"updated": cellar["snapshotDate"], "rack": rack, "wines": entries}
    text = json.dumps(out, ensure_ascii=False)
    if EM_DASH in text:
        sys.exit("em dash found in output")
    with open(os.path.join(ROOT, "wines.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    bottles = sum(e["onHand"] for e in entries)
    print(f"wrote wines.json: {len(entries)} wines, {bottles} bottles, "
          f"{sum(1 for e in entries if e['image'])} with photos, "
          f"{sum(1 for e in entries if e['web'])} with web notes")
    if rack:
        placed = sum(1 for e in entries if e["locations"])
        print(f"rack: {len(rack['slots'])} basement slots filled in {rack['rows']} rows, "
              f"{sum(w['n'] for w in rack['upstairs'])} upstairs, {sum(w['n'] for w in rack['fridge'])} in the fridge; "
              f"{len(entries) - placed} wines with no location")
    else:
        print("rack: no locations yet, map hidden")
    for w in rack_warnings:
        print(f"  ! rack: {w}")

    # Tasting record for the Ask Jake chat (wines Jake has logged but doesn't
    # have in the cellar). Hand-curated in tools/palate.json.
    palate = load(os.path.join(ROOT, "tools", "palate.json"))
    palate.pop("_about", None)
    palate["updated"] = cellar["snapshotDate"]
    palate["profile"] = clean(palate["profile"])
    palate["wines"] = [{k: clean(v) if isinstance(v, str) else v for k, v in w.items()} for w in palate["wines"]]
    text = json.dumps(palate, ensure_ascii=False)
    if EM_DASH in text:
        sys.exit("em dash found in palate output")
    with open(os.path.join(ROOT, "palate.json"), "w", encoding="utf-8") as f:
        json.dump(palate, f, ensure_ascii=False, indent=1)
    print(f"wrote palate.json: {len(palate['wines'])} logged wines, "
          f"{sum(1 for w in palate['wines'] if w.get('onList'))} on the buy list")


if __name__ == "__main__":
    main()
