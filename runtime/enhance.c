/* Graphics enhancements.  See enhance.h.
 *
 * 0) RUNTIME OPTIONS (every build)
 *    The HD build's features that passed the image and frame-time
 *    measurements are options of the normal binary, all
 *    off by default (the frame is then the original's, bit for bit):
 *      NFSU2_GRAPHICS = original | enhanced | custom   preset (settings.ini graphics)
 *          original  the original look; the options below are ignored
 *          enhanced  msaa auto, mirror high, texture_filtering anisotropic;
 *                    an option below that is set overrides its item
 *          custom    only the options below (each off unless set)
 *          unset     custom when one of the options below is set, else original
 *      NFSU2_MSAA = off | 2 | 4 | auto        MSAA of the screen passes (3)
 *      NFSU2_MIRROR = original | high | <px>  rear-view mirror target 256 -> 1024 (1)
 *      NFSU2_TEXTURE_FILTERING = game | anisotropic
 *                                             16x AF where the game asks for it
 *                                             (= the game's g_TextureFiltering 2)
 *    The research build (NFS_ENHANCED, ./link.sh hd, not packaged) keeps
 *    upstream's defaults and HD_* variables, plus the larger road reflection
 *    with its blur fix (2; also NFSU2_ROAD_REFLECTION = original | high | <f>
 *    there), SSR, ray tracing and the larger cube map: rejected for the
 *    shipped app (no real improvement on the original look, or artifacts).
 *
 * 1) REFLECTION RESOLUTION
 *    The game draws three reflections into separate render targets:
 *      road reflection   320x240   (scaled up 6x horizontally at 1080p)
 *      rear-view mirror  256x256
 *      car cube map      128/face
 *    The targets are recognized by their CALL ADDRESS (our exe, v1.2 NA, SHA-256 f9dd86c0...).
 *    The community mods' addresses are shifted in this exe; the ones here
 *    come from our own disassembly:
 *      0x5BA097  CreateTexture(320,240,RT)   road reflection
 *      0x5BA10D  CreateTexture(320,240,RT)   road reflection blur
 *                                            (reflection level 3 only)
 *      0x5BA1CD  CreateTexture([7FEE80],[7FEE84],RT)  rear-view mirror
 *      0x5BA549  CreateCubeTexture([7FEE6C],RT)       car environment map
 *    The Z surfaces (0x5BA0D9, 0x5BA20C, 0x5BA59A) are left alone: Metal
 *    creates the Z texture at the size of the first target it is used with.
 *
 *    Env:    HDREFL=0       turn the reflection enhancement off (for A/B)
 *            HD_ROAD=0.5    road reflection: multiple of the back buffer.  2026-10-15
 *                           1.0 -> 0.5: holds 120 fps in a 3024x1964 race at
 *                           ~2.5 W less (energy per frame -17%); the image
 *                           difference is next to none (with ray tracing on,
 *                           this texture is only a blurred fallback).  Making
 *                           the cube/mirror smaller gave no further gain.
 *            HD_MIRROR=1024 mirror edge (pixels)
 *            HD_CUBE=512    cube face edge (pixels)
 *            HD_BLUR=0.5    road reflection blur: 1 = the game's own
 *                           width, 0 = sharp (see below)
 *
 * 2) ROAD REFLECTION BLUR
 *    The game blurs the reflection in two passes with ps 19 (13->14->13):
 *    4 samples, offsets fixed in UV relative to 320 pixels.  With the texture
 *    grown to 1920 the samples landed 6 pixels apart and a vertical stripe
 *    pattern appeared.  Fix: a mip chain on the reflection targets; the blur
 *    pass reads level L and scales the sample offsets about the center by
 *    s = 2^L / scale.  The sample spacing is then always ~1 texel:
 *      HD_BLUR=1 -> L = log2(scale), s = 1: the game's blur width
 *      HD_BLUR=0 -> L = 0, s = 1/scale: a thin blur at full resolution
 *
 * 3) MSAA (code in metal.m, "HD: MSAA for the screen")
 *    HD_MSAA=4 (default; 2/8 also work, 0/1 off).  Only the SCREEN passes
 *    are multisampled; each pass is resolved into the drawable with
 *    StoreAndMultisampleResolve.  A multisampled twin of Z is kept and its
 *    depth is also RESOLVED into the single-sample Z (HD_ZRESOLVE=0 turns
 *    that off): the game's depth-tested full-screen quad (ps 17 / vs 11, to
 *    a 1920x1080 target) has to see the scene's depth.  Without the resolve,
 *    ~11 draws per frame were measured doing a Z test on an offscreen target.
 *
 * 4) SSR + reflection separation (metal.m "HD: SSR", vsemu.c ps_to_msl_ex2,
 *    camera: overrides.c sub_005c7ec0).  HD_SSR=0 off, HD_SSR_DEBUG=1.
 *
 * 5) RAY-TRACED REFLECTION (metal.m "RT kernel" + "STATIC SCENE CACHE",
 *    the vsk_N compute kernel of vsemu.c vs_to_msl).  macOS 13+.
 *    For road and car pixels the reflection ray is cast into the real scene
 *    geometry; a hit is shaded with the game's own material (texture, vertex
 *    color, headlight term, fog, alpha test).  Miss -> the game's own reflection.
 *      HD_RT=0         off (falls back to SSR)
 *      HD_RT_SCALE=1..4 ray resolution divisor; if not given, AUTOMATIC (by
 *                      width: 1080p 2, 2560/3024 3, 4K 4)
 *      HD_RT_CACHE=0   turn the static scene cache off (behind the camera is lost)
 *      HD_RT_MAXD=600  ray range (world units ~ meters)
 *      HD_RT_LOD=0.05  texture mip by distance
 *      HD_RT_FIX=0     turn the vertex check off (triangles with NaN / infinite /
 *                      over-100-km vertices poison the acceleration structure)
 *    Diagnostics: HD_SSR_DEBUG=4 (reflection only), HD_RT_LOG=1/2,
 *    HD_RT_DUMPTAB=<frame>, HD_RT_STRESS=<N>, HD_RT_STAGE/NOTEX/PLAIN, HD_RTPROBE.
 *
 * 6) GPU BUDGET (metal.m "MSAA: needless store / resolve", "DEFER THE PASS
 *    THAT SPLITS THE SCENE").  5 multisampled screen passes per frame cut to 1.
 *      HD_MSLAZY=0     lazy store/resolve off (old behavior)
 *      HD_REORDER=0    intermediate-pass deferral off
 *    Measurement (both builds): GPUWIN=a,b  PASSPROF=N [PASSPROF_MODE=1]
 *    HD only: HD_COMP=0  HD_RT_AB=1.                                         */
#include "enhance.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <pthread.h>

#define RET_ROAD       0x005BA097u
#define RET_ROAD_BLUR  0x005BA10Du
#define RET_MIRROR     0x005BA1CDu
#define RET_CUBE       0x005BA549u

/* 0 = the target keeps the game's size.  Research build defaults: upstream's. */
static double g_road = NFS_ENHANCED ? 0.5 : 0.0, g_blur = 0.5;
static uint32_t g_mirror = NFS_ENHANCED ? 1024u : 0u, g_cube = NFS_ENHANCED ? 512u : 0u;
static int    g_msaa = NFS_ENHANCED ? 4 : 1, g_msaa_auto = NFS_ENHANCED, g_aniso = 0;
static uint32_t g_hits[4];
static uint32_t g_last_w[4], g_last_h[4];

static uint32_t clampu(double v){
    if (v < 16.0) return 16u;
    if (v > 8192.0) return 8192u;
    return (uint32_t)(v + 0.5);
}
static const char *opt(const char *name){
    const char *e = getenv(name);
    return (e && *e) ? e : NULL;
}
/* "1" is not off: it is a number (road_reflection = 1 is the full render size) */
static int is_off(const char *v){
    return !strcasecmp(v, "off") || !strcasecmp(v, "original") || !strcasecmp(v, "game") ||
           !strcmp(v, "0") || !strcasecmp(v, "no") || !strcasecmp(v, "false");
}
/* The values are the ones settings.ini accepts (bundle.m), so a value means the
 * same in the file and in the environment. */
/* msaa = off | 2 | 4 | auto (8 only in the research build); 1 sample is off */
static void opt_msaa(const char *v){
    if (!strcasecmp(v, "auto")){ g_msaa = 4; g_msaa_auto = 1; return; }
    if (is_off(v) || !strcmp(v, "1")){ g_msaa = 1; g_msaa_auto = 0; return; }
    int n = atoi(v);
    if (n == 2 || n == 4 || (NFS_ENHANCED && n == 8)){ g_msaa = n; g_msaa_auto = 0; return; }
    fprintf(stderr, "[gfx] msaa \"%s\" not one of off|2|4|auto, ignored\n", v);
}
/* mirror = original | high (1024) | <edge px> */
static void opt_mirror(const char *v){
    if (is_off(v)){ g_mirror = 0; return; }
    if (!strcasecmp(v, "high")){ g_mirror = 1024u; return; }
    double d = atof(v);
    if (d >= 64.0 && d <= 4096.0){ g_mirror = clampu(d); return; }
    fprintf(stderr, "[gfx] mirror \"%s\" not one of original|high|64..4096, ignored\n", v);
}
#if NFS_ENHANCED
/* road_reflection = original | high (0.5 x back buffer) | <factor>: research build only */
static void opt_road(const char *v){
    if (is_off(v)){ g_road = 0.0; return; }
    if (!strcasecmp(v, "high")){ g_road = 0.5; return; }
    double d = atof(v);
    if (d >= 0.1 && d <= 1.0){ g_road = d; return; }
    fprintf(stderr, "[gfx] road_reflection \"%s\" not one of original|high|0.1..1, ignored\n", v);
}
#endif
static void opt_aniso(const char *v){
    if (is_off(v)){ g_aniso = 0; return; }
    if (!strcasecmp(v, "anisotropic")){ g_aniso = 1; return; }
    fprintf(stderr, "[gfx] texture_filtering \"%s\" not one of game|anisotropic, ignored\n", v);
}

static void enh_init_once(void){
    const char *e;
#if NFS_ENHANCED
    /* research build: upstream's variables first */
    if ((e = opt("HDREFL")) && *e == '0'){ g_road = 0.0; g_mirror = 0; g_cube = 0; }
    else {
        if ((e = opt("HD_ROAD")))   g_road   = atof(e) > 0.0 ? atof(e) : 0.5;
        if ((e = opt("HD_MIRROR"))) g_mirror = clampu(atof(e));
        if ((e = opt("HD_CUBE")))   g_cube   = clampu(atof(e));
    }
    if ((e = opt("HD_MSAA"))){ int n = atoi(e); g_msaa_auto = 0;
        g_msaa = (n == 2 || n == 4 || n == 8) ? n : 1; }
#endif
    if ((e = opt("HD_BLUR"))) g_blur = atof(e);
    if (g_blur < 0.0) g_blur = 0.0;
    if (g_blur > 1.0) g_blur = 1.0;

    const char *km = opt("NFSU2_MSAA"), *ki = opt("NFSU2_MIRROR"),
               *kt = opt("NFSU2_TEXTURE_FILTERING"), *kg = opt("NFSU2_GRAPHICS");
#if NFS_ENHANCED
    const char *kr = opt("NFSU2_ROAD_REFLECTION");
#else
    const char *kr = NULL;
    if (opt("NFSU2_ROAD_REFLECTION"))
        fprintf(stderr, "[gfx] NFSU2_ROAD_REFLECTION ignored: the larger road reflection is only in the "
                        "research build (no improvement on the original look)\n");
#endif
    const char *preset = kg ? kg : (km || kr || ki || kt) ? "custom" : "original";
    if (strcasecmp(preset, "original") && strcasecmp(preset, "enhanced") && strcasecmp(preset, "custom")){
        fprintf(stderr, "[gfx] graphics \"%s\" not one of original|enhanced|custom: original\n", preset);
        preset = "original";
    }
    if (!strcasecmp(preset, "enhanced")){
        /* the recommended set */
        g_msaa = 4; g_msaa_auto = 1; g_mirror = 1024u; g_aniso = 1;
    }
    if (strcasecmp(preset, "original")){
        if (km) opt_msaa(km);
        if (ki) opt_mirror(ki);
#if NFS_ENHANCED
        if (kr) opt_road(kr);
#endif
        if (kt) opt_aniso(kt);
    } else if ((km && !is_off(km)) || (kr && !is_off(kr)) || (ki && !is_off(ki)) || (kt && !is_off(kt)))
        fprintf(stderr, "[gfx] graphics = original: msaa / mirror / texture_filtering ignored "
                        "(graphics = custom uses them)\n");
    if (NFS_ENHANCED || strcasecmp(preset, "original")){
        char ms[16], rd[80] = "";
        snprintf(ms, sizeof ms, g_msaa > 1 ? (g_msaa_auto ? "auto" : "%dx") : "off", g_msaa);
        if (NFS_ENHANCED && g_road > 0.0)
            snprintf(rd, sizeof rd, ", road reflection %.2fx back buffer (blur %.2f)", g_road, g_blur);
        else if (NFS_ENHANCED) snprintf(rd, sizeof rd, ", road reflection original");
        fprintf(stderr, "[gfx] graphics %s%s: msaa %s, mirror %s%u%s, texture filtering %s\n",
                NFS_ENHANCED ? "(research build, HD_* defaults) " : "", preset, ms,
                g_mirror ? "" : "original ", g_mirror ? g_mirror : 256u, rd, g_aniso ? "anisotropic" : "game");
    }
#if NFS_ENHANCED
    fprintf(stderr, "[HD] reflections: road=%.2fx back buffer  blur=%.2f  mirror=%u  cube=%u\n",
            g_road, g_blur, g_mirror, g_cube);
#endif
}
static void enh_init(void){
    static pthread_once_t once = PTHREAD_ONCE_INIT;
    pthread_once(&once, enh_init_once);
}

const char *enh_build_name(void){ return NFS_ENHANCED ? "HD" : "original"; }
float enh_blur(void){ enh_init(); return (float)g_blur; }
int   enh_aniso(void){ enh_init(); return g_aniso; }
int   enh_msaa_samples(int *autop){
    enh_init();
    if (autop) *autop = g_msaa > 1 && g_msaa_auto;
    return g_msaa;
}

int enh_rt_size(uint32_t ret, uint32_t bb_w, uint32_t bb_h,
                uint32_t *w, uint32_t *h){
    enh_init();
    int k, kind;
    uint32_t nw, nh;
    switch (ret){
    case RET_ROAD: case RET_ROAD_BLUR:
        /* Not the expected size (another version/patch): leave it alone. */
        if (g_road <= 0.0 || *w != 320u || *h != 240u) return ENH_NONE;
        k  = (ret == RET_ROAD) ? 0 : 1; kind = ENH_ROAD;
        nw = clampu(bb_w * g_road); nh = clampu(bb_h * g_road);
        break;
    case RET_MIRROR:
        if (!g_mirror || *w != 256u || *h != 256u) return ENH_NONE;
        k = 2; kind = ENH_MIRROR; nw = nh = g_mirror;
        break;
    case RET_CUBE:
        if (!g_cube || *w != 128u) return ENH_NONE;
        k = 3; kind = ENH_CUBE; nw = nh = g_cube;
        break;
    default:
        return ENH_NONE;
    }
    if (g_hits[k] < 3 || g_last_w[k] != nw || g_last_h[k] != nh){
        static const char *nm[4] = { "road reflection", "road blur",
                                     "rear-view mirror", "cube map" };
        fprintf(stderr, "[HD] %s %ux%u -> %ux%u\n", nm[k], *w, *h, nw, nh);
    }
    g_hits[k]++; g_last_w[k] = nw; g_last_h[k] = nh;
    *w = nw; *h = nh;
    return kind;
}

#if NFS_ENHANCED
/* Pass the main view's (id 1) matrices to Metal as frame data. */
void enh_view_setup(uint32_t id, const float *m, uint32_t cam){
    (void)cam;
    /* VIEWLOG=1: the view matrix (3x3 + position) of every view id, once
     * per id after its 4000th call.  For reading the axes of the cube face
     * cameras. */
    { static int vl = -1; static unsigned cnt[32]; static unsigned char done[32];
      if (vl < 0) vl = getenv("VIEWLOG") ? 1 : 0;
      if (vl && id < 32u && !done[id] && ++cnt[id] > 4000u){ done[id] = 1;
          fprintf(stderr, "[view %u] right=(%.3f %.3f %.3f) y=(%.3f %.3f %.3f) forward=(%.3f %.3f %.3f) P00=%.3f P11=%.3f\n",
                  id, m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10], m[16], m[21]); } }
    /* The cube map face cameras (views 16..21) are aligned NOT to the world
     * axes but to another frame (measured).  To turn the cube sampling vector
     * into world space, the face cameras' forward directions: cube +x = view 17,
     * +y = view 18, +z = view 21 (measured: right/back/up on the car;
     * confirmed with the HD_SSR_DEBUG=3 normal agreement test). */
    static float cube_b[9] = { 1,0,0, 0,1,0, 0,0,1 };
    if (id == 17u || id == 18u || id == 21u){
        int a = (id == 17u) ? 0 : (id == 18u) ? 1 : 2;
        cube_b[a*3] = m[2]; cube_b[a*3+1] = m[6]; cube_b[a*3+2] = m[10];
        return;
    }
    if (id != 1u) return;
    void metal_hd_set_camera(const float *m48, float k, const float *cube9);
    float com_aspfix(void);
    metal_hd_set_camera(m, com_aspfix(), cube_b);
}

#endif /* NFS_ENHANCED */

void enh_report(void){
    if (!g_hits[0] && !g_hits[1] && !g_hits[2] && !g_hits[3]) return;
    fprintf(stderr, "[HD] reflection targets: road=%u blur=%u mirror=%u cube=%u"
            " (last: road %ux%u, mirror %u, cube %u)\n",
            g_hits[0], g_hits[1], g_hits[2], g_hits[3],
            g_last_w[0], g_last_h[0], g_last_w[2], g_last_w[3]);
}
