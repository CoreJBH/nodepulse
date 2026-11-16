#!/usr/bin/env python3
"""Generate the web app icons from the master artwork.

Source: assets/icon-master.png (square, full-bleed).
Output: assets/icon-64.png (tab), icon-180.png (Apple touch), icon-192.png (PWA/README),
        icon-512.png (store / source for the Android launcher icons)

Corners are cut to a rounded square with a transparent surround so the icon sits cleanly on
any background; the radius matches the master artwork's own corner treatment.

Run: python3 make_icons.py [source.png]
"""
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, 'assets')
DEFAULT_SRC = os.path.join(ASSETS, 'icon-master.png')

SIZES = (512, 192, 180, 64)
CORNER_RATIO = 246.0 / 1254.0   # rounded-square radius of the master artwork


def rounded_mask(size, ss=4):
    m = Image.new('L', (size * ss, size * ss), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size * ss - 1, size * ss - 1],
                        radius=CORNER_RATIO * size * ss, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def main():
    src_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    src = Image.open(src_path).convert('RGB')
    if src.width != src.height:
        side = min(src.size)
        off = ((src.width - side) // 2, (src.height - side) // 2)
        src = src.crop((off[0], off[1], off[0] + side, off[1] + side))

    for size in SIZES:
        im = src.resize((size, size), Image.LANCZOS).convert('RGBA')
        im.putalpha(rounded_mask(size))
        out = os.path.join(ASSETS, 'icon-%d.png' % size)
        im.save(out, optimize=True)
        print('%s  %dx%d  %d bytes' % (os.path.relpath(out, HERE), size, size, os.path.getsize(out)))


if __name__ == '__main__':
    main()
