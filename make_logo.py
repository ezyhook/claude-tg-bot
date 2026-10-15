#!/usr/bin/env python3
# LumoSpace logo: cosmic purple background, orange ringed planet, gradient wordmark
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import random

S = 1024
random.seed(7)
ORANGE = (255, 138, 32)
ORANGE_DEEP = (232, 88, 12)
PURPLE = (109, 74, 255)
VIOLET = (168, 130, 255)

img = Image.new("RGB", (S, S), (16, 8, 38))
d = ImageDraw.Draw(img)

# --- background gradient ---
top, bot = (38, 16, 78), (10, 5, 26)
for y in range(S):
    t = y / (S - 1)
    d.line([(0, y), (S, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))

# --- nebula glow ---
glow = Image.new("L", (S, S), 0)
gd = ImageDraw.Draw(glow)
cx, cy = S // 2, int(S * 0.41)
for rad, val in ((430, 30), (340, 45), (250, 65), (170, 85)):
    gd.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=val)
glow = glow.filter(ImageFilter.GaussianBlur(80))
img = Image.composite(Image.new("RGB", (S, S), (120, 55, 210)), img, glow)

# --- stars ---
for _ in range(260):
    x, y = random.randint(0, S), random.randint(0, S)
    r = random.choice((1, 1, 1, 2, 2, 3))
    b = random.randint(120, 245)
    col = (b, b, min(255, b + 20))
    d.ellipse([x - r, y - r, x + r, y + r], fill=col)
for _ in range(7):  # bright stars with flare
    x, y = random.randint(60, S - 60), random.randint(40, int(S * 0.68))
    ln = random.randint(10, 20)
    d.line([(x - ln, y), (x + ln, y)], fill=(255, 240, 225), width=1)
    d.line([(x, y - ln), (x, y + ln)], fill=(255, 240, 225), width=1)
    d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(255, 248, 238))

# --- ring (drawn on its own layer, tilted) ---
ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rd = ImageDraw.Draw(ring)
rb = [cx - 320, cy - 96, cx + 320, cy + 96]
rd.ellipse(rb, outline=(255, 176, 76, 235), width=26)
rd.ellipse([rb[0] + 34, rb[1] + 12, rb[2] - 34, rb[3] - 12], outline=(196, 132, 255, 175), width=12)
ring = ring.rotate(-18, center=(cx, cy), resample=Image.Resampling.BICUBIC)
img.paste(ring, (0, 0), ring)

# --- planet ---
pr = 188
planet = Image.new("RGBA", (S, S), (0, 0, 0, 0))
pd = ImageDraw.Draw(planet)
pd.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=ORANGE + (255,))
shade = Image.new("L", (S, S), 0)
sd = ImageDraw.Draw(shade)
sd.ellipse([cx - pr + 86, cy - pr - 40, cx + pr + 230, cy + pr + 118], fill=150)
shade = shade.filter(ImageFilter.GaussianBlur(46))
planet = Image.composite(Image.new("RGBA", (S, S), ORANGE_DEEP + (255,)), planet, shade)
hl = Image.new("L", (S, S), 0)
hd = ImageDraw.Draw(hl)
hd.ellipse([cx - pr + 30, cy - pr + 24, cx - pr + 156, cy - pr + 108], fill=120)
hl = hl.filter(ImageFilter.GaussianBlur(30))
planet = Image.composite(Image.new("RGBA", (S, S), (255, 214, 158, 255)), planet, hl)
img.paste(planet, (0, 0), planet)

# --- front half of the ring goes over the planet ---
front = Image.new("L", (S, S), 0)
fd = ImageDraw.Draw(front)
fd.rectangle([0, cy + 6, S, S], fill=255)
alpha = ring.split()[3].point(lambda v: v)
ring.putalpha(Image.composite(alpha, Image.new("L", (S, S), 0), front))
img.paste(ring, (0, 0), ring)

# --- moon ---
mx, my, mr = int(cx + 352), int(cy - 236), 30
mg = Image.new("L", (S, S), 0)
ImageDraw.Draw(mg).ellipse([mx - mr - 26, my - mr - 26, mx + mr + 26, my + mr + 26], fill=90)
mg = mg.filter(ImageFilter.GaussianBlur(26))
img = Image.composite(Image.new("RGB", (S, S), (140, 105, 255)), img, mg)
d.ellipse([mx - mr, my - mr, mx + mr, my + mr], fill=VIOLET)
d.ellipse([mx - mr + 9, my - mr + 7, mx - mr + 27, my - mr + 25], fill=(226, 212, 255))

# --- wordmark with orange -> violet gradient ---
text = "LumoSpace"
font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
size = 152
while size > 40:
    f = ImageFont.truetype(font_path, size)
    box = d.textbbox((0, 0), text, font=f)
    if box[2] - box[0] <= 860:
        break
    size -= 4
tw, th = box[2] - box[0], box[3] - box[1]
tx, ty = (S - tw) // 2 - box[0], int(S * 0.845) - box[1]
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).text((tx, ty), text, font=f, fill=255)
grad = Image.new("RGB", (S, S))
gdr = ImageDraw.Draw(grad)
left, right = (255, 154, 51), (150, 106, 255)
for x in range(S):
    t = x / (S - 1)
    gdr.line([(x, 0), (x, S)], fill=tuple(int(left[i] + (right[i] - left[i]) * t) for i in range(3)))
shadow = mask.filter(ImageFilter.GaussianBlur(14))
img = Image.composite(Image.new("RGB", (S, S), (60, 22, 116)), img, shadow.point(lambda v: int(v * 0.85)))
img.paste(grad, (0, 0), mask)

out = "/home/user/claude-tg-bot/assets"
import os
os.makedirs(out, exist_ok=True)
img.save(f"{out}/lumospace-logo.png")
img.resize((512, 512), Image.Resampling.LANCZOS).save(f"{out}/lumospace-logo-512.png")
img.convert("RGB").resize((512, 512), Image.Resampling.LANCZOS).save(f"{out}/lumospace-logo-512.jpg", quality=94)
print("ok", f"{out}/lumospace-logo.png", img.size)
