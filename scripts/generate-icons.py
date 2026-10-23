#!/usr/bin/env python3
"""Generates every icon the project needs from design/app-icon-source-1024.png.

- iOS app icon (light / dark / tinted, 1024 px)
- macOS app icon in the standard rounded-rect grid (16…1024 px)
- Safari extension toolbar/manifest icons with a transparent background
- LargeIcon used inside the app

Run: python3 scripts/generate-icons.py
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "design" / "app-icon-source-1024.png"
APPICON = ROOT / "ContextFlow" / "Shared (App)" / "Assets.xcassets" / "AppIcon.appiconset"
LARGE = ROOT / "ContextFlow" / "Shared (App)" / "Assets.xcassets" / "LargeIcon.imageset"
EXT = ROOT / "extension" / "icons"


def bubble_on_transparent(src: Image.Image) -> Image.Image:
    """Removes the white background around the speech bubble (keeps the white sparkles inside)."""
    rgba = src.convert("RGBA")
    w, h = rgba.size
    mask = Image.new("L", (w, h), 0)
    # Pixels that are "background white": very light and unsaturated.
    px = rgba.load()
    light = Image.new("L", (w, h), 0)
    lp = light.load()
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            if min(r, g, b) > 238 and max(r, g, b) - min(r, g, b) < 14:
                lp[x, y] = 255
    # Flood-fill from the corners so only the outer white is removed.
    fill = light.copy()
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(fill, corner, 128, thresh=0)
    mp = mask.load()
    fp = fill.load()
    for y in range(h):
        for x in range(w):
            mp[x, y] = 0 if fp[x, y] == 128 else 255
    mask = mask.filter(ImageFilter.GaussianBlur(1.2))
    rgba.putalpha(mask)
    bbox = rgba.getbbox()
    cropped = rgba.crop(bbox)
    side = max(cropped.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(cropped, ((side - cropped.width) // 2, (side - cropped.height) // 2))
    return square


def padded(img: Image.Image, size: int, padding: float) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * (1 - 2 * padding))
    piece = img.resize((inner, inner), Image.LANCZOS)
    canvas.paste(piece, ((size - inner) // 2, (size - inner) // 2), piece)
    return canvas


def mac_icon(bubble: Image.Image) -> Image.Image:
    """macOS icon grid: 824 px rounded rect centred on a 1024 canvas, soft shadow."""
    size, body, radius = 1024, 824, 185
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    off = (size - body) // 2
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([off, off + 12, off + body, off + body + 12], radius, fill=(0, 0, 0, 70))
    canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(18)))
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle([off, off, off + body, off + body], radius, fill=(255, 255, 255, 255))
    canvas = Image.alpha_composite(canvas, tile)
    art = padded(bubble, body, 0.13)
    canvas.paste(art, (off, off), art)
    return canvas


def main() -> None:
    src = Image.open(SRC).convert("RGB")
    bubble = bubble_on_transparent(src)

    for old in APPICON.iterdir():
        if old.is_dir():
            for f in old.iterdir():
                f.unlink()
            old.rmdir()
        else:
            old.unlink()

    src.save(APPICON / "icon-ios-1024.png")
    dark = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    art = padded(bubble, 1024, 0.16)
    dark.paste(art, (0, 0), art)
    dark.save(APPICON / "icon-ios-dark-1024.png")
    gray = ImageOps.grayscale(art.convert("RGB"))
    tinted = Image.merge("RGBA", (gray, gray, gray, art.getchannel("A")))
    tinted.save(APPICON / "icon-ios-tinted-1024.png")

    mac = mac_icon(bubble)
    images = [
        {"filename": "icon-ios-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"},
        {"appearances": [{"appearance": "luminosity", "value": "dark"}], "filename": "icon-ios-dark-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"},
        {"appearances": [{"appearance": "luminosity", "value": "tinted"}], "filename": "icon-ios-tinted-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"},
    ]
    for pt in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            name = f"mac-icon-{pt}@{scale}x.png"
            mac.resize((pt * scale, pt * scale), Image.LANCZOS).save(APPICON / name)
            images.append({"filename": name, "idiom": "mac", "scale": f"{scale}x", "size": f"{pt}x{pt}"})
    (APPICON / "Contents.json").write_text(json.dumps({"images": images, "info": {"author": "xcode", "version": 1}}, indent=2) + "\n")

    for old in LARGE.glob("*.png"):
        old.unlink()
    padded(bubble, 512, 0.04).save(LARGE / "large-icon.png")
    (LARGE / "Contents.json").write_text(json.dumps({
        "images": [{"filename": "large-icon.png", "idiom": "universal"}],
        "info": {"author": "xcode", "version": 1}
    }, indent=2) + "\n")

    EXT.mkdir(parents=True, exist_ok=True)
    for size in (16, 19, 32, 38, 48, 64, 96, 128, 256, 512):
        padded(bubble, size, 0.02 if size <= 32 else 0.04).save(EXT / f"icon-{size}.png")
    print("icons generated")


if __name__ == "__main__":
    main()
