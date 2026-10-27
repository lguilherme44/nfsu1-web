/* input_unit.c -- the autotest's ns* key driver without a page
 * (runtime/web/input_web.c, cs_key: what the suite runner's headless page
 * uses) against the page's own path (web/src/input: synth.ts's synthetic
 * KeyboardEvent, then index.ts / keymap.ts keyChars and keyVk), key by key.
 *
 * Built for wasm with the game's flags and run under node by
 * web/test/input-chars.test.mjs, which computes the page's side.  This file
 * includes input_web.c itself, so the driver's static functions are reached
 * as they are (no test hooks in the runtime), and stands in for the rest of
 * the runtime the file calls.  For every key with a DOM code, with Caps Lock
 * off and on, and with every combination of Shift, Ctrl and Alt (Option) the
 * scripts can hold ("nstap opt+shift+1"), and with Cmd, it prints the
 * key-down record the driver writes into the event ring (none with Cmd: the
 * browser's shortcut):
 *   K <dik> <mods> <caps> <vk> <flags> <nch> <ch0> <ch1> <ch2> <sys> */
#include "../../runtime/web/input_web.c"

/* ---- the rest of the runtime, as far as input_web.c calls it ---------------- */
void kbd_set_key(int src, unsigned dik, int down){ (void)src; (void)dik; (void)down; }
void kbd_release_source(int src){ (void)src; }
void kbd_post(uint32_t msg, uint32_t wp, uint32_t lp){ (void)msg; (void)wp; (void)lp; }
void kbd_post_mousemove(uint32_t wp, uint32_t lp){ (void)wp; (void)lp; }
int kbd_log(void){ return 0; }
const char *kbd_msg_name(uint32_t msg){ (void)msg; return "?"; }
int kbd_key_down(unsigned dik){ (void)dik; return 0; }
void lifecycle_set_active(int on, const char *why){ (void)on; (void)why; }
void lifecycle_request_quit(const char *why){ (void)why; }
int lifecycle_quit_requested(void){ return 0; }
int lifecycle_game_parked(void){ return 0; }
void lifecycle_tick(void){ }
int lifecycle_drain_writes(double max_s){ (void)max_s; return 0; }
int win32_freeze_guest(int max_ms){ (void)max_ms; return 0; }
void metal_game_size(unsigned *w, unsigned *h){ *w = 1280; *h = 720; }
long metal_frames(void){ return 0; }
void (*g_report_fn)(void);

int main(void){
    static const unsigned MODS[] = { 0, ISYN_SHIFT, ISYN_CTRL, ISYN_ALT, ISYN_SHIFT | ISYN_CTRL, ISYN_SHIFT | ISYN_ALT,
                                     ISYN_CTRL | ISYN_ALT, ISYN_SHIFT | ISYN_CTRL | ISYN_ALT, ISYN_META, ISYN_META | ISYN_SHIFT };
    int n = 0;
    for (int caps = 0; caps < 2; caps++){
        if (caps != cs_caps){                                   /* "nstap CAPSLOCK": one toggle (macOS) */
            SynReq q; memset(&q, 0, sizeof q); q.type = KSYN_DOWN; q.dik = DIK_CAPITAL; cs_handle(&q);
            q.type = KSYN_UP; cs_handle(&q);
        }
        for (unsigned dik = 1; dik < 256; dik++){
            if (!DK[dik].vk || is_mod_dik(dik)) continue;
            for (unsigned m = 0; m < sizeof MODS / sizeof MODS[0]; m++){
                uint32_t w0 = atomic_load(&MH(IM_EV_W));
                SynReq q; memset(&q, 0, sizeof q); q.type = KSYN_DOWN; q.dik = (uint8_t)dik; q.mods = (uint8_t)MODS[m];
                cs_handle(&q);
                q.type = KSYN_UP; cs_handle(&q);
                uint32_t w1 = atomic_load(&MH(IM_EV_W));
                for (uint32_t i = w0; i != w1; i++){
                    const InEv *e = &g_mb.ev[i & (INPUT_EV_N - 1u)];
                    if (e->type != IEV_KEY_DOWN || e->dik != dik) continue;
                    printf("K %u %u %d %u %u %u %u %u %u %d\n", dik, MODS[m], caps, e->vk, e->flags, e->nch,
                           e->ch[0], e->ch[1], e->ch[2], (int)e->b);
                    n++;
                }
                atomic_store(&MH(IM_EV_R), w1);                 /* the input thread's part: consumed */
            }
        }
    }
    printf("input_unit: %d key-down records\n", n);
    return 0;
}
