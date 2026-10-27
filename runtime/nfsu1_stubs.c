/*
 * nfsu1_stubs.c - Stubs for NFSU2-specific hooks and optional debug features
 * allowing the clean generic runtime to link for NFSU1.
 */
#include <stdint.h>
#include <stddef.h>
#include "module.h"

// server.dll import tables (none in NFSU1)
uint32_t g_srv_imp_count = 0;
const void *g_srv_imp = 0;
const ModInfo g_srv_modinfo = { .name = "" };
const uint32_t g_srv_fn_addr[1] = { 0 };
const mod_fn g_srv_fn_ptr[1] = { 0 };
const uint32_t g_srv_fn_count = 0;

// autotest command hooks
uint32_t autopilot_vehicle(void) { return 0; }
int career_cmd(int a, int b, int c) { (void)a; (void)b; (void)c; return 0; }
int career_is_cmd(const char *cmd) { (void)cmd; return 0; }
int roam_cmd(int a, int b, int c) { (void)a; (void)b; (void)c; return 0; }

// com / d3d / efx stats
int g_dx_in_pass = 0;
void guest_cpu_mark(void) {}
uint32_t g_fe_mgr = 0;
uint32_t g_efx_stat = 0;
uint32_t g_fx_epoch = 0;
void efx_stat_note(uint32_t a, uint32_t b) { (void)a; (void)b; }

// roam / mprace hooks
void roam_game_parked(int a) { (void)a; }
int mprace_owns_input(void) { return 0; }

// language / online filter stubs
int language_registry(void) { return 0; }
void olfilter_lobby_mark(int a, int b, int c) { (void)a; (void)b; (void)c; }
void olfilter_lobby_sent(int a, int b, int c) { (void)a; (void)b; (void)c; }
void online_lobby_read(int a, int b, int c) { (void)a; (void)b; (void)c; }
