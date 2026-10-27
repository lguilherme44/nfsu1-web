/* roam_plat.h -- free-roam multiplayer: the platform layer under the core
 * (roam_core.h).  macOS: roam_bsd.c (BSD sockets, pthreads).
 *
 * One UDP socket per instance.  A network thread receives, feeds the session
 * and runs its timers; the game thread pushes the local state and reads the
 * remote poses.  Both hold roam_plat_lock() around every session call.
 *
 * Test-harness guard (fail closed): in test mode the socket is bound to
 * 127.0.0.1, every destination outside 127/8 and every broadcast is refused
 * before it reaches the kernel and logged as "[roam] BLOCKED ...", and peers
 * outside 127/8 are rejected when the list is parsed.  Test mode is on in
 * any automated run (roam_plat_test_mode()).
 */
#ifndef ROAM_PLAT_H
#define ROAM_PLAT_H
#include "roam_core.h"

typedef struct {
    uint16_t    port;
    int         test_mode;
    int         discovery;          /* LAN beacon (production only) */
    const char *impair;             /* test aid: "loss=5,delay=100,jitter=10,dup=1,seed=1" (jitter wider than 50 ms reorders) */
} roam_plat_cfg;

/* 1 when this run is automated: NFSU2_ROAM_HARNESS / NFSU2_NET_HARNESS = 1,
 * NFSU2_INPUT_SCRIPT, NFSU2_QUIT_FRAMES, NFSU2_TIMEOUT, ALARM other than 0, or
 * NOFOCUS other than 0 */
int      roam_plat_test_mode(void);
/* opens and binds the socket, installs io.send / io.broadcast into the
 * session and starts the network thread; 0 on success */
int      roam_plat_start(const roam_plat_cfg *cfg, rc_session *s);
void     roam_plat_stop(uint8_t bye_reason);       /* BYE, close, join */
void     roam_plat_lock(void);
void     roam_plat_unlock(void);
int64_t  roam_plat_now_us(void);                   /* host monotonic clock */
uint32_t roam_plat_random(void);                   /* nonzero */
/* "a.b.c.d[:port], ..." -> up to max entries; IPv4 literals only (no DNS);
 * in test mode only 127/8.  Returns the count; bad entries are logged. */
int      roam_plat_parse_peers(const char *list, int test_mode, uint16_t defport,
                               uint32_t *ip, uint16_t *port, int max);

/* --- pieces exposed for the unit tests (no socket needed) --- */
typedef struct { char name[16]; uint32_t addr, mask; int up, loopback, can_broadcast; } roam_if;
/* where a discovery beacon goes: 255.255.255.255 plus every usable
 * interface's directed broadcast (no loopback, utun, awdl, llw, ipsec) */
int      roam_bcast_targets(const roam_if *ifs, int n, uint32_t *out, int max);
/* the guard on its own: 1 = may be sent, 0 = refused (and logged) */
int      roam_plat_guard(int test_mode, uint32_t ip, int is_broadcast);
typedef struct { uint64_t sent, sent_bytes, recv, recv_bytes, blocked, send_err, impair_drop, impair_dup; } roam_plat_stats;
void     roam_plat_get_stats(roam_plat_stats *out);
/* a message over the game ("<name><what>", as the joins and leaves; name 0:
 * what alone, as the room's "Nobody else"): the page shows it (web);
 * elsewhere a log line.  With the session lock held */
void     roam_plat_notice(const char *name, const char *what);
/* the race lobby's panel over the game (roam_game.c mp_panel): its state as
 * a JSON object, "{}" for none, sent when it changes.  1: the page shows it
 * (web); 0: this platform has no panel, the game's top line says it.  With
 * the session lock held */
int      roam_plat_lobby(const char *json);
/* solid cars as the player switched them while the game runs (the page's
 * menu, web): 1 on, 0 off, -1 not switched (NFSU2_ROAM_COLLIDE holds) */
int      roam_plat_solid(void);
const char *roam_ip_str(uint32_t ip, char *buf);   /* buf >= 16 */

#endif
