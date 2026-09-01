"""The social card: the cold open, held still.

    python tools/make_social.py

Not a logo on a background. The promise a pasted link makes should be the thing
the player actually gets, so this is the same house, the same gradient and the
same title face as index.html — the difference is that the fog is not moving.
Every number below is read off the cold open's own CSS rather than eyeballed,
so the two can be kept in step by hand when one of them changes.

Replaces tools/make_og_image.py, which drew a headstone glyph on a flat
background: correct as a logo and wrong as a promise, since nothing in the game
looks like it.

Needs Pillow to draw and fontTools to unpack the site's woff2 — there is no SVG
rasteriser on this machine (no ImageMagick, Inkscape, rsvg or Node), which is
why the house is transcribed as a polygon instead of rendered from the source
SVG. It is all straight lines, so nothing is lost.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import pathlib, tempfile

W, H = 1200, 630
OUT = pathlib.Path("assets/social.png")
OUT.parent.mkdir(parents=True, exist_ok=True)

# Pillow cannot read woff2, so the site's own font is unpacked to a temporary
# ttf. Using the shipped file rather than a system Georgia matters: the card and
# the page have to be the same letterforms.
def title_font_path():
    from fontTools.ttLib import TTFont

    f = TTFont("assets/fonts/imfellenglish-latin.woff2")
    f.flavor = None
    tmp = pathlib.Path(tempfile.gettempdir()) / "imfellenglish-social.ttf"
    f.save(tmp)
    return str(tmp)


FONT = title_font_path()

# ---- the ground ------------------------------------------------------------
# linear-gradient(180deg, #0a0b0d 0%, #0c0d10 46%, #14161b 100%), read off the
# cold open's own rule so the two cannot drift apart.
STOPS = [(0.0, (10, 11, 13)), (0.46, (12, 13, 16)), (1.0, (20, 22, 27))]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


img = Image.new("RGB", (W, H))
d = ImageDraw.Draw(img)
for y in range(H):
    t = y / (H - 1)
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t0 <= t <= t1:
            d.line([(0, y), (W, y)], fill=lerp(c0, c1, (t - t0) / (t1 - t0)))
            break

# ---- the two glows ---------------------------------------------------------
# Radial gradients, additively: moonlight on the horizon for the roof to cut
# into, and the warm spill out of the open door.
def glow(size, cx, cy, rx, ry, colour, alpha, falloff=1.0):
    """One radial-gradient layer, painted at quarter scale and blurred back up —
    the smooth ramp costs nothing that way and looks the same."""
    s = 4
    layer = Image.new("L", (size[0] // s, size[1] // s), 0)
    ld = ImageDraw.Draw(layer)
    steps = 42
    for i in range(steps, 0, -1):
        f = i / steps
        v = int(alpha * 255 * ((1 - f) ** falloff))
        ld.ellipse(
            [(cx - rx * f) / s, (cy - ry * f) / s, (cx + rx * f) / s, (cy + ry * f) / s],
            fill=v,
        )
    layer = layer.resize(size, Image.BICUBIC).filter(ImageFilter.GaussianBlur(18))
    tint = Image.new("RGB", size, colour)
    return tint, layer


for cx, cy, rx, ry, colour, alpha in [
    (W * 0.5, H * 1.00, W * 0.75, H * 0.62, (96, 108, 132), 0.30),
    (W * 0.5, H * 1.08, W * 0.60, H * 0.80, (232, 176, 112), 0.13),
]:
    tint, mask = glow((W, H), cx, cy, rx, ry, colour, alpha)
    img.paste(tint, (0, 0), mask)

# ---- the fog ---------------------------------------------------------------
# Two banks, at the heights the cold open puts them, caught mid-drift.
for cx, cy, rx, ry, alpha in [
    (W * 0.30, H * 1.04, W * 0.36, H * 0.34, 0.11),
    (W * 0.72, H * 1.04, W * 0.30, H * 0.31, 0.09),
    (W * 0.60, H * 0.80, W * 0.33, H * 0.22, 0.07),
]:
    tint, mask = glow((W, H), cx, cy, rx, ry, (150, 152, 160), alpha, falloff=1.6)
    img.paste(tint, (0, 0), mask)

# ---- the house -------------------------------------------------------------
# The silhouette from index.html, transcribed. It is all straight lines, so the
# path is a polygon and needs no curve support:
#   M0 180 V126 l38-26 v-18 l16-11 16 11 v10 l50-34 62 42 v-18 l14-9 14 9 v28
#   l52 35 v55 z   (on a 320x180 viewBox)
def house_points():
    pts = []
    x, y = 0.0, 180.0
    pts.append((x, y))

    def V(ny):
        nonlocal y
        y = ny
        pts.append((x, y))

    def l(dx, dy):
        nonlocal x, y
        x += dx
        y += dy
        pts.append((x, y))

    def v(dy):
        nonlocal y
        y += dy
        pts.append((x, y))

    V(126); l(38, -26); v(-18); l(16, -11); l(16, 11); v(10); l(50, -34)
    l(62, 42); v(-18); l(14, -9); l(14, 9); v(28); l(52, 35); v(55)
    return pts


# The page's own box, worked out for a 1200x630 window rather than guessed at.
# .titlehouse is width min(1100px, 168vw) by height min(58vh, 420px), sitting on
# the bottom edge — so at this size it is a 1100x365 window onto the art. Then
# preserveAspectRatio="xMidYMax slice" fills that window by the larger scale and
# anchors the drawing to its bottom, which crops the roofline rather than
# letterboxing it.
#
# Getting this wrong is what the first attempt did — scaling to the whole frame
# made the house loom over the title and pushed the door off the bottom edge.
# The cold open shows a smaller house under a lot of sky, and so should this.
VB_W, VB_H = 320, 180
BOX_W, BOX_H = min(1100, round(W * 1.68)), min(round(H * 0.58), 420)
scale = max(BOX_W / VB_W, BOX_H / VB_H)
art_w, art_h = round(VB_W * scale), round(VB_H * scale)

art = Image.new("RGBA", (art_w, art_h), (0, 0, 0, 0))
ad = ImageDraw.Draw(art)
ad.polygon([(px * scale, py * scale) for px, py in house_points()], fill=(8, 10, 12, 245))


# The lit windows and the open door, in the same places.
def box(x, y, w, h, colour):
    ad.rectangle(
        [x * scale, y * scale, (x + w) * scale, (y + h) * scale], fill=colour + (245,)
    )


box(104, 120, 20, 26, (58, 42, 18))
box(196, 126, 18, 24, (42, 30, 13))
box(148, 146, 24, 34, (18, 12, 6))
box(152, 150, 7, 30, (74, 53, 23))

# xMid, YMax: centred sideways, bottom-aligned, and clipped to the box.
crop = art.crop((max(0, (art_w - BOX_W) // 2), art_h - BOX_H,
                 max(0, (art_w - BOX_W) // 2) + BOX_W, art_h))
img.paste(crop, ((W - BOX_W) // 2, H - BOX_H), crop)

# ---- the words -------------------------------------------------------------
title = ImageFont.truetype(FONT, 108)
sub = ImageFont.truetype(FONT, 40)

TEXT = (240, 238, 232)
MUTED = (154, 160, 170)


def centred(text, font, y, fill):
    w = d.textbbox((0, 0), text, font=font)[2]
    d.text(((W - w) / 2, y), text, font=font, fill=fill)


# High in the frame: the house needs the bottom two thirds, and a crawler's
# thumbnail crops from the edges.
centred("Zombie in My Pocket", title, 96, TEXT)
centred("Find the relic. Bury it before midnight.", sub, 232, MUTED)

img.save(OUT, optimize=True)
print(f"{OUT}  {OUT.stat().st_size:,} bytes  {img.size}")
