# Extension icons (16 / 48 / 128 px) + the site favicon: the site's blue rounded square with a white
# "advance line" chart mark — three rising bars and the cut line. No DraftKings marks or colours.
#   python scripts/make-icons.py
from PIL import Image, ImageDraw
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLUE, WHITE = (57, 135, 229, 255), (255, 255, 255, 255)

def icon(size):
    s = size * 8  # draw large, scale down for clean edges
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BLUE)
    pad, gap = s * 0.2, s * 0.06
    w = (s - 2 * pad - 2 * gap) / 3
    for i, h in enumerate([0.30, 0.48, 0.68]):
        x0 = pad + i * (w + gap)
        d.rounded_rectangle([x0, s - pad - h * (s - 2 * pad), x0 + w, s - pad], radius=int(s * 0.03), fill=WHITE)
    y = s - pad - 0.84 * (s - 2 * pad)
    d.rectangle([pad, y, s - pad, y + max(2, s * 0.05)], fill=WHITE)  # the cut line
    return im.resize((size, size), Image.LANCZOS)

os.makedirs(os.path.join(ROOT, "extension", "icons"), exist_ok=True)
for n in (16, 48, 128):
    icon(n).save(os.path.join(ROOT, "extension", "icons", f"icon{n}.png"))
icon(64).save(os.path.join(ROOT, "public", "favicon.png"))
icon(512).save(os.path.join(ROOT, "public", "icon-512.png"))
print("icons written")
