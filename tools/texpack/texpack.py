#!/usr/bin/env python3
"""NFSU2 texture pack builder -- makes an upscaled texture pack for the
port's optional "textures = upscaled" setting from YOUR OWN game files
(runtime/texrep.m).  Nothing leaves this Mac and no game asset
is part of the port: the pack is built locally, once.

    tools/texpack/setup.sh                      # once: venv + model (see there)
    tools/texpack/build.sh [options]            # = texpack.py build [options]

    texpack.py build  [--game DIR] [--dump DIR ...] [--name NAME | --out DIR]
                      [--scale auto|2|4] [--model span|dat2] [--parts LIST]
                      [--jobs N] [--limit N] [--force]
    texpack.py scan   [--game DIR]              census of the game's textures
    texpack.py info   [--name NAME | --out DIR] what a pack holds
    texpack.py fetch-model [span|dat2]          download + verify a model

What it does, per texture:
  1. finds every texture pack (TPK) in the game's uncompressed bundles and
     reads level 0 exactly as the game uploads it (P8 textures expanded with
     their palette, as the game does), plus the textures the port dumped
     while you played (texture_dump = on: compressed front-end and car
     bundles the scan cannot read);
  2. upscales the colour 4x with a game-texture model (PBRify SPAN v4 by
     default, CC0), with wrap padding for tiling textures and mirror padding
     for the others;
  3. keeps the original's colour (chroma lock: the model's brightness detail,
     the original's hue) and the original's alpha, magnified bilinearly:
     in this game alpha is data (reflection weights, shine masks, cut-outs),
     not picture;
  3b. back-projects: the result is corrected until its 4x4 averages are the
     original's texels again (apart from the texel-sized checkerboard), so
     the model can add detail but not repaint (it took the carbon-fibre
     weave for noise and erased it) and the pack's levels agree with the
     game's own level underneath;
  4. writes only the levels ABOVE the original size (4x pack: 4x and 2x;
     2x pack: 2x) in the original's own block format (DXT1 -> BC1, DXT3 ->
     BC2, DXT5 -> BC3, A8R8G8B8 -> 32-bit).  The port puts the game's own
     levels underneath, so wherever the game drew a texture at or below its
     own size the picture is the original.
Skipped: 32x32 texels or less (ramps, lookup tables), single-colour
textures, smooth textures (skies, glows, light panels: nothing to recover,
the model would add grain), the cars' 32-bit skin and vinyl layers (inputs
of the paint composite), animated flipbooks (ANM_*: frames upscaled one by
one flicker), cube maps, other formats.  The largest level is at
most 2048 texels wide (1024-texel textures get 2x, larger ones nothing).

Output: <pack>/<part>/<NAME>_<w>x<h>_<hash>.dds, manifest.csv, pack.ini.
<hash> = XXH3-64 of level 0 seeded with w | h << 16 | D3DFORMAT << 32,
the value runtime/texrep.m computes at upload.  A build can be stopped and
restarted: finished textures are kept.  Delete a file to drop one texture;
delete a part folder (or leave it out of texture_parts) to drop a part.
"""
import argparse, csv, hashlib, io, os, re, struct, sys, time, urllib.request
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from PIL import Image

PACK_FORMAT = 1
TOOL_VERSION = '1.0'
FMT = {'DXT1': 0x31545844, 'DXT3': 0x33545844, 'DXT5': 0x35545844, 'A8R8G8B8': 21}
PARTS = ['world', 'signs', 'cars', 'garage', 'sky', 'effects', 'frontend', 'hud', 'other']

# Model weights: permissively licensed, fetched from the author's own
# repository and verified by SHA-256 (setup.sh / fetch-model).
MODELS = {
    'span': dict(
        file='4x-PBRify_UpscalerSPANV4.pth', size=9016813,
        sha256='d1f1fa1af7a5ab23fcf143e75aac4951e6c52d56bf77d9ccd4d004a4831d0461',
        url='https://raw.githubusercontent.com/Kim2091/PBRify_Remix/'
            '67acc20b8fe44bf09530032b01f81859d532dc74/Extras/Old_Models/4x-PBRify_UpscalerSPANV4.pth',
        licence='CC0-1.0 (github.com/Kim2091/PBRify_Remix)',
        about='PBRify Upscaler SPAN v4: game textures, fast (the whole game in minutes)'),
    'dat2': dict(
        file='4x-PBRify_UpscalerV4.safetensors', size=139793020,
        sha256='a00fa50116895a9b766aeb012edad0a14d66f3afda65539efc0f6fc28c991ba2',
        url='https://github.com/Kim2091/Kim2091-Models/releases/download/'
            '4x-PBRify_UpscalerV4/4x-PBRify_UpscalerV4.safetensors',
        licence='CC0-1.0 (github.com/Kim2091/Kim2091-Models release notes)',
        about='PBRify Upscaler V4 (DAT2): cleanest result, about 30x slower (hours)'),
}


def support_dir():
    s = os.environ.get('NFSU2_APPSUPPORT')
    return s if s else os.path.expanduser('~/Library/Application Support/NFSU2')


def home_dir():
    return os.environ.get('NFSU2_TEXPACK_HOME') or os.path.join(support_dir(), 'texpack')


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------
def fetch_model(key):
    m = MODELS[key]
    d = os.path.join(home_dir(), 'models')
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, m['file'])
    if os.path.exists(p) and sha256_file(p) == m['sha256']:
        log(f"model {key}: {p} (verified)")
        return p
    log(f"model {key}: downloading {m['url']} ({m['size'] / 1e6:.0f} MB, {m['licence']})")
    tmp = p + '.part'
    with urllib.request.urlopen(m['url']) as r, open(tmp, 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    h = sha256_file(tmp)
    if h != m['sha256']:
        os.unlink(tmp)
        sys.exit(f"model {key}: SHA-256 mismatch ({h}), file removed -- not using it")
    os.replace(tmp, p)
    log(f"model {key}: verified SHA-256 {h[:16]}...")
    return p


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


class Upscaler:
    """A 4x model on the Apple GPU (PyTorch MPS) through spandrel (MIT)."""

    def __init__(self, key):
        import torch, spandrel
        self.torch = torch
        p = os.path.join(home_dir(), 'models', MODELS[key]['file'])
        if not os.path.exists(p) or os.path.getsize(p) != MODELS[key]['size']:
            sys.exit(f"model {key} is not installed: run tools/texpack/setup.sh"
                     + (" --with-dat2" if key == 'dat2' else ''))
        if sha256_file(p) != MODELS[key]['sha256']:   # every build: a changed file is never loaded
            sys.exit(f"model {key}: {p} does not match its SHA-256; delete it and run "
                     f"tools/texpack/setup.sh" + (" --with-dat2" if key == 'dat2' else ''))
        self.dev = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
        # spandrel reads .pth with a restricted unpickler (tensors only) and
        # .safetensors as plain data: no code from the file is run
        desc = spandrel.ModelLoader(device='cpu').load_from_file(p)
        self.model = desc.model.eval().to(self.dev)
        self.scale = desc.scale
        self.name = f"{MODELS[key]['file']} ({desc.architecture.name}, {self.dev})"

    def run(self, rgb):
        """uint8 HxWx3 -> float32 (H*4)x(W*4)x3 in 0..1, in tiles."""
        torch = self.torch
        H, W = rgb.shape[:2]
        s = self.scale
        T, O = 192, 16                     # tile and overlap (input pixels)
        out = np.zeros((H * s, W * s, 3), np.float32)
        x = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).float().div(255).unsqueeze(0)
        with torch.no_grad():
            if H * W <= 320 * 320:
                y = self.model(x.to(self.dev)).clamp(0, 1)
                return y.squeeze(0).permute(1, 2, 0).cpu().numpy()
            for y0 in range(0, H, T):
                for x0 in range(0, W, T):
                    y1, x1 = min(y0 + T, H), min(x0 + T, W)
                    ya, xa = max(y0 - O, 0), max(x0 - O, 0)
                    yb, xb = min(y1 + O, H), min(x1 + O, W)
                    t = self.model(x[:, :, ya:yb, xa:xb].to(self.dev)).clamp(0, 1)
                    t = t.squeeze(0).permute(1, 2, 0).cpu().numpy()
                    out[y0 * s:y1 * s, x0 * s:x1 * s] = t[(y0 - ya) * s:(y1 - ya) * s, (x0 - xa) * s:(x1 - xa) * s]
        return out


# ---------------------------------------------------------------------------
# game files: TPK scan (layout observed in the v1.2 files; no third-party code)
#   0xB3300000 TPK > 0xB3310000 info > 0x33310004 TextureInfo[0x7C]
#                                    > 0x33310005 platform records[0x20] (FourCC +0x14)
#                  > 0xB3320000 data > 0x33320002 pixels (128-byte aligned)
#   TextureInfo: +0x0C name[24], +0x30 image offset, +0x34 palette offset,
#   +0x38 image size, +0x3C palette size, +0x40 level-0 size, +0x44 w, +0x46 h,
#   +0x4A compression (0x08 = P8), +0x4E mip levels
# ---------------------------------------------------------------------------
def part_of(path, name):
    """Pack part of a texture, from its file and name."""
    p = path.replace('\\', '/').upper()
    n = name.upper()
    eff = ('SFX_', 'XE_', 'XETT_', 'SKID_', 'DUSTA', 'GENERICA', 'SPARK', 'TIREPATCH', 'RADIAL',
           'RAINDROP', 'WATERDROPLET', 'ICESPLASH', 'NEONBLUR', 'SHADOWRAMP', 'HEADLIGHTFLARE',
           'HEADLIGHTGLOW', 'FLOCKOFSEAGULLS')
    car = ('BRAKE', 'GRILL', 'HEADLIGHTS', 'CHROME', 'CARBON', 'EXHAUST', 'WINDOW', 'LICENSE_PLATE',
           'TIREBACK', 'DRIVER', 'TRAFFIC_', 'INTERCOOLER', 'HOODSLATS', 'RUBBER_', 'CARBOTTOM',
           'ALUMINUM', 'REAR_DEFROSTER', '2PLAYERHEADLIGHT')
    if 'DYNTEX' in p or 'SKYDOME' in n:
        return 'sky'                     # clouds and sky domes (LOC4DYNTEX.BIN, ARC_SKYDOME_*)
    if n.startswith(eff):
        return 'effects'
    if p.startswith('CARS/'):
        return 'cars'
    if p.startswith('TRACKS/') or p.startswith('NIS/'):
        if n.startswith(('SGN', 'ADS_')):
            return 'signs'
        if n.startswith('TRACKMAP'):
            return 'frontend'
        return 'world'
    if p.startswith('FRONTEND/PLATFORMS/'):
        return 'garage'
    if p.startswith('FRONTEND/') or p.startswith('LANGUAGES/'):
        return 'frontend'
    if p.startswith('GLOBAL/'):
        if n.startswith(car):
            return 'cars'
        if n.startswith('ADS_'):
            return 'signs'
        if n.startswith('OBJ_'):
            return 'world'
        if p.startswith('GLOBAL/INGAME') or p.startswith('GLOBAL/HUD'):
            return 'hud'
        return 'frontend'
    return 'other'


def xxh3(data, w, h, fmt):
    import xxhash
    return xxhash.xxh3_64_intdigest(data, seed=w | h << 16 | fmt << 32)


def scan_game(root):
    """-> {hash: entry}; entry = dict(name, file, part, w, h, fmt, mips, src=(file, off, size, paloff))"""
    out = {}
    nfiles = 0
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for f in sorted(fn):
            if not f.lower().endswith(('.bun', '.bin')):
                continue
            path = os.path.join(dp, f)
            rel = os.path.relpath(path, root).replace(os.sep, '/')
            up = rel.upper()
            if up.endswith('VINYLS.BIN') or up.startswith('FRONTEND/ENVMAPS/') or up.startswith('MOVIES/'):
                continue                         # CPU composite inputs / cube maps
            with open(path, 'rb') as fh:
                d = fh.read()
            if b'\x00\x00\x30\xb3' not in d:
                continue
            n = 0
            for ent in walk_chunks(d, 0, len(d), rel, 0):
                if ent['hash'] not in out:
                    out[ent['hash']] = ent
                n += 1
            if n == 0:                            # padded / sectioned file: find TPK roots
                i = d.find(b'\x00\x00\x30\xb3')
                while i >= 0:
                    if i % 4 == 0 and i + 8 <= len(d):
                        sz, = struct.unpack_from('<I', d, i + 4)
                        if i + 8 + sz <= len(d):
                            for ent in parse_tpk(d, i + 8, i + 8 + sz, rel):
                                if ent['hash'] not in out:
                                    out[ent['hash']] = ent
                                n += 1
                            i = d.find(b'\x00\x00\x30\xb3', i + 8 + sz)
                            continue
                    i = d.find(b'\x00\x00\x30\xb3', i + 1)
            if n:
                nfiles += 1
    return out, nfiles


def walk_chunks(d, off, end, rel, depth):
    o = off
    while o + 8 <= end:
        cid, sz = struct.unpack_from('<II', d, o)
        b = o + 8
        if sz > end - b:
            return
        if cid == 0xB3300000:
            yield from parse_tpk(d, b, b + sz, rel)
        elif (cid & 0x80000000) and depth < 6:
            yield from walk_chunks(d, b, b + sz, rel, depth + 1)
        o = b + sz


def parse_tpk(d, off, end, rel):
    info = data = None
    o = off
    while o + 8 <= end:
        cid, sz = struct.unpack_from('<II', d, o)
        b = o + 8
        if b + sz > end:
            break
        if cid == 0xB3310000:
            info = (b, b + sz)
        elif cid == 0xB3320000:
            data = (b, b + sz)
        o = b + sz
    if not info or not data:
        return
    ents = plat = None
    o = info[0]
    while o + 8 <= info[1]:
        cid, sz = struct.unpack_from('<II', d, o)
        b = o + 8
        if cid == 0x33310004:
            ents = (b, sz)
        elif cid == 0x33310005:
            plat = (b, sz)
        o = b + sz
    pix = None
    o = data[0]
    while o + 8 <= data[1]:
        cid, sz = struct.unpack_from('<II', d, o)
        b = o + 8
        if cid == 0x33320002:
            pix = (b + 0x7F) & ~0x7F
        o = b + sz
    if not ents or pix is None:
        return
    for i in range(ents[1] // 0x7C):
        e = ents[0] + i * 0x7C
        name = d[e + 0x0C:e + 0x24].split(b'\0')[0].decode('latin1')
        img_off, pal_off, img_size, pal_size, base_size = struct.unpack_from('<5I', d, e + 0x30)
        w, h = struct.unpack_from('<HH', d, e + 0x44)
        comp, mips = d[e + 0x4A], d[e + 0x4E]
        four = d[plat[0] + i * 0x20 + 0x14:plat[0] + i * 0x20 + 0x18] if plat and plat[1] >= (i + 1) * 0x20 else b''
        fmtname = four.decode('latin1') if four in (b'DXT1', b'DXT3', b'DXT5') else None
        if fmtname and base_size and pix + img_off + base_size <= len(d):
            lv0 = d[pix + img_off:pix + img_off + base_size]
            src = (rel, pix + img_off, base_size, -1)
        elif comp == 0x08 and pal_size >= 1024 and pix + img_off + w * h <= len(d) and pix + pal_off + 1024 <= len(d):
            # P8: the game expands it with its BGRA palette to A8R8G8B8 before the upload
            ix = np.frombuffer(d, np.uint8, w * h, pix + img_off)
            P = np.frombuffer(d, np.uint8, 1024, pix + pal_off).reshape(256, 4)
            lv0 = P[ix].tobytes()
            fmtname = 'A8R8G8B8'
            src = (rel, pix + img_off, w * h, pix + pal_off)
        else:
            continue
        yield dict(hash=xxh3(lv0, w, h, FMT[fmtname]), name=name, file=rel, part=part_of(rel, name),
                   w=w, h=h, fmt=fmtname, mips=max(1, mips), src=src)


def read_level0(game, ent):
    """level-0 bytes of an entry (scan or dump)"""
    if 'dds' in ent:
        with open(ent['dds'], 'rb') as f:
            b = f.read()
        return b[128:]
    rel, off, size, paloff = ent['src']
    with open(os.path.join(game, rel), 'rb') as f:
        f.seek(off)
        b = f.read(size)
        if paloff < 0:
            return b
        f.seek(paloff)
        P = np.frombuffer(f.read(1024), np.uint8).reshape(256, 4)
    return P[np.frombuffer(b, np.uint8)].tobytes()


def scan_dumps(dirs):
    """texture_dump folders (runtime/texrep.m): <dir>/<part>/<w>x<h>_<fmt>_<hash>.dds + index.csv"""
    out = {}
    rx = re.compile(r'^(\d+)x(\d+)_(DXT1|DXT3|DXT5|A8R8G8B8)_([0-9a-f]{16})\.dds$')
    for d in dirs:
        meta = {}
        ix = os.path.join(d, 'index.csv')
        if os.path.exists(ix):
            for r in csv.DictReader(open(ix, newline='')):
                meta[r['hash']] = r
        for dp, dn, fn in os.walk(d):
            for f in fn:
                m = rx.match(f)
                if not m:
                    continue
                w, h, fmt, hx = int(m[1]), int(m[2]), m[3], m[4]
                part = os.path.basename(dp)
                if part not in PARTS:
                    part = 'other'
                r = meta.get(hx, {})
                if r.get('source'):
                    part = part_of(r['source'], '')         # the source file decides (as for the scan)
                levels = int(r.get('levels') or 1)
                out[int(hx, 16)] = dict(hash=int(hx, 16), name='', file=r.get('source', ''), part=part,
                                        w=w, h=h, fmt=fmt, mips=levels, dds=os.path.join(dp, f))
    return out


# ---------------------------------------------------------------------------
# decode
# ---------------------------------------------------------------------------
def decode(lv0, w, h, fmt):
    """level 0 -> RGBA uint8 HxWx4 (DXT1 punch-through gives alpha 0)"""
    if fmt == 'A8R8G8B8':
        a = np.frombuffer(lv0, np.uint8, w * h * 4).reshape(h, w, 4)
        return np.ascontiguousarray(a[..., [2, 1, 0, 3]])
    hd = bytearray(128)
    hd[0:4] = b'DDS '
    struct.pack_into('<7I', hd, 4, 124, 0x81007, h, w, len(lv0), 0, 1)
    struct.pack_into('<2I', hd, 76, 32, 4)
    hd[84:88] = fmt.encode()
    struct.pack_into('<I', hd, 108, 0x1000)
    im = Image.open(io.BytesIO(bytes(hd) + lv0))
    im.load()
    return np.asarray(im.convert('RGBA')).copy()


# ---------------------------------------------------------------------------
# post-processing and encoding (worker processes)
# ---------------------------------------------------------------------------
def tiles_seamlessly(rgb, axis):
    """the opposite edges match like neighbouring texels: a tiling texture"""
    a = rgb.astype(np.float32)
    if axis == 0:
        edge = np.abs(a[0] - a[-1]).mean()
        inner = np.abs(np.diff(a, axis=0)).mean()
    else:
        edge = np.abs(a[:, 0] - a[:, -1]).mean()
        inner = np.abs(np.diff(a, axis=1)).mean()
    return edge <= 1.5 * inner + 1.0


def pad_modes(rgb):
    return ('wrap' if tiles_seamlessly(rgb, 0) else 'symmetric',
            'wrap' if tiles_seamlessly(rgb, 1) else 'symmetric')


def pad2(a, p, modes):
    widths_y = ((p, p),) + ((0, 0),) * (a.ndim - 1)
    widths_x = ((0, 0), (p, p)) + ((0, 0),) * (a.ndim - 2)
    a = np.pad(a, widths_y, mode=modes[0])
    return np.pad(a, widths_x, mode=modes[1])


def bilinear_up(ch, k, modes):
    """the GPU's own bilinear magnification of one 8-bit channel by k"""
    h, w = ch.shape
    p = pad2(ch, 1, modes)
    up = np.asarray(Image.fromarray(p).resize(((w + 2) * k, (h + 2) * k), Image.BILINEAR))
    return np.ascontiguousarray(up[k:(1 + h) * k, k:(1 + w) * k])


def to565(c):
    c = np.clip(np.round(c), 0, 255).astype(np.int32)
    return ((c[..., 0] * 31 + 127) // 255) << 11 | ((c[..., 1] * 63 + 127) // 255) << 5 | ((c[..., 2] * 31 + 127) // 255)


def from565(v):
    return np.stack([((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31], -1)


def blocks(rgba):
    h, w = rgba.shape[:2]
    return rgba.reshape(h // 4, 4, w // 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(-1, 16, 4)


def bc1_punch(tb):
    """BC1 blocks in 3-colour mode (index 3 = transparent black) for blocks with cut-outs"""
    n = len(tb)
    op = tb[:, :, 3] >= 128
    col = tb[:, :, :3].astype(np.float64)
    lum = col @ np.array([0.299, 0.587, 0.114])
    lo = np.where(op, lum, np.inf).argmin(1)
    hi = np.where(op, lum, -np.inf).argmax(1)
    r = np.arange(n)
    c0, c1 = to565(col[r, lo]), to565(col[r, hi])
    sw = c0 > c1
    c0, c1 = np.where(sw, c1, c0), np.where(sw, c0, c1)        # c0 <= c1: 3-colour mode
    p0, p1 = from565(c0), from565(c1)
    pal = np.stack([p0, p1, (p0 + p1) / 2], 1)                  # n x 3 x 3
    dist = ((col[:, :, None, :] - pal[:, None, :, :]) ** 2).sum(-1)
    idx = np.where(op, dist.argmin(-1), 3).astype(np.uint32)
    none = ~op.any(1)
    c0 = np.where(none, 0, c0)
    c1 = np.where(none, 0, c1)
    bits = (idx << (2 * np.arange(16, dtype=np.uint32))).sum(1).astype(np.uint32)
    out = np.zeros((n, 8), np.uint8)
    out[:, 0], out[:, 1] = c0 & 255, c0 >> 8
    out[:, 2], out[:, 3] = c1 & 255, c1 >> 8
    for k in range(4):
        out[:, 4 + k] = (bits >> (8 * k)) & 255
    return out


def bc1_fix_order(blk):
    """etcpak's opaque blocks must decode in 4-colour mode (c0 > c1): a
    3-colour block would turn index 3 into a transparent hole"""
    c0 = blk[:, 0].astype(np.int32) | blk[:, 1].astype(np.int32) << 8
    c1 = blk[:, 2].astype(np.int32) | blk[:, 3].astype(np.int32) << 8
    bits = (blk[:, 4].astype(np.uint32) | blk[:, 5].astype(np.uint32) << 8
            | blk[:, 6].astype(np.uint32) << 16 | blk[:, 7].astype(np.uint32) << 24)
    sh = 2 * np.arange(16, dtype=np.uint32)
    idx = (bits[:, None] >> sh) & 3
    bad = (c0 <= c1) & (idx == 3).any(1)
    if not bad.any():
        return blk
    b = blk.copy()
    eq = bad & (c0 == c1)
    b[eq, 4:8] = 0                                    # one colour: every texel index 0
    sw = bad & (c0 < c1)
    if sw.any():                                      # swap endpoints, remap 0<->1, 2<->3
        b[sw, 0:2], b[sw, 2:4] = blk[sw, 2:4], blk[sw, 0:2]
        nidx = idx[sw] ^ 1
        nb = (nidx << sh).sum(1).astype(np.uint32)
        for k in range(4):
            b[sw, 4 + k] = (nb >> (8 * k)) & 255
    return b


W4 = np.array([1.0, 0.0, 2 / 3, 1 / 3])


def bc_refine(blk, tb, iters=2):
    """least-squares endpoint refinement of 4-colour BC1-style colour blocks:
    keep etcpak's indices, solve for the two endpoints that fit the texels
    best, re-quantise and re-index; a block is only replaced when its error
    drops (about +1.9 dB PSNR over etcpak alone on game textures)"""
    out = blk.copy()
    sh = 2 * np.arange(16, dtype=np.uint32)
    for s0 in range(0, len(blk), 32768):
        b = out[s0:s0 + 32768]
        px = tb[s0:s0 + 32768, :, :3].astype(np.float32)
        for _ in range(iters):
            c0 = b[:, 0].astype(np.int64) | b[:, 1].astype(np.int64) << 8
            c1 = b[:, 2].astype(np.int64) | b[:, 3].astype(np.int64) << 8
            bits = (b[:, 4].astype(np.uint32) | b[:, 5].astype(np.uint32) << 8
                    | b[:, 6].astype(np.uint32) << 16 | b[:, 7].astype(np.uint32) << 24)
            idx = ((bits[:, None] >> sh) & 3).astype(np.int64)
            w = W4[idx].astype(np.float32)
            a11 = (w * w).sum(1); a12 = (w * (1 - w)).sum(1); a22 = ((1 - w) ** 2).sum(1)
            b1 = (w[:, :, None] * px).sum(1); b2 = ((1 - w)[:, :, None] * px).sum(1)
            det = a11 * a22 - a12 * a12
            ok = (c0 > c1) & (np.abs(det) > 1e-6)
            dd = np.where(ok, det, 1)[:, None]
            n0 = to565((a22[:, None] * b1 - a12[:, None] * b2) / dd)
            n1 = to565((a11[:, None] * b2 - a12[:, None] * b1) / dd)
            sw = n0 < n1
            n0, n1 = np.where(sw, n1, n0), np.where(sw, n0, n1)
            good = ok & (n0 != n1)
            def pal(e0, e1):
                p0, p1 = from565(e0).astype(np.float32), from565(e1).astype(np.float32)
                return np.stack([p0, p1, (2 * p0 + p1) / 3, (p0 + 2 * p1) / 3], 1)
            d = ((px[:, :, None, :] - pal(n0, n1)[:, None, :, :]) ** 2).sum(-1)
            nidx, nerr = d.argmin(-1), d.min(-1).sum(1)
            od = ((px[:, :, None, :] - pal(c0, c1)[:, None, :, :]) ** 2).sum(-1)
            oerr = np.take_along_axis(od, idx[:, :, None], -1)[..., 0].sum(1)
            take = good & (nerr < oerr)
            if not take.any():
                break
            nb = (nidx.astype(np.uint32) << sh).sum(1).astype(np.uint32)
            b[take, 0], b[take, 1] = n0[take] & 255, n0[take] >> 8
            b[take, 2], b[take, 3] = n1[take] & 255, n1[take] >> 8
            for k in range(4):
                b[take, 4 + k] = (nb[take] >> (8 * k)) & 255
        out[s0:s0 + 32768] = b
    return out


def encode(rgba, fmt):
    import etcpak
    h, w = rgba.shape[:2]
    if fmt == 'A8R8G8B8':
        return np.ascontiguousarray(rgba[..., [2, 1, 0, 3]]).tobytes()
    if w % 4 or h % 4:
        rgba = np.pad(rgba, ((0, -h % 4), (0, -w % 4), (0, 0)), mode='edge')
        h, w = rgba.shape[:2]
    src = np.ascontiguousarray(rgba)
    if fmt == 'DXT1':
        blk = np.frombuffer(etcpak.compress_bc1(src.tobytes(), w, h), np.uint8).reshape(-1, 8).copy()
        blk = bc1_fix_order(blk)
        tb = blocks(src)
        blk = bc_refine(blk, tb)
        cut = (tb[:, :, 3] < 128).any(1)
        if cut.any():
            blk[cut] = bc1_punch(tb[cut])
        return blk.tobytes()
    bc3 = np.frombuffer(etcpak.compress_bc3(src.tobytes(), w, h), np.uint8).reshape(-1, 16).copy()
    bc3[:, 8:16] = bc_refine(bc3[:, 8:16], blocks(src))
    if fmt == 'DXT5':
        return bc3.tobytes()
    a4 = ((src[..., 3].astype(np.uint16) * 15 + 127) // 255).astype(np.uint8)   # BC2: 4-bit alpha
    ab = a4.reshape(h // 4, 4, w // 4, 4).transpose(0, 2, 1, 3).reshape(-1, 16)
    packed = (ab[:, 0::2] | (ab[:, 1::2] << 4)).astype(np.uint8)
    return np.concatenate([packed, bc3[:, 8:16]], axis=1).tobytes()


def write_dds(path, w, h, fmt, levels):
    hd = bytearray(128)
    hd[0:4] = b'DDS '
    struct.pack_into('<7I', hd, 4, 124, 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000, h, w, 0, 0, len(levels))
    struct.pack_into('<I', hd, 76, 32)
    if fmt == 'A8R8G8B8':
        struct.pack_into('<6I', hd, 80, 0x41, 0, 32, 0x00ff0000, 0x0000ff00, 0x000000ff)
        struct.pack_into('<I', hd, 104, 0xff000000)
    else:
        struct.pack_into('<I', hd, 80, 4)
        hd[84:88] = fmt.encode()
    struct.pack_into('<I', hd, 108, 0x1000 | 0x400000 | 0x8)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(hd)
        for l in levels:
            f.write(l)
    os.replace(tmp, path)
    return os.path.getsize(path)


def bicubic_up(ch, k, modes):
    """float32 HxW -> (H*k)x(W*k), bicubic, with the texture's edge modes"""
    h, w = ch.shape
    p = pad2(ch.astype(np.float32), 2, modes)
    up = np.asarray(Image.fromarray(p, 'F').resize(((w + 4) * k, (h + 4) * k), Image.BICUBIC))
    return up[2 * k:(2 + h) * k, 2 * k:(2 + w) * k]


def box_down(a, k):
    h, w = a.shape[0] // k, a.shape[1] // k
    return a.reshape(h, k, w, k, *a.shape[2:]).mean((1, 3))


BACKPROJECT = 8           # back-projection passes (0 = off: the model's output as it is)


def soften(d, modes):
    """[1 2 1]/4 in both directions at the original's resolution: the
    texel-sized checkerboard (the original's own grid) is not put back"""
    p = pad2(d, 1, modes)
    p = (p[:-2] + 2 * p[1:-1] + p[2:]) / 4
    return (p[:, :-2] + 2 * p[:, 1:-1] + p[:, 2:]) / 4


BP_SOFT = 1               # soften() the difference (0: put back the texel grid too; tests only)


def backproject(rgb4, orig_rgb, modes, passes=BACKPROJECT):
    """Make the 4x result average back to the original: each pass adds the
    bicubic-magnified difference between the original and the result's 4x4
    averages.  What the model added above the original's resolution stays;
    what it changed AT the original's resolution (a weave it took for noise,
    blotches, a brightness shift) is put back.  So the pack's levels and the
    game's own level underneath agree, and the model can only add detail,
    never repaint the texture."""
    o = orig_rgb.astype(np.float32)
    for _ in range(passes):
        d = o - box_down(rgb4, 4)
        if BP_SOFT:
            d = soften(d, modes)
        rgb4 = rgb4 + np.dstack([bicubic_up(d[..., c], 4, modes) for c in range(3)])
    return np.clip(rgb4, 0, 255)


def make_levels(orig, up, fmt, scale, modes, passes=BACKPROJECT):
    """model output -> the RGBA levels a pack file holds, largest first
    (scale: this texture's, 4 or 2; up is always the model's 4x)"""
    h, w = orig.shape[:2]
    W, H = w * 4, h * 4
    # chroma lock: the model's luma, the original's chroma (bicubic): no hue drift
    ref = np.asarray(Image.fromarray(np.ascontiguousarray(orig[..., :3])).resize((W, H), Image.BICUBIC)).astype(np.float32)
    k = np.array([0.299, 0.587, 0.114], np.float32)
    u = up * 255.0
    rgb4 = np.clip(ref + ((u @ k) - (ref @ k))[..., None], 0, 255)
    if passes:
        rgb4 = backproject(rgb4, orig[..., :3], modes, passes)
    alpha = orig[..., 3]
    flat_a = alpha.min() == alpha.max()
    levels = []
    ks = [4, 2] if scale == 4 else [2]
    for kk in ks:
        if kk == 4:
            rgb = rgb4
        else:                                           # box filter (area) from the 4x result
            rgb = box_down(rgb4, 2)
        rgb = np.clip(np.round(rgb), 0, 255).astype(np.uint8)
        if flat_a:
            a = np.full(rgb.shape[:2], alpha[0, 0], np.uint8)
        else:
            a = bilinear_up(alpha, kk, modes)
            if fmt == 'DXT1':
                a = np.where(a >= 128, 255, 0).astype(np.uint8)
        levels.append(np.dstack([rgb, a]))
    return levels


def finish(job):
    """worker: model output -> pack file.  job = dict(orig RGBA, up float RGB at 4x, ...)"""
    orig, fmt, scale = job['orig'], job['fmt'], job['scale']
    h, w = orig.shape[:2]
    levels = make_levels(orig, job['up'], fmt, scale, job['modes'], job.get('passes', BACKPROJECT))
    return write_dds(job['path'], w * scale, h * scale, fmt, [encode(l, fmt) for l in levels])


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
def default_game():
    ini = os.path.join(support_dir(), 'settings.ini')
    if os.path.exists(ini):
        for line in open(ini, encoding='utf-8', errors='replace'):
            m = re.match(r'\s*game_folder\s*=\s*(.+?)\s*$', line)
            if m:
                return m[1].strip('"\'')
    return None


def find_game(arg):
    g = arg or os.environ.get('NFSU2_DATA') or default_game()
    if not g:
        sys.exit("where is the game? pass --game <folder with SPEED2.EXE> (or set game_folder in settings.ini)")
    g = os.path.expanduser(g)
    if os.path.isfile(g):
        g = os.path.dirname(g)
    if not os.path.isdir(os.path.join(g, 'TRACKS')):
        sys.exit(f"{g} does not look like the game folder (no TRACKS folder)")
    return g


def pack_dir(a):
    if a.out:
        return os.path.expanduser(a.out)
    return os.path.join(support_dir(), 'Textures', a.name)


MAX_SIDE = 2048           # largest level made (texels)
SMOOTH = 7.0              # mean |Laplacian| of the luma below which a texture is "smooth"


def tex_scale(e, scale):
    """scale for one texture: the pack's, capped so no level exceeds MAX_SIDE"""
    s = scale
    while s > 1 and max(e['w'], e['h']) * s > MAX_SIDE:
        s //= 2
    return s


def eligible(e, scale=4):
    if e['fmt'] not in FMT:
        return 'format'
    if e['w'] < 16 or e['h'] < 16 or e['w'] * e['h'] <= 1024:
        return 'small'
    if tex_scale(e, scale) < 2:
        return 'large'
    src = e.get('file', '').upper()
    if e['part'] == 'cars' and (e['fmt'] == 'A8R8G8B8' or 'VINYLS' in src):
        return 'carskin'                 # layers of the CPU paint composite
    if e.get('name', '').upper().startswith('ANM_'):
        return 'animated'                # flipbook frames (water): upscaled one by one they flicker
    return None


def smoothness(rgb):
    y = rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
    if y.shape[0] < 3 or y.shape[1] < 3:
        return 0.0
    return float(np.abs(4 * y[1:-1, 1:-1] - y[:-2, 1:-1] - y[2:, 1:-1] - y[1:-1, :-2] - y[1:-1, 2:]).mean())


def collect(a):
    game = find_game(a.game)
    t0 = time.time()
    ents, nfiles = scan_game(game)
    log(f"game {game}: {len(ents)} textures in {nfiles} files ({time.time() - t0:.1f} s)")
    dumps = list(a.dump or [])
    auto = os.path.join(support_dir(), 'Textures', 'dump')
    if not a.dump and os.path.isdir(auto):
        dumps.append(auto)
    if dumps:
        dd = scan_dumps(dumps)
        new = {h: e for h, e in dd.items() if h not in ents}
        log(f"dumps {', '.join(dumps)}: {len(dd)} textures, {len(new)} not in the game's uncompressed files")
        ents.update(new)
    return game, ents


def cmd_scan(a):
    game, ents = collect(a)
    by = {}
    for e in ents.values():
        why = eligible(e, 4)
        key = (e['part'], why or 'ok')
        n, px = by.get(key, (0, 0))
        by[key] = (n + 1, px + e['w'] * e['h'])
    for k in sorted(by):
        log(f"  {k[0]:9s} {k[1]:7s} {by[k][0]:6d} textures {by[k][1] / 1e6:8.1f} Mpix")


def cmd_info(a):
    d = pack_dir(a)
    ini = os.path.join(d, 'pack.ini')
    if os.path.exists(ini):
        log(open(ini).read().strip())
    tot = 0
    for p in PARTS + ['']:
        pd = os.path.join(d, p)
        if not os.path.isdir(pd) or (p == '' and True):
            continue
        fs = [f for f in os.listdir(pd) if f.endswith('.dds')]
        sz = sum(os.path.getsize(os.path.join(pd, f)) for f in fs)
        tot += sz
        log(f"  {p:9s} {len(fs):6d} textures {sz / 2**20:9.1f} MB")
    log(f"  total {tot / 2**20:.1f} MB in {d}")


def phys_mem():
    try:
        import subprocess
        return int(subprocess.check_output(['sysctl', '-n', 'hw.memsize']).strip())
    except Exception:
        return 8 << 30


def cmd_build(a):
    scale = a.scale
    if scale == 'auto':
        scale = 4 if phys_mem() >= 15 * 2**30 else 2
    scale = int(scale)
    if scale not in (2, 4):
        sys.exit("--scale must be 2, 4 or auto")
    parts = PARTS if a.parts in (None, 'all') else [p.strip() for p in a.parts.split(',') if p.strip()]
    for p in parts:
        if p not in PARTS:
            sys.exit(f"unknown part {p!r} (parts: {', '.join(PARTS)})")
    out = pack_dir(a)
    os.makedirs(out, exist_ok=True)
    ini = os.path.join(out, 'pack.ini')
    if os.path.exists(ini) and not a.force:
        old = dict(re.findall(r'^(\w+)\s*=\s*(.*)$', open(ini).read(), re.M))
        if old.get('model') != a.model or old.get('scale') != str(scale):
            sys.exit(f"{out} holds a pack made with model {old.get('model')} at {old.get('scale')}x; "
                     f"use another --name, or --force to rebuild it")
    game, ents = collect(a)
    todo, skipped, have, plan = [], {}, 0, []
    for e in sorted(ents.values(), key=lambda e: (e['part'], e['file'], e['name'], e['hash'])):
        why = eligible(e, scale) or (None if e['part'] in parts else 'part')
        if why:
            skipped[why] = skipped.get(why, 0) + 1
            continue
        nm = re.sub(r'[^A-Za-z0-9_\-]', '_', e['name'])[:40] if e['name'] else e['fmt']
        e['out'] = os.path.join(out, e['part'], f"{nm}_{e['w']}x{e['h']}_{e['hash']:016x}.dds")
        plan.append(e)
        if os.path.exists(e['out']) and not a.force:
            have += 1
            continue
        todo.append(e)
    if a.limit:
        todo = todo[:a.limit]
    mpix = sum(e['w'] * e['h'] for e in todo) / 1e6
    log(f"pack {out}: {scale}x with {a.model}; {len(todo)} textures to look at ({mpix:.1f} Mpix), "
        f"{have} already there; skipped: " + ', '.join(f"{v} {k}" for k, v in sorted(skipped.items())))
    for p in parts:
        os.makedirs(os.path.join(out, p), exist_ok=True)
    up = Upscaler(a.model) if todo else None
    if up:
        log(f"model {up.name}")
    t0 = time.time()
    done = flat = smooth = fail = 0
    nbytes = 0
    px_done = 0
    pend = []
    jobs = a.jobs or max(2, min(8, (os.cpu_count() or 4) - 2))
    with ProcessPoolExecutor(max_workers=jobs) as ex:
        def reap(block):
            nonlocal done, fail, nbytes
            keep = []
            for e, fu in pend:
                if not block and not fu.done():
                    keep.append((e, fu))
                    continue
                try:
                    nbytes += fu.result()
                    done += 1
                except Exception as x:
                    fail += 1
                    log(f"  failed {e['out']}: {x}")
            pend[:] = keep
        for i, e in enumerate(todo):
            try:
                orig = decode(read_level0(game, e), e['w'], e['h'], e['fmt'])
            except Exception as x:
                fail += 1
                log(f"  cannot read {e['name'] or e['hash']:x}: {x}")
                continue
            rgb = orig[..., :3]
            if int(rgb.max()) - int(rgb.min()) <= 2:
                flat += 1                                 # one colour: nothing to gain
                continue
            if smoothness(rgb) < SMOOTH:
                smooth += 1                               # sky, glow: the model would add grain
                continue
            modes = pad_modes(rgb)
            p = 16
            u = up.run(pad2(rgb, p, modes))[p * 4:(p + e['h']) * 4, p * 4:(p + e['w']) * 4]
            pend.append((e, ex.submit(finish, dict(orig=orig, up=np.ascontiguousarray(u), fmt=e['fmt'],
                                                   scale=tex_scale(e, scale), modes=modes, path=e['out']))))
            px_done += e['w'] * e['h']
            while len(pend) > 2 * jobs:
                reap(False)
                if len(pend) > 2 * jobs:
                    time.sleep(0.01)
            if (i + 1) % 100 == 0 or i + 1 == len(todo):
                el = time.time() - t0
                rate = px_done / 1e6 / max(el, 1e-9)
                eta = (mpix - px_done / 1e6) / max(rate, 1e-9)
                log(f"  {i + 1}/{len(todo)}  {el:6.0f} s  {rate:.2f} Mpix/s  about {eta / 60:.1f} min left")
        reap(True)
    # a texture this build placed elsewhere (another part or name in a newer
    # tool) leaves no stale copy behind; other files (hand-made) are kept
    want = {e['hash']: os.path.abspath(e['out']) for e in plan}
    for dp, dn, fn in os.walk(out):
        for f in fn:
            m = re.search(r'_([0-9a-f]{16})\.dds$', f)
            p = os.path.abspath(os.path.join(dp, f))
            if m and int(m[1], 16) in want and want[int(m[1], 16)] != p and os.path.exists(want[int(m[1], 16)]):
                os.unlink(p)
    # manifest: every planned texture whose file is there (the files decide)
    with open(os.path.join(out, 'manifest.csv'), 'w', newline='') as mf:
        mw = csv.writer(mf)
        mw.writerow(['hash', 'name', 'part', 'source', 'w', 'h', 'fmt', 'scale', 'model', 'file'])
        for e in plan:
            if os.path.exists(e['out']):
                mw.writerow([f"{e['hash']:016x}", e['name'], e['part'], e['file'], e['w'], e['h'], e['fmt'],
                             tex_scale(e, scale), a.model, os.path.relpath(e['out'], out)])
    el = time.time() - t0
    tot = sum(os.path.getsize(os.path.join(dp, f)) for dp, dn, fn in os.walk(out) for f in fn if f.endswith('.dds'))
    cnt = sum(1 for dp, dn, fn in os.walk(out) for f in fn if f.endswith('.dds'))
    with open(ini, 'w') as f:
        f.write(f"# NFSU2 texture pack (tools/texpack)\n"
                f"format = {PACK_FORMAT}\ntool = {TOOL_VERSION}\nmodel = {a.model}\n"
                f"model_file = {MODELS[a.model]['file']}\nmodel_licence = {MODELS[a.model]['licence']}\n"
                f"scale = {scale}\ntextures = {cnt}\nbytes = {tot}\n"
                f"built = {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    log(f"done: {done} made, {flat} single-colour and {smooth} smooth skipped, {fail} failed, in {el:.0f} s; "
        f"pack {cnt} textures, {tot / 2**20:.0f} MB at {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('build', help='make (or complete) a pack')
    s = sub.add_parser('scan', help="census of the game's textures")
    i = sub.add_parser('info', help='what a pack holds')
    f = sub.add_parser('fetch-model', help='download and verify a model')
    f.add_argument('model', nargs='?', default='span', choices=sorted(MODELS))
    for p in (b, s):
        p.add_argument('--game', help='game folder (default: game_folder from settings.ini)')
        p.add_argument('--dump', action='append',
                       help='texture_dump folder(s) to include (default: <Application Support>/NFSU2/Textures/dump)')
    for p in (b, i):
        p.add_argument('--name', default='default', help='pack name under <Application Support>/NFSU2/Textures/')
        p.add_argument('--out', help='pack folder (instead of --name)')
    b.add_argument('--scale', default='auto', help='4, 2 or auto (4 with 16 GB of memory or more)')
    b.add_argument('--model', default='span', choices=sorted(MODELS))
    b.add_argument('--parts', help='comma list of parts to make (default all): ' + ','.join(PARTS))
    b.add_argument('--jobs', type=int, help='encoder processes')
    b.add_argument('--limit', type=int, help='make at most N textures (a quick look)')
    b.add_argument('--force', action='store_true', help='rebuild existing files')
    a = ap.parse_args()
    if a.cmd == 'fetch-model':
        fetch_model(a.model)
    elif a.cmd == 'scan':
        cmd_scan(a)
    elif a.cmd == 'info':
        cmd_info(a)
    else:
        cmd_build(a)


if __name__ == '__main__':
    main()
