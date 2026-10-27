#!/usr/bin/env python3
"""Tile all frame dumps of a run directory into one labelled PNG.
   .venv/bin/python tools/contact_sheet.py <rundir> [cols] [thumb_width]"""
import sys, glob, os
from PIL import Image, ImageDraw
d = sys.argv[1]; cols = int(sys.argv[2]) if len(sys.argv) > 2 else 4
tw = int(sys.argv[3]) if len(sys.argv) > 3 else 480
fs = sorted(f for f in glob.glob(os.path.join(d, 'nfsu2_*.png')))
if not fs: sys.exit('no dumps')
ims = []
for f in fs:
    im = Image.open(f).convert('RGB'); th = int(im.height * tw / im.width)
    ims.append((os.path.basename(f)[6:-4], im.resize((tw, th))))
th = max(i.height for _, i in ims) + 18
rows = (len(ims) + cols - 1) // cols
W = Image.new('RGB', (cols * tw, rows * th), (40, 40, 40)); dr = ImageDraw.Draw(W)
for k, (lab, im) in enumerate(ims):
    x, y = (k % cols) * tw, (k // cols) * th
    W.paste(im, (x, y + 18)); dr.text((x + 4, y + 3), lab, fill=(255, 255, 0))
out = os.path.join(d, 'contact.png'); W.save(out); print(out, len(ims), 'frames')
