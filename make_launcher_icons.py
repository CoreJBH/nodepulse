#!/usr/bin/env python3
"""Generate the Android launcher icons from assets/icon-512.png.

Produces, for every density bucket:
  res/mipmap-<bucket>/ic_launcher.png        legacy icon (rounded square)
  res/mipmap-<bucket>/ic_launcher_round.png  legacy round icon (circle)
  res/drawable-<bucket>/ic_launcher_foreground.png
                                             adaptive-icon foreground (72/108 safe zone)

The adaptive icon itself lives in res/mipmap-anydpi-v26 and uses the colour
resource `ic_launcher_background`.

Run: python3 make_launcher_icons.py
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'assets', 'icon-512.png')
RES = os.path.join(HERE, 'android', 'app', 'src', 'main', 'res')

# density bucket -> legacy icon size in px (48dp), adaptive foreground size (108dp)
BUCKETS = {
    'mdpi': (48, 108),
    'hdpi': (72, 162),
    'xhdpi': (96, 216),
    'xxhdpi': (144, 324),
    'xxxhdpi': (192, 432),
}

CORNER_RATIO = 246.0 / 1254.0   # rounded-square radius of the source icon


def mask(size, radius_ratio, ss=4):
    m = Image.new('L', (size * ss, size * ss), 0)
    d = ImageDraw.Draw(m)
    if radius_ratio >= 0.5:
        d.ellipse([0, 0, size * ss - 1, size * ss - 1], fill=255)
    else:
        d.rounded_rectangle([0, 0, size * ss - 1, size * ss - 1],
                            radius=radius_ratio * size * ss, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def main():
    src = Image.open(SRC).convert('RGBA')
    for bucket, (legacy, fg) in BUCKETS.items():
        mip = os.path.join(RES, 'mipmap-%s' % bucket)
        drw = os.path.join(RES, 'drawable-%s' % bucket)
        os.makedirs(mip, exist_ok=True)
        os.makedirs(drw, exist_ok=True)

        base = src.resize((legacy, legacy), Image.LANCZOS)
        square = base.copy()
        square.putalpha(mask(legacy, CORNER_RATIO))
        square.save(os.path.join(mip, 'ic_launcher.png'), optimize=True)

        round_icon = base.copy()
        round_icon.putalpha(mask(legacy, 0.5))
        round_icon.save(os.path.join(mip, 'ic_launcher_round.png'), optimize=True)

        inner = round(fg * 72 / 108)
        fg_img = Image.new('RGBA', (fg, fg), (0, 0, 0, 0))
        art = src.resize((inner, inner), Image.LANCZOS)
        off = (fg - inner) // 2
        fg_img.paste(art, (off, off), art)
        fg_img.save(os.path.join(drw, 'ic_launcher_foreground.png'), optimize=True)

        print('%s: launcher %dpx, foreground %dpx' % (bucket, legacy, fg))


if __name__ == '__main__':
    main()
