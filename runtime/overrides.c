/*
 * overrides.c - guest functions replaced by hand-written C for NFSU1.
 */
#include "cpu.h"
#include <string.h>
#include <stdio.h>
#include <time.h>

#include "widescreen.h"           /* HOOK_SITE */

/* web/gen.sh lifts every sub_00xxxxxx defined in this file as sub_00xxxxxx_orig
 * (OVERRIDE) and puts a guest_hook before every HOOK_SITE here (HOOKS): this
 * file is NFS Underground's whole list (tools/genstamp.sh). */

void guest_wait_begin(void);
void guest_wait_end(void);
void sub_00412fb0_orig(CPU *restrict c);
void sub_00410a00_orig(CPU *restrict c);

void overrides_install(void) {
    /* NFSU1 graphics resolution support table:
     * 0x71b7b0 holds support flags for the 5 standard modes:
     * [0] 640x480, [1] 800x600, [2] 1024x768, [3] 1280x960, [4] 1280x1024.
     * Initializing these prevents sub_00410a00 from infinitely looping if
     * early device initialization runs before EnumAdapterModes. */
    if (mem_is_committed(0x0071b7b0u)) {
        MR32(0x0071b7b0u) = 1;
        MR32(0x0071b7b4u) = 1;
        MR32(0x0071b7b8u) = 1;
        MR32(0x0071b7bcu) = 1;
        MR32(0x0071b7c0u) = 1;
    }
}

void overrides_report(void) {
}

void d3dx_hle_install(void) {
}

void d3dx_hle_report(void) {
}

/* 0x00643A39 (SPEED 1.4): Cyrix CPU detection probe.
 * x86 instructions probe Cyrix-specific flags behavior across DIV.
 * Intel/AMD CPUs leave flags as undefined, probe returns 0 (not Cyrix).
 * The lifted emulation returns 0. */
void sub_00643a39(CPU *c) {
    c->eax = 0;
    POP32(c->eip);
}

/* 0x00672630: CRT memcpy / memmove(dst, src, n) (cdecl, returns dst).
 * In x86 cdecl: arguments are at esp+4, esp+8, esp+12.
 * Stack layout on function entry:
 *   [esp + 0] = return address
 *   [esp + 4] = dst
 *   [esp + 8] = src
 *   [esp + 12] = n
 * Returns dst in eax, pops return address into eip. */
void sub_00672630(CPU *c) {
    uint32_t dst = MR32(c->esp + 4);
    uint32_t src = MR32(c->esp + 8);
    uint32_t n = MR32(c->esp + 12);
    if (n) {
        memmove((void *)(GMEM_ + dst), (const void *)(GMEM_ + src), n);
    }
    c->eax = dst;
    POP32(c->eip);
}

/* 0x00678d30: CRT memcpy / memmove(dst, src, n) (cdecl, returns dst).
 * Same CRT routine at second location in Speed.exe. */
void sub_00678d30(CPU *c) {
    uint32_t dst = MR32(c->esp + 4);
    uint32_t src = MR32(c->esp + 8);
    uint32_t n = MR32(c->esp + 12);
    if (n) {
        memmove((void *)(GMEM_ + dst), (const void *)(GMEM_ + src), n);
    }
    c->eax = dst;
    POP32(c->eip);
}

/* 0x00412fb0: Stream completion check.
 * Yields the GIL when waiting so worker threads can stream audio/video data. */
void sub_00412fb0(CPU *restrict c) {
    sub_00412fb0_orig(c);
    if (c->eax == 0) {
        guest_wait_begin();
        struct timespec ts = {0, 250000L}; /* 250 us */
        nanosleep(&ts, 0);
        guest_wait_end();
    }
}

/* 0x00410a00: picks the display mode row [0x700e70] among the five of the
 * support table 0x71b7b0 (overrides_install).  The game can reach it with
 * the table still all zero (before EnumAdapterModes filled it); then every
 * row counts as supported, as in overrides_install. */
void sub_00410a00(CPU *restrict c) {
    if (!MR32(0x0071b7b0u)) {
        MR32(0x0071b7b0u) = 1; MR32(0x0071b7b4u) = 1; MR32(0x0071b7b8u) = 1;
        MR32(0x0071b7bcu) = 1; MR32(0x0071b7c0u) = 1;
    }
    sub_00410a00_orig(c);
}

/* Hooks (guest_hook, debug.c).  0x00410e40 is the "inc eax" of 0x410a00's
 * search for a supported row: "mov ecx,[eax*4+0x71b7b0]; ...; inc eax; jns"
 * walks up to INT32_MAX, far past the five rows.  From row 4 on, eax goes to
 * INT32_MAX: the inc makes it negative and the jns leaves, so the search reads
 * rows 0..4 only. */
int nfsu1_hook(CPU *c, uint32_t ip) {
    switch (ip) {
    case HOOK_SITE(0x00410e40):
        if ((int32_t)c->eax >= 4) c->eax = 0x7fffffffu;
        return 1;
    }
    return 0;
}
