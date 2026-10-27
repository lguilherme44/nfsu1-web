/* The DirectSound mixer for the browser: runtime/audio.m without CoreAudio.
 *
 * The game mixes everything itself into one looping DirectSound buffer (EA's
 * SND library); com.c's
 * DirectSound HLE registers that buffer here and the mixer below plays it:
 * the same slot table, the same mix_into (nearest-neighbour resampling), only
 * the output differs, and the playback rate: constant here, where audio.m's
 * write-position servo and SNDSYNC rate ratio made the music's pitch wander
 * (both stay behind SNDSERVO=1 / SNDSYNC=1, see mix_into).
 *
 * On the Mac a CoreAudio render callback pulled 512-frame slices.  Here a
 * dedicated "audio pump" pthread mixes 512-frame slices into a float32 ring
 * in shared memory (audio_proto.h) that the page's AudioWorklet drains, so
 * the mixer keeps its pthread mutex (a worklet may not block) and its
 * callback-sized steps (the servo's constants are per callback).  The pump
 * paces itself by the ring: it tops it up to the target fill and sleeps on
 * the worklet's read counter, which the worklet notifies every render
 * quantum.  That locks the play cursors to the output device clock, as the
 * AudioUnit callback did.
 *
 * The DirectSound play cursor must move in real time, always: if it stands
 * still the EA library tears its buffer down and recreates it (after ~100
 * polls; seen on the Mac: 120 buffers in 4 s, then a crash at 0x727030), and
 * the movie player takes its clock from it.  In a browser the output can be
 * missing or stop at any time: no page attached yet, an AudioContext that is
 * suspended until the first user gesture or later interrupted, a stalled
 * device, NOSOUND (settings: sound = off).  So whenever the worklet has not
 * consumed anything for STALL_MS, or the page reports a context that is not
 * running, the pump falls back to the wall clock: it keeps mixing slices at
 * 44.1 kHz real time and drops them.  Cursors keep moving; nothing is heard.
 *
 *   NOSOUND=1                 no output; the pump still runs (wall clock)
 *   SNDSYNC=1                 audio.m's rate ratio between game and real time
 *   SNDSERVO=1                audio.m's write-position servo (+-3 % trim)
 *   NFSU2_AUDIO_TARGET=<n>    ring fill in frames (default 1024 = 23 ms)
 *   NFSU2_AUDIO_STATUS=<s>    an "[audio]" status line every s seconds
 *                             (default 5 when NFSU2_STATUS_EVERY is set)
 *   SNDDUMP, SNDCSV, SNDSTAT, SNDGAP   the Mac's diagnostics, unchanged */
#include "cpu.h"                 /* g_mem: guest memory is linear memory from 0 */
#include "host_abi.h"
#include "audio_proto.h"
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <pthread.h>
#include <math.h>
#include <time.h>
#include <stdatomic.h>

uint64_t host_us(void);          /* the game's virtual clock (win32.c) */

static double mono_s(void){
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}
static int env_on(const char *n){ const char *e = getenv(n); return e && *e && *e != '0'; }

/* ---- rate ratio (SNDSYNC), as audio.m; off by default here ----------------
 * audio.m made consumption follow the game's virtual clock (never faster than
 * real time, cap 1.0) for a game that ran below 60 fps on a fixed 16.7 ms
 * clock.  With the real-time clock (win32.c VCLOCK) the ratio only moves when
 * a frame runs past the 50 ms clock cap, and then it bends the pitch: every
 * loading hitch slowed the music to ~0.65 for a second.  The game's writer
 * follows the play cursor (below), so nothing needs the ratio: SNDSYNC=1
 * brings it back. */
static double g_rate_ratio = 1.0;
static int    g_sync_mode = -1;
/* the status line's window: the playback rate's extremes since the last line */
static double g_win_rmin = 9.0, g_win_rmax = 0.0, g_win_tmin = 9.0, g_win_tmax = 0.0;
static double g_win_fmin = 9.0, g_win_fmax = 0.0; static uint64_t g_win_over = 0;
static int g_servo = 0;          /* SNDSERVO=1: audio.m's write-position trim */
static void update_rate_ratio(void){
    if (g_sync_mode < 0){
        const char *e = getenv("SNDSYNC");
        g_sync_mode = (e && *e) ? (*e != '0') : 0;
    }
    if (!g_sync_mode){ g_rate_ratio = 1.0; return; }
    static uint64_t lv = 0, lr = 0;
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    uint64_t rus = (uint64_t)ts.tv_sec*1000000ull + (uint64_t)ts.tv_nsec/1000ull;
    uint64_t vus = host_us();
    if (lv && rus > lr){
        double dv = (double)(vus - lv), dr = (double)(rus - lr);
        if (dr > 1000.0){
            double k = dv / dr;
            if (k < 0.25) k = 0.25;
            if (k > 1.00) k = 1.00;      /* never faster than real time */
            g_rate_ratio += (k - g_rate_ratio) * 0.10;
        }
    }
    lv = vus; lr = rus;
}

#define OUT_RATE   AUDIO_RATE
#define OUT_CH     2
#define FRAMES     2048          /* largest slice mix_into takes */
#define SLICE      512           /* frames per mix_into call: the Mac's AudioUnit slice */
#define STALL_MS   60.0          /* no consumption for this long: wall-clock pacing */
#define START_GRACE_S 0.25       /* ... except right after the consumer appeared */

#define MAXSND 128
typedef struct {
    uint32_t data, bytes, rate, chans, bits;
    int      used, playing, loop;
    double   cursor;          /* source frames */
    float    vol;             /* 0..1 */
    uint32_t wpos;            /* end of the last region the game wrote (Unlock) */
    int      wseen;
    double   trim;            /* servo rate correction */
    double   target;          /* fill fraction the servo locks to (adapts) */
    double   freq;            /* SetFrequency ratio */
    uint64_t plays, stops, wr_bytes, wr_calls, wr_nonzero;
    uint64_t over;            /* slices in which the cursor overtook the writer */
} SndBuf;

static SndBuf g_snd[MAXSND];
static int    g_sndn = 1;                    /* 0 = no slot */
static int    g_sndfree[MAXSND], g_nsndfree = 0;
static int snd_new_id(void){                  /* g_slock held */
    if (g_nsndfree) return g_sndfree[--g_nsndfree];
    return g_sndn < MAXSND ? g_sndn++ : 0;
}
static pthread_mutex_t g_slock = PTHREAD_MUTEX_INITIALIZER;
static int g_audio_on = 0;                   /* the output is wanted (not NOSOUND) */
static _Atomic int g_pump_started = 0;
static uint64_t g_mixed_frames = 0, g_active_peak = 0;
static uint64_t g_replay = 0, g_reissue = 0;
static uint64_t g_out_frames = 0, g_out_zero = 0, g_gap_cb = 0;

static FILE *g_dump = NULL;      /* SNDDUMP=<path>: raw s16le stereo */
static FILE *g_csv  = NULL;      /* SNDCSV=<path>: per-slice servo state */
static uint64_t g_cb_no = 0;
static int g_sndstat = 0, g_sndgap = 0;     /* read once, not per slice (audio.m did) */

static AudioRing g_ring __attribute__((aligned(64)));
#define RH(i) g_ring.h[i]

/* ---- the DirectSound side (com.c), unchanged from audio.m ---------------- */
int audio_register(uint32_t data, uint32_t bytes, uint32_t rate,
                   uint32_t chans, uint32_t bits){
    if (!data || !bytes) return 0;
    if (rate < 4000u || rate > 192000u) rate = 44100u;
    if (chans < 1u || chans > 2u) chans = 1u;
    if (bits != 8u && bits != 16u) bits = 16u;
    pthread_mutex_lock(&g_slock);
    int id = snd_new_id();
    if (id){
        SndBuf *b = &g_snd[id];
        b->data = data; b->bytes = bytes; b->rate = rate;
        b->chans = chans; b->bits = bits;
        b->used = 1; b->playing = 0; b->loop = 0; b->cursor = 0.0; b->vol = 1.f;
        b->wpos = 0; b->wseen = 0; b->trim = 1.0; b->target = 0.0; b->over = 0;
        b->freq = 1.0; b->plays = b->stops = 0;
        b->wr_bytes = b->wr_calls = b->wr_nonzero = 0;
        fprintf(stderr, "  [sound] buffer #%d: %u Hz, %u channels, %u bit, %u bytes (%.2f s)\n",
                id, rate, chans, bits, bytes,
                (double)bytes / (double)(rate * chans * (bits/8u)));
    }
    pthread_mutex_unlock(&g_slock);
    return id;
}
void audio_play(int id, int loop){
    if (id <= 0 || id >= MAXSND) return;
    pthread_mutex_lock(&g_slock);
    if (g_snd[id].used){
        /* a buffer that already plays keeps its cursor: the game re-issues
         * Play on its stream all the time */
        if (!g_snd[id].playing){ g_snd[id].cursor = 0.0; g_replay++; }
        else g_reissue++;
        g_snd[id].playing = 1;
        g_snd[id].loop = loop;
        g_snd[id].plays++;
    }
    pthread_mutex_unlock(&g_slock);
}
void audio_note_write(int id, uint32_t end_off){
    if (id <= 0 || id >= MAXSND) return;
    pthread_mutex_lock(&g_slock);
    if (g_snd[id].used && g_snd[id].bytes){
        g_snd[id].wpos = end_off % g_snd[id].bytes;
        g_snd[id].wseen = 1;
    }
    pthread_mutex_unlock(&g_slock);
}
void audio_note_write_stat(int id, uint32_t n, int nonzero){
    if (id <= 0 || id >= MAXSND) return;
    pthread_mutex_lock(&g_slock);
    if (g_snd[id].used){ g_snd[id].wr_calls++; g_snd[id].wr_bytes += n;
                         if (nonzero) g_snd[id].wr_nonzero++; }
    pthread_mutex_unlock(&g_slock);
}
void audio_set_freq(int id, uint32_t hz){
    if (id <= 0 || id >= MAXSND) return;
    pthread_mutex_lock(&g_slock);
    if (g_snd[id].used && g_snd[id].rate){
        if (!hz) g_snd[id].freq = 1.0;                      /* DSBFREQUENCY_ORIGINAL */
        else {
            double f = (double)hz / (double)g_snd[id].rate;
            if (f < 0.05) f = 0.05;
            if (f > 8.00) f = 8.00;
            g_snd[id].freq = f;
        }
    }
    pthread_mutex_unlock(&g_slock);
}
int audio_duplicate(int src){
    if (src <= 0 || src >= MAXSND) return 0;
    int id = 0;
    pthread_mutex_lock(&g_slock);
    if (g_snd[src].used && (id = snd_new_id()) != 0){
        g_snd[id] = g_snd[src];
        g_snd[id].playing = 0; g_snd[id].cursor = 0.0; g_snd[id].trim = 1.0;
        g_snd[id].target = 0.0; g_snd[id].over = 0;
        g_snd[id].plays = g_snd[id].stops = 0;
        g_snd[id].wr_bytes = g_snd[id].wr_calls = g_snd[id].wr_nonzero = 0;
    }
    pthread_mutex_unlock(&g_slock);
    return id;
}
/* com.c, last Release: the mixer holds g_slock while it reads guest PCM, so
 * once this returns the data can be freed. */
void audio_unregister(int id){
    if (id <= 0 || id >= MAXSND) return;
    pthread_mutex_lock(&g_slock);
    if (g_snd[id].used){
        g_snd[id].used = 0; g_snd[id].playing = 0; g_snd[id].data = 0;
        if (g_nsndfree < MAXSND) g_sndfree[g_nsndfree++] = id;
    }
    pthread_mutex_unlock(&g_slock);
}
void audio_stop(int id){
    if (id <= 0 || id >= MAXSND) return;
    pthread_mutex_lock(&g_slock);
    if (g_snd[id].used){ g_snd[id].playing = 0; g_snd[id].stops++; }
    pthread_mutex_unlock(&g_slock);
}
/* GetCurrentPosition: the play cursor and a write cursor 50 ms ahead of it
 * (equal cursors made the game write where we play). */
#define WRITE_LEAD_MS 50u
void audio_cursors(int id, uint32_t *play, uint32_t *write){
    uint32_t p = 0, w = 0;
    if (id > 0 && id < MAXSND){
        pthread_mutex_lock(&g_slock);
        if (g_snd[id].used && g_snd[id].bytes){
            uint32_t bpf = g_snd[id].chans * (g_snd[id].bits/8u);
            uint32_t sz  = g_snd[id].bytes;
            p = (uint32_t)(g_snd[id].cursor * (double)bpf) % sz;
            uint32_t lead = (g_snd[id].rate * WRITE_LEAD_MS / 1000u) * bpf;
            if (lead >= sz) lead = sz / 4u;
            w = (p + lead) % sz;
        }
        pthread_mutex_unlock(&g_slock);
    }
    if (play)  *play  = p;
    if (write) *write = w;
}
double audio_time(void){ return (double)g_mixed_frames / (double)OUT_RATE; }
uint32_t audio_cursor(int id){ uint32_t p; audio_cursors(id, &p, 0); return p; }
void audio_set_volume(int id, long millibel){
    if (id <= 0 || id >= MAXSND) return;
    float v = (millibel <= -10000L) ? 0.f : powf(10.f, (float)millibel / 2000.f);
    if (v > 1.f) v = 1.f;
    pthread_mutex_lock(&g_slock);
    if (g_snd[id].used) g_snd[id].vol = v;
    pthread_mutex_unlock(&g_slock);
}
/* win32_ext.c GetMessageA: while the game is parked its clock stands still
 * and nothing refills the stream, so the output is muted; the cursors keep
 * moving (see audio.m). */
static _Atomic int g_out_muted = 0;
void audio_set_muted(int on){
    if (atomic_exchange(&g_out_muted, on ? 1 : 0) != (on ? 1 : 0)){
        atomic_store(&RH(AR_MUTED), on ? 1u : 0u);
        fprintf(stderr, "sound: output %s\n", on ? "muted (game inactive)" : "unmuted");
    }
}

/* ---- the mixer: audio.m's mix_into, float output ------------------------ */
static void mix_into(float *out, unsigned frames){
    static float acc[FRAMES * OUT_CH];
    if (frames > FRAMES) frames = FRAMES;
    memset(acc, 0, sizeof(float) * frames * OUT_CH);
    uint64_t active = 0;
    update_rate_ratio();
    if (g_rate_ratio < g_win_rmin) g_win_rmin = g_rate_ratio;
    if (g_rate_ratio > g_win_rmax) g_win_rmax = g_rate_ratio;

    pthread_mutex_lock(&g_slock);
    for (int i = 1; i < g_sndn; i++){
        SndBuf *b = &g_snd[i];
        if (!b->used || !b->playing || !b->bytes) continue;
        uint32_t bps  = b->bits / 8u;
        uint32_t bpf  = b->chans * bps;
        if (!bpf) continue;
        uint32_t nsrc = b->bytes / bpf;
        if (!nsrc) continue;
        /* audio.m locks the play cursor to the game's write position (a
         * PLL, +-3 %) against a free-running cursor drifting through the
         * unwritten region.  The game's writer follows the play cursor
         * instead: a quick race at a constant 1.03 kept the same fill (0.31
         * to 0.38 of the buffer) as one at 1.00, no overruns either way.  The
         * trim had nothing to correct; its target lagged each change of the
         * game's fill level by ~15 s, so it sat at 1.03 or 0.97 for half a
         * minute at a time: the music's tempo and pitch wandered by a
         * semitone.  Off by default (SNDSERVO=1 turns it on); the fill and
         * the overrun count are still measured for the status line. */
        if (b->wseen){
            uint32_t pbyte = ((uint32_t)(b->cursor * (double)bpf)) % b->bytes;
            uint32_t avail = (b->wpos + b->bytes - pbyte) % b->bytes;
            double frac = (double)avail / (double)b->bytes;
            double want;
            if (frac < g_win_fmin) g_win_fmin = frac;
            if (frac > g_win_fmax) g_win_fmax = frac;
            if (frac > 0.85) g_win_over++;
            if (frac > 0.85){
                b->over++;                         /* the cursor overtook the writer */
                want = 0.94;
            } else {
                if (b->target <= 0.0) b->target = frac;
                else b->target += (frac - b->target) * 0.0008;
                if (b->target < 0.12) b->target = 0.12;
                if (b->target > 0.60) b->target = 0.60;
                want = 1.0 + (frac - b->target) * 1.5;
                if (want < 0.97) want = 0.97;
                if (want > 1.03) want = 1.03;
            }
            b->trim += (want - b->trim) * 0.05;
            if (!g_servo) b->trim = 1.0;
        } else b->trim += (1.0 - b->trim) * 0.08;
        if (b->trim < 0.5 || b->trim > 2.0) b->trim = 1.0;
        if (b->wseen){
            if (b->trim < g_win_tmin) g_win_tmin = b->trim;
            if (b->trim > g_win_tmax) g_win_tmax = b->trim;
        }
        if (g_csv){
            uint32_t pb = ((uint32_t)(b->cursor * (double)bpf)) % b->bytes;
            uint32_t av = b->wseen ? ((b->wpos + b->bytes - pb) % b->bytes) : 0u;
            fprintf(g_csv, "%llu,%.4f,%d,%u,%u,%u,%u,%u,%.4f,%.4f,%.4f,%.4f,",
                    (unsigned long long)g_cb_no,
                    (double)g_mixed_frames/(double)OUT_RATE, i, b->rate, b->bytes,
                    pb, b->wpos, av, (double)av/(double)b->bytes,
                    b->target, b->trim, g_rate_ratio);
        }
        double step = (double)b->rate / (double)OUT_RATE * g_rate_ratio * b->trim * b->freq;
        active++;
        for (unsigned f = 0; f < frames; f++){
            double sp = b->cursor + step * (double)f;
            if (sp >= (double)nsrc){
                if (b->loop) sp = fmod(sp, (double)nsrc);
                else { b->playing = 0; break; }
            }
            uint32_t si = (uint32_t)sp;
            for (int c = 0; c < OUT_CH; c++){
                uint32_t sc = (b->chans == 2u) ? (uint32_t)c : 0u;
                uint32_t off = b->data + si*bpf + sc*bps;
                float s;
                if (b->bits == 16u){
                    int16_t v; memcpy(&v, g_mem + off, 2);
                    s = (float)v / 32768.f;
                } else {
                    s = ((float)g_mem[off] - 128.f) / 128.f;
                }
                acc[f*OUT_CH + c] += s * b->vol;
            }
        }
        if (g_csv){
            uint32_t p0 = ((uint32_t)(b->cursor * (double)bpf)) % b->bytes;
            uint32_t nby = (uint32_t)(step * (double)frames * (double)bpf);
            if (nby > b->bytes) nby = b->bytes;
            uint32_t z = 0;
            for (uint32_t q = 0; q < nby; q++)
                if (!g_mem[b->data + ((p0 + q) % b->bytes)]) z++;
            fprintf(g_csv, "%.4f\n", nby ? (double)z/(double)nby : 0.0);
        }
        b->cursor += step * (double)frames;
        if (b->cursor >= (double)nsrc){
            if (b->loop) b->cursor = fmod(b->cursor, (double)nsrc);
            else { b->cursor = 0.0; b->playing = 0; }
        }
    }
    pthread_mutex_unlock(&g_slock);
    if (active > g_active_peak) g_active_peak = active;
    g_mixed_frames += frames;
    if (g_sndstat){
        static uint64_t next = 0;
        if (g_mixed_frames >= next){
            next = g_mixed_frames + (uint64_t)OUT_RATE * 2ull;
            pthread_mutex_lock(&g_slock);
            fprintf(stderr, "  [state] ");
            for (int i2 = 1; i2 < g_sndn; i2++){
                if (!g_snd[i2].used) continue;
                uint32_t nz = 0, lim = g_snd[i2].bytes < 8192u ? g_snd[i2].bytes : 8192u;
                for (uint32_t q = 0; q < lim; q++) if (g_mem[g_snd[i2].data + q]) nz++;
                fprintf(stderr, "#%d[%s%s %uHz data=%u%%] ", i2,
                        g_snd[i2].playing ? "play" : "stop",
                        g_snd[i2].loop ? "+loop" : "",
                        g_snd[i2].rate, lim ? (unsigned)(100u*nz/lim) : 0u);
            }
            fprintf(stderr, "\n");
            pthread_mutex_unlock(&g_slock);
        }
    }
    /* silent data while something plays = a region the game has not written */
    if (active){
        unsigned zero = 0;
        for (unsigned k = 0; k < frames * OUT_CH; k++) if (acc[k] == 0.f) zero++;
        g_out_frames += frames * OUT_CH;
        g_out_zero   += zero;
        if (zero > (frames * OUT_CH) * 3u / 4u){
            g_gap_cb++;
            static int shown = 0;
            if (g_sndgap && shown < 40 && g_mixed_frames > (uint64_t)OUT_RATE * 5ull){ shown++;
                fprintf(stderr, "  [gap] t=%.2f s\n", (double)g_mixed_frames / (double)OUT_RATE); }
        }
    }
    int muted = atomic_load(&g_out_muted);
    for (unsigned k = 0; k < frames * OUT_CH; k++){
        float v = muted ? 0.f : acc[k];
        if (v >  1.f) v =  1.f;
        if (v < -1.f) v = -1.f;
        out[k] = v;
    }
    g_cb_no++;
    if (g_dump){
        int16_t s16[FRAMES * OUT_CH];
        for (unsigned k = 0; k < frames * OUT_CH; k++) s16[k] = (int16_t)(out[k] * 32767.f);
        fwrite(s16, sizeof(int16_t), (size_t)frames * OUT_CH, g_dump);
    }
}

/* ---- output statistics: what goes to the ring --------------------------- */
static struct {
    double sumsq; float peak; uint64_t n;            /* the current one-second window */
    float last_peak, last_rms;                       /* the last complete window */
    uint64_t slices, loud_slices;                    /* slices with any sample above 1 LSB */
    float max_peak;                                  /* over the whole run */
} g_st;
static void stats_add(const float *o, unsigned frames){
    float pk = 0.f; double ss = 0.0;
    for (unsigned k = 0; k < frames * OUT_CH; k++){ float a = fabsf(o[k]); if (a > pk) pk = a; ss += (double)o[k] * o[k]; }
    g_st.slices++;
    if (pk > 1.f / 32768.f) g_st.loud_slices++;
    if (pk > g_st.peak) g_st.peak = pk;
    if (pk > g_st.max_peak) g_st.max_peak = pk;
    g_st.sumsq += ss; g_st.n += frames * OUT_CH;
    if (g_st.n >= (uint64_t)OUT_RATE * OUT_CH){
        g_st.last_peak = g_st.peak;
        g_st.last_rms = (float)sqrt(g_st.sumsq / (double)g_st.n);
        atomic_store(&RH(AR_PEAK), (uint32_t)(g_st.last_peak * 65536.f));
        atomic_store(&RH(AR_RMS), (uint32_t)(g_st.last_rms * 65536.f));
        g_st.peak = 0.f; g_st.sumsq = 0.0; g_st.n = 0;
    }
}
static double dbfs(float v){ return v > 1e-7f ? 20.0 * log10((double)v) : -140.0; }

/* ---- the pump -------------------------------------------------------------- */
static uint64_t g_ring_frames = 0, g_wall_frames = 0;
static double   g_mix_s = 0.0, g_mix_max_s = 0.0;   /* time inside mix_into: total, longest slice */
static void mix_timed(float *out, unsigned frames){
    double t = mono_s();
    mix_into(out, frames);
    t = mono_s() - t;
    g_mix_s += t; if (t > g_mix_max_s) g_mix_max_s = t;
}
static uint64_t g_to_wall = 0, g_to_ring = 0, g_target_raised = 0;
static double   g_wall_s = 0.0, g_pump_t0 = 0.0, g_ring_s0 = 0.0;
static unsigned g_target = 1024;
static double   g_status_every = 0.0;

static void status_line(double now, int mode){
    uint32_t w = atomic_load(&RH(AR_W)), r = atomic_load(&RH(AR_R));
    char cur[160] = ""; int cl = 0;
    pthread_mutex_lock(&g_slock);
    for (int i = 1; i < g_sndn && cl < (int)sizeof cur - 32; i++)
        if (g_snd[i].used && g_snd[i].playing){
            uint32_t bpf = g_snd[i].chans * (g_snd[i].bits / 8u);
            cl += snprintf(cur + cl, sizeof cur - (size_t)cl, " #%d@%u", i,
                           (uint32_t)(g_snd[i].cursor * (double)bpf) % (g_snd[i].bytes ? g_snd[i].bytes : 1u));
        }
    pthread_mutex_unlock(&g_slock);
    static const char *const ctxn[] = { "none", "running", "suspended", "closed" };
    uint32_t ctx = atomic_load(&RH(AR_CTX));
    static double last_t = 0, last_mix = 0;
    double el = now - (last_t ? last_t : g_pump_t0), cpu = el > 0 ? (g_mix_s - last_mix) / el * 100.0 : 0.0;
    last_t = now; last_mix = g_mix_s;
    fprintf(stderr, "[audio] t=%.1fs mode=%s ctx=%s fill=%u target=%u mixed=%.1fs wall=%.1fs mixcpu=%.2f%% peak=%.1fdBFS rms=%.1fdBFS"
            " loud=%.0f%% underruns=%u worklet_loud=%u muted=%d ratio=%.3f..%.3f trim=%.3f..%.3f frac=%.2f..%.2f over=%llu play:%s\n",
            now - g_pump_t0, mode == AR_MODE_RING ? "ring" : mode == AR_MODE_WALL ? "wall" : "idle",
            ctx < 4 ? ctxn[ctx] : "?", w - r, g_target, (double)g_mixed_frames / OUT_RATE, g_wall_s, cpu,
            dbfs(g_st.last_peak), dbfs(g_st.last_rms),
            g_st.slices ? 100.0 * (double)g_st.loud_slices / (double)g_st.slices : 0.0,
            atomic_load(&RH(AR_UNDERRUNS)), atomic_load(&RH(AR_LOUD)), atomic_load(&g_out_muted),
            g_win_rmin > g_win_rmax ? 1.0 : g_win_rmin, g_win_rmin > g_win_rmax ? 1.0 : g_win_rmax,
            g_win_tmin > g_win_tmax ? 1.0 : g_win_tmin, g_win_tmin > g_win_tmax ? 1.0 : g_win_tmax,
            g_win_fmin > g_win_fmax ? 0.0 : g_win_fmin, g_win_fmin > g_win_fmax ? 0.0 : g_win_fmax,
            (unsigned long long)g_win_over, cl ? cur : " -");
    g_win_rmin = g_win_tmin = g_win_fmin = 9.0; g_win_rmax = g_win_tmax = g_win_fmax = 0.0; g_win_over = 0;
}

/* wait until *addr != expect or the timeout: the worklet notifies AR_R */
static void wait_word(_Atomic uint32_t *addr, uint32_t expect, double max_s){
    if (max_s <= 0) return;
    __builtin_wasm_memory_atomic_wait32((int32_t *)addr, (int32_t)expect, (int64_t)(max_s * 1e9));
}

static void *pump_main(void *unused){
    (void)unused;
    static float scratch[SLICE * OUT_CH];
    int mode = AR_MODE_IDLE;
    double now = mono_s();
    g_pump_t0 = now;
    double t_r = now, wall_t0 = now, next_status = now + g_status_every;
    uint64_t wall_done = 0;
    uint32_t r_seen = atomic_load(&RH(AR_R)), under_seen = 0;
    for (;;){
        now = mono_s();
        if (g_status_every > 0 && now >= next_status){ status_line(now, mode); next_status = now + g_status_every; }
        uint32_t r = atomic_load(&RH(AR_R)), w = atomic_load(&RH(AR_W));
        if (r != r_seen){ r_seen = r; t_r = now; }
        uint32_t fill = w - r;
        if (fill > AUDIO_RING_FRAMES) fill = AUDIO_RING_FRAMES;     /* never: one producer, one consumer */
        int running = atomic_load(&RH(AR_CTX)) == AR_CTX_RUNNING;
        /* the worklet is consuming: it moved r recently, or the ring has
         * room it has not been asked to drain yet */
        int consumer = g_audio_on && running && ((now - t_r) * 1000.0 < STALL_MS || fill + SLICE <= g_target);
        if (consumer){
            if (mode != AR_MODE_RING){
                if (mode == AR_MODE_WALL) g_to_ring++;
                fprintf(stderr, "sound: output paced by the AudioWorklet (ring %u frames, target %u = %.1f ms)\n",
                        AUDIO_RING_FRAMES, g_target, g_target * 1000.0 / OUT_RATE);
                mode = AR_MODE_RING; atomic_store(&RH(AR_MODE), AR_MODE_RING);
                g_ring_s0 = now; under_seen = atomic_load(&RH(AR_UNDERRUNS));
                /* a worklet that was just connected takes a moment to run
                 * its first quantum: do not call that a stall */
                t_r = now + START_GRACE_S;
            }
            /* underruns once the output has settled: keep more in the ring */
            uint32_t un = atomic_load(&RH(AR_UNDERRUNS));
            if (un != under_seen){
                if (now - g_ring_s0 > 1.0 && g_target + SLICE <= 4096u){
                    g_target += SLICE; g_target_raised++;
                    atomic_store(&RH(AR_TARGET), g_target);
                    fprintf(stderr, "sound: worklet underrun (%u so far): ring target raised to %u frames (%.1f ms)\n",
                            un, g_target, g_target * 1000.0 / OUT_RATE);
                }
                under_seen = un;
            }
            if (fill + SLICE <= g_target){
                float *dst = &g_ring.pcm[(w & (AUDIO_RING_FRAMES - 1u)) * OUT_CH];
                /* SLICE divides the ring size: a slice never wraps */
                mix_timed(dst, SLICE);
                stats_add(dst, SLICE);
                atomic_store(&RH(AR_W), w + SLICE);
                atomic_store(&RH(AR_MIXED), (uint32_t)g_mixed_frames);
                g_ring_frames += SLICE;
                continue;
            }
            wait_word(&RH(AR_R), r, 0.004);
            continue;
        }
        /* no consumer: keep the cursors moving on the wall clock */
        if (mode != AR_MODE_WALL){
            if (mode == AR_MODE_RING) g_to_wall++;
            fprintf(stderr, "sound: %s: the mixer runs on the wall clock (DirectSound cursors keep moving, output dropped)\n",
                    !g_audio_on ? "sound is off (NOSOUND)" : !running ? "no running AudioContext" : "the AudioWorklet stopped consuming");
            mode = AR_MODE_WALL; atomic_store(&RH(AR_MODE), AR_MODE_WALL);
            wall_t0 = now; wall_done = 0;
        }
        double due = (now - wall_t0) * OUT_RATE - (double)wall_done;
        if (due > OUT_RATE * 0.1){             /* the pump was starved: do not burst-mix the backlog */
            wall_done = (uint64_t)((now - wall_t0) * OUT_RATE) - SLICE;
            due = SLICE;
        }
        if (due >= SLICE){
            mix_timed(scratch, SLICE);
            stats_add(scratch, SLICE);
            wall_done += SLICE; g_wall_frames += SLICE;
            g_wall_s = (double)g_wall_frames / OUT_RATE;
            atomic_store(&RH(AR_WALL_MS), (uint32_t)(g_wall_s * 1000.0));
            atomic_store(&RH(AR_MIXED), (uint32_t)g_mixed_frames);
            continue;
        }
        double sleep_s = (SLICE - due) / OUT_RATE;
        if (sleep_s > 0.005) sleep_s = 0.005;     /* notice a consumer coming back */
        wait_word(&RH(AR_R), r, sleep_s);
    }
    return 0;
}

void audio_init(void){
    if (atomic_exchange(&g_pump_started, 1)) return;
    g_audio_on = !env_on("NOSOUND");
    g_sndstat = getenv("SNDSTAT") != NULL;
    g_sndgap = getenv("SNDGAP") != NULL;
    g_servo = env_on("SNDSERVO");
    { const char *e = getenv("NFSU2_AUDIO_TARGET"); int t = e && *e ? atoi(e) : 0;
      if (t >= SLICE && t <= 4096) g_target = (unsigned)t; }   /* any size: a slice is mixed when fill + SLICE <= target */
    { const char *e = getenv("NFSU2_AUDIO_STATUS");
      if (e && *e) g_status_every = atof(e);
      else if (getenv("NFSU2_STATUS_EVERY")) g_status_every = 5.0; }
    { const char *d = getenv("SNDDUMP");
      if (d && *d){ g_dump = fopen(d, "wb");
          fprintf(stderr, "sound: output dump -> %s (%d Hz s16le %d channels)\n", d, OUT_RATE, OUT_CH); } }
    { const char *d = getenv("SNDCSV");
      if (d && *d){ g_csv = fopen(d, "w");
          if (g_csv) fprintf(g_csv, "cb,t,id,rate,bytes,pbyte,wpos,avail,frac,target,trim,ratio,zero\n"); } }
    RH(AR_MAGIC) = AUDIO_MAGIC; RH(AR_VERSION) = AUDIO_VERSION;
    RH(AR_FRAMES) = AUDIO_RING_FRAMES; RH(AR_RATE) = OUT_RATE;
    RH(AR_TARGET) = g_target; RH(AR_NOSOUND) = g_audio_on ? 0u : 1u;
    nfsu2_register(HOST_KIND_AUDIO, &g_ring, (uint32_t)sizeof g_ring);
    pthread_attr_t at; pthread_attr_init(&at);
    pthread_attr_setstacksize(&at, 256u * 1024u);
    pthread_t th;
    if (pthread_create(&th, &at, pump_main, 0) != 0){
        fprintf(stderr, "sound: the audio pump thread could not start: the DirectSound cursors stand still\n");
        return;
    }
    pthread_detach(th);
    fprintf(stderr, "sound: %s (audio pump thread, %d Hz float stereo ring at 0x%08x, %u frames)\n",
            g_audio_on ? "Web Audio output open" : "sound OFF (NOSOUND), the mixer still runs",
            OUT_RATE, (unsigned)(uintptr_t)&g_ring, AUDIO_RING_FRAMES);
}

/* autotest "audioreset" (on the Mac: the CoreAudio device-change path).  The
 * browser follows the default output device by itself; here the page is
 * asked to rebuild its AudioContext, which exercises the stall fallback. */
static uint64_t g_dev_changes = 0;
void audio_device_changed(const char *why){
    g_dev_changes++;
    atomic_fetch_add(&RH(AR_RESET), 1u);
    fprintf(stderr, "sound: output reset requested (%s): the page rebuilds its AudioContext\n", why);
}

void audio_report(void){
    if (g_dump){ fflush(g_dump); fclose(g_dump); g_dump = NULL; }
    if (g_csv){  fflush(g_csv);  fclose(g_csv);  g_csv  = NULL; }
    fprintf(stderr, "  sound output      : %s, %llu frames mixed, "
            "at most %llu buffers at once, %d registered\n",
            g_audio_on ? "on" : "OFF",
            (unsigned long long)g_mixed_frames,
            (unsigned long long)g_active_peak, g_sndn - 1);
    fprintf(stderr, "  sound Play calls  : %llu started from the top, %llu were already playing\n",
            (unsigned long long)g_replay, (unsigned long long)g_reissue);
    fprintf(stderr, "  sound rate ratio : %.3f (game virtual time / real time)%s\n",
            g_rate_ratio, g_sync_mode ? "" : "  [off; SNDSYNC=1 turns it on]");
    fprintf(stderr, "  sound data gaps   : %.1f%% of samples silent, %llu callbacks mostly empty\n",
            g_out_frames ? 100.0*(double)g_out_zero/(double)g_out_frames : 0.0,
            (unsigned long long)g_gap_cb);
    fprintf(stderr, "  --- per sound buffer ---\n");
    for (int i = 1; i < g_sndn; i++){
        SndBuf *b = &g_snd[i];
        if (!b->used) continue;
        fprintf(stderr, "   #%-3d %6u Hz %uch %5.2f s   Play=%-4llu Stop=%-4llu  "
                "writes=%llu (%llu non-empty, %.1f KB)  %s\n",
                i, b->rate, b->chans,
                (double)b->bytes/(double)(b->rate*b->chans*(b->bits/8u)),
                (unsigned long long)b->plays, (unsigned long long)b->stops,
                (unsigned long long)b->wr_calls, (unsigned long long)b->wr_nonzero,
                b->wr_bytes/1024.0, b->playing ? "PLAYING" : "stopped");
    }
    { uint64_t ov = 0; for (int i = 1; i < g_sndn; i++) ov += g_snd[i].over;
      fprintf(stderr, "  sound cursor overrun: in %llu callbacks the play cursor passed the writer\n",
              (unsigned long long)ov); }
    fprintf(stderr, "  sound output path : AudioWorklet ring, %u-frame slices, target %u frames (%.1f ms), "
            "%u underruns, target grew %llu times\n",
            SLICE, g_target, g_target * 1000.0 / OUT_RATE, atomic_load(&RH(AR_UNDERRUNS)),
            (unsigned long long)g_target_raised);
    fprintf(stderr, "  sound clock backup: %.1f s on the ring, %.1f s on the wall clock (no output), %llu times ring->wall, %llu times wall->ring\n",
            (double)g_ring_frames / OUT_RATE, g_wall_s, (unsigned long long)g_to_wall, (unsigned long long)g_to_ring);
    fprintf(stderr, "  sound mixer       : %.3f s in total (%.2f%% of the mixed time), longest slice %.3f ms\n",
            g_mix_s, g_mixed_frames ? 100.0 * g_mix_s / ((double)g_mixed_frames / OUT_RATE) : 0.0, g_mix_max_s * 1000.0);
    fprintf(stderr, "  sound output level: peak %.1f dBFS, %.1f%% of slices not silent, worklet %u non-silent quanta\n",
            dbfs(g_st.max_peak), g_st.slices ? 100.0 * (double)g_st.loud_slices / (double)g_st.slices : 0.0,
            atomic_load(&RH(AR_LOUD)));
    fprintf(stderr, "  sound output device: %llu reset requests (the browser follows the default device)\n",
            (unsigned long long)g_dev_changes);
}
