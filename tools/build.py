"""Build wines.json for the site.

Inputs:
  tools/cellar.json        guest-safe snapshot of the Notion Wine Library
  research/group-*.json    web research: bottle photos, published tasting notes
Output:
  wines.json               one entry per wine + vintage, read by assets/app.js

Images in images/ are normalized to web-friendly WebP (max 720px tall) in
images/web/ so the page stays light on a phone.
"""
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EM_DASH = "—"
EN_DASH = "–"


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


def main():
    cellar = load(os.path.join(ROOT, "tools", "cellar.json"))
    research = {}
    for path in sorted(glob.glob(os.path.join(ROOT, "research", "group-*.json"))):
        research.update(load(path))

    entries = []
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
            entries.append({
                "id": f"{slug}-{vintage}".lower().replace(" ", "-").replace("(", "").replace(")", ""),
                "slug": slug,
                "producer": wine["producer"],
                "name": wine["name"],
                "vintage": vintage,
                "region": wine["region"],
                "color": wine.get("color", "red"),
                "tags": wine.get("tags", []),
                "category": v.get("category"),
                "onHand": v["onHand"],
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

    out = {"updated": cellar["snapshotDate"], "wines": entries}
    with open(os.path.join(ROOT, "wines.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    text = json.dumps(out, ensure_ascii=False)
    if EM_DASH in text:
        sys.exit("em dash found in output")
    bottles = sum(e["onHand"] for e in entries)
    print(f"wrote wines.json: {len(entries)} wines, {bottles} bottles, "
          f"{sum(1 for e in entries if e['image'])} with photos, "
          f"{sum(1 for e in entries if e['web'])} with web notes")


if __name__ == "__main__":
    main()
