# 2× renders → 1024×1024 RGB PNGs, manifest.json, and compare-sheet.jpg: the six at full size in one row, the six
# at 120 px in one row, then the store they sit next to (8 iPhone screenshots, the header and search banners).
import hashlib, json, os, sys
from PIL import Image, ImageDraw, ImageFont
V = sys.argv[1]
REPO = os.path.expanduser("~/ContextFlow-work/store-pages/store-arc")
BAN = os.path.expanduser("~/ContextFlow-work/store-pages/banners261/out/main/en-US")
ITEMS = [("com.contextflow.pro.monthly", "pro-monthly"), ("com.contextflow.pro.yearly", "pro-yearly"),
         ("com.contextflow.ultra.monthly", "ultra-monthly"), ("com.contextflow.ultra.yearly", "ultra-yearly"),
         ("com.contextflow.byok.monthly", "byok-monthly"), ("com.contextflow.byok.yearly", "byok-yearly")]
man, ims = [], []
for pid, name in ITEMS:
    src = f"{V}/raw/{name}@2x.png"
    if not os.path.exists(src): continue
    im = Image.open(src).convert("RGB").resize((1024, 1024), Image.LANCZOS)
    out = f"{V}/{name}.png"; im.save(out, optimize=True)
    data = open(out, "rb").read()
    man.append({"productId": pid, "file": f"{name}.png", "size": len(data), "md5": hashlib.md5(data).hexdigest()})
    ims.append((name, im))
assert len({m["md5"] for m in man}) == len(man)
json.dump({"images": man, "pixels": "1024x1024", "mode": "RGB", "text": "English, only the UI's own labels and the plan pill"}, open(f"{V}/manifest.json", "w"), indent=1)
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 34)
g = 24; lab = 56
shots = [Image.open(f"{REPO}/store/screenshots/en-US/iphone/{f}").convert("RGB") for f in sorted(os.listdir(f"{REPO}/store/screenshots/en-US/iphone")) if f.endswith(".png")][:8]
shots = [s.resize((int(s.width * 1024 / s.height), 1024), Image.LANCZOS) for s in shots]
hd = Image.open(f"{BAN}/header.png").convert("RGB"); sr = Image.open(f"{BAN}/search.png").convert("RGB")
hd = hd.resize((int(hd.width * 1024 / hd.height), 1024), Image.LANCZOS); sr = sr.resize((int(sr.width * 1024 / sr.height), 1024), Image.LANCZOS)
W = max(g + len(ims) * (1024 + g), g + sum(s.width + g for s in shots), g + hd.width + g + sr.width + g)
H = lab + 1024 + lab + 120 + lab + 1024 + lab + 1024 + g
sheet = Image.new("RGB", (W, H), (246, 247, 250)); d = ImageDraw.Draw(sheet)
y = 10
d.text((g, y), "In-app purchase promo images v2 (1024×1024): Pro month · Pro year · Ultra month · Ultra year · Own key month · Own key year", fill=(15, 23, 42), font=font); y += lab - 10
for i, (n, im) in enumerate(ims): sheet.paste(im, (g + i * (1024 + g), y))
y += 1024 + 10; d.text((g, y), "The same at 120 px (how the App Store mostly shows them)", fill=(15, 23, 42), font=font); y += lab - 10
for i, (n, im) in enumerate(ims): sheet.paste(im.resize((120, 120), Image.LANCZOS), (g + i * (120 + g), y))
y += 120 + 10; d.text((g, y), "The store today: iPhone screenshots 1–8", fill=(15, 23, 42), font=font); y += lab - 10
x = g
for s in shots: sheet.paste(s, (x, y)); x += s.width + g
y += 1024 + 10; d.text((g, y), "Header and search banners (main page)", fill=(15, 23, 42), font=font); y += lab - 10
sheet.paste(hd, (g, y)); sheet.paste(sr, (g + hd.width + g, y))
sheet.save(f"{V}/compare-sheet.jpg", quality=84)
small = sheet.resize((W // 4, H // 4), Image.LANCZOS); small.save(f"{V}/.compare-small.jpg", quality=85)
for m in man: print(m["productId"], m["file"], m["md5"])
print("sheet", sheet.size, os.path.getsize(f"{V}/compare-sheet.jpg") // 1000, "KB")
