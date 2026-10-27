#!/usr/bin/env python3
"""Build the app icon (.icns) from SPEED2.EXE's own icon resource.

The exe carries one icon group, IDI_ICON1, with a single 32x32 24-bit image
(the grey NFS logo; the NFSU_icon.ico next to it is the same picture).  It
is enlarged in nearest-neighbour steps, so it stays crisp pixel art instead
of a blur, cut to the macOS icon shape (an 824 px rounded tile on the 1024
grid, with a soft shadow) and written in every size iconutil wants.  For
personal use: the artwork is EA's.

Usage:  tools/exeicon.py <SPEED2.EXE> <out.icns> [<preview.png>]
"""
import io, os, struct, subprocess, sys, tempfile
import pefile
from PIL import Image, ImageDraw, ImageFilter

RT_ICON, RT_GROUP_ICON = 3, 14
CANVAS, TILE, RADIUS = 1024, 824, 185          # Big Sur+ icon grid


def exe_icons(path):
    """All images of the exe's first icon group, as (w, h, bpp, bytes)."""
    pe = pefile.PE(path, fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']])
    icons, group = {}, None
    for t in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        for e in t.directory.entries:
            for lang in e.directory.entries:
                d = lang.data.struct
                raw = pe.get_data(d.OffsetToData, d.Size)
                if t.id == RT_ICON:
                    icons[e.id] = raw
                elif t.id == RT_GROUP_ICON and group is None:
                    group = raw
    if group is None:
        sys.exit("exeicon: no icon group in %s" % path)
    _, _, count = struct.unpack_from('<HHH', group)
    out = []
    for i in range(count):
        w, h, _, _, _, bpp, size, iid = struct.unpack_from('<BBBBHHIH', group, 6 + 14 * i)
        if iid in icons:
            out.append((w or 256, h or 256, bpp, icons[iid]))
    return out


def decode(w, h, bpp, raw):
    """One RT_ICON image (PNG or BMP DIB with AND mask) -> RGBA."""
    if raw[:8] == b'\x89PNG\r\n\x1a\n':
        return Image.open(io.BytesIO(raw)).convert('RGBA')
    # Wrap the DIB in a one-image .ico and let Pillow apply the AND mask.
    ico = struct.pack('<HHH', 0, 1, 1) + struct.pack('<BBBBHHII', w & 255, h & 255, 0, 0, 1, bpp,
                                                    len(raw), 22) + raw
    im = Image.open(io.BytesIO(ico))
    im.size = (w, h)
    return im.convert('RGBA')


def master(art):
    """The 1024x1024 icon: art enlarged to the tile, rounded, with a shadow."""
    k = -(-TILE // art.width)                      # integer factor >= tile
    big = art.resize((art.width * k, art.height * k), Image.NEAREST)
    tile = big.resize((TILE, TILE), Image.LANCZOS)
    mask = Image.new('L', (TILE * 4, TILE * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, TILE * 4 - 1, TILE * 4 - 1], radius=RADIUS * 4, fill=255)
    mask = mask.resize((TILE, TILE), Image.LANCZOS)
    tile.putalpha(Image.composite(tile.getchannel('A'), Image.new('L', tile.size, 0), mask))

    off = (CANVAS - TILE) // 2
    shadow = Image.new('L', (CANVAS, CANVAS), 0)
    shadow.paste(mask.point(lambda v: v * 0.45), (off, off + 12))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    img = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    img.putalpha(shadow)
    img.alpha_composite(tile, (off, off))
    return img


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    exe, out = sys.argv[1], sys.argv[2]
    imgs = exe_icons(exe)
    w, h, bpp, raw = max(imgs, key=lambda t: (t[0] * t[1], t[2]))
    art = decode(w, h, bpp, raw)
    img = master(art)
    if len(sys.argv) > 3:
        img.save(sys.argv[3])
    with tempfile.TemporaryDirectory() as td:
        iconset = os.path.join(td, 'AppIcon.iconset')
        os.mkdir(iconset)
        for px in (16, 32, 128, 256, 512):
            img.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, 'icon_%dx%d.png' % (px, px)))
            img.resize((px * 2, px * 2), Image.LANCZOS).save(os.path.join(iconset, 'icon_%dx%d@2x.png' % (px, px)))
        subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', out], check=True)
    print('icon: %s (from %s: %dx%d, %d-bit, IDI_ICON1)' % (out, os.path.basename(exe), w, h, bpp))


if __name__ == '__main__':
    main()
