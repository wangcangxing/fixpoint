#!/usr/bin/env python3
"""Draw Fixpoint's application icon and write a multi-size .ico.

Kept as a script so the icon is reproducible (and so the exe metadata can be set
by the packager from a real file rather than a hand-made blob).
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import sys

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "build" / "fixpoint.ico"

BG = (27, 29, 33, 255)        # same as the app background
PANEL = (34, 37, 43, 255)
ACCENT = (76, 141, 255, 255)  # same as the app accent
FG = (230, 232, 236, 255)

# Draw at 1024 and downsample: gives clean small sizes without font hinting games.
SIZE = 1024
image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

margin = int(SIZE * 0.06)
radius = int(SIZE * 0.20)
draw.rounded_rectangle([margin, margin, SIZE - margin, SIZE - margin], radius=radius, fill=BG, outline=ACCENT, width=int(SIZE * 0.02))

# A stylised "fixed point": a dot inside a bracket pair, plus the letter F.
inner = int(SIZE * 0.22)
draw.rounded_rectangle([inner, inner, SIZE - inner, SIZE - inner], radius=int(radius * 0.6), fill=PANEL)

try:
    font = ImageFont.truetype("C:/Windows/Fonts/seguisb.ttf", int(SIZE * 0.46))
except Exception:
    font = ImageFont.load_default()

text = "F"
box = draw.textbbox((0, 0), text, font=font)
draw.text(((SIZE - (box[2] - box[0])) / 2 - box[0], (SIZE - (box[3] - box[1])) / 2 - box[1] - SIZE * 0.04), text, font=font, fill=FG)

# The "point": a solid dot, so the mark reads as fix + point.
dot_r = int(SIZE * 0.055)
cx, cy = SIZE // 2, int(SIZE * 0.755)
draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=ACCENT)

OUT.parent.mkdir(parents=True, exist_ok=True)
image.save(OUT, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
