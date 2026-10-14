# Recreates the app icons in ../icons (football on the app's dark background).
# Usage (from the NFLPredictor folder): python3 tools/make_icons.py   (needs Pillow: pip3 install pillow)
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
os.makedirs(OUT, exist_ok=True)

def icon(size, maskable=False):
    S = size * 4  # draw large, then downscale for smooth edges
    if maskable:  # maskable icons must fill the whole square
        img = Image.new('RGBA', (S, S), (11, 18, 32, 255))
    else:
        img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(img).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=(11, 18, 32, 255))
    ball = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    b = ImageDraw.Draw(ball)
    cx, cy, w, h = S / 2, S / 2, S * 0.62, S * 0.36
    b.ellipse([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], fill=(150, 75, 30, 255), outline=(255, 255, 255, 255), width=int(S * 0.012))
    for dx in (-0.21, 0.21):
        x = cx + dx * S
        b.line([x, cy - h * 0.40, x, cy + h * 0.40], fill=(255, 255, 255, 255), width=int(S * 0.02))
    b.line([cx - S * 0.10, cy, cx + S * 0.10, cy], fill=(255, 255, 255, 255), width=int(S * 0.022))
    for i in range(-2, 3):
        x = cx + i * S * 0.045
        b.line([x, cy - S * 0.035, x, cy + S * 0.035], fill=(255, 255, 255, 255), width=int(S * 0.018))
    img.alpha_composite(ball.rotate(35, resample=Image.BICUBIC, center=(cx, cy)))
    ImageDraw.Draw(img).rounded_rectangle([S * 0.30, S * 0.78, S * 0.70, S * 0.82], radius=int(S * 0.02), fill=(59, 130, 246, 255))
    return img.resize((size, size), Image.LANCZOS)

icon(192).save(os.path.join(OUT, 'icon-192.png'))
icon(512).save(os.path.join(OUT, 'icon-512.png'))
icon(512, maskable=True).save(os.path.join(OUT, 'icon-maskable-512.png'))
icon(180, maskable=True).convert('RGB').save(os.path.join(OUT, 'apple-touch-icon.png'))
print('icons written to', os.path.normpath(OUT))
