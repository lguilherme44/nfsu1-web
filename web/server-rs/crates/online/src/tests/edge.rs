//! What a client can send, and what can happen to the host, that the other tests do not try: numbers at the ends of
//! their range, and the like (each found where the Rust host could differ from the Node server: a panic, a resource
//! held).

use super::world::{Opts, World};

// a ranking asked for on the channel of the lowest 32-bit number (CHAN=2147483648 is -2^31 for `| 0`): the answer is
// an empty ranking; `chan - 6` overflowed here once (a panic in a build with overflow checks: the stream went as a
// "service error")
#[test]
fn snap_on_the_channel_at_the_end_of_the_range() {
    let mut w = World::new(Opts::default());
    let g = w.client("10.77.0.2");
    let a = w.login(g, "Alpha");
    for chan in ["2147483648", "-2147483648", "-2147483643", "2147483647", "4294967295"] {
        w.send(a, "snap", fields![("INDEX", 1), ("CHAN", chan), ("RANGE", 10)]);
        let m = w.c(a).l("snap");
        assert_eq!((m.g("COUNT"), m.g("TOTAL")), ("0", "0"), "CHAN={chan}");
        w.send(a, "snap", fields![("INDEX", 1), ("CHAN", chan), ("FIND", "$")]);
        assert_eq!(w.c(a).l("snap").g("COUNT"), "0", "CHAN={chan} FIND=$");
    }
    assert_eq!(w.c(a).l("snap").g("CHAN"), "-1", "the channel as JavaScript's `| 0` makes it");
    assert!(!w.c(a).reset, "the session stays");
}

// streams opened and reset as fast as a client may (its budget is 2500 frames a second a connection): each sets a
// time-out (EA Messenger's 60 s for a login, the redirector's 30 s, the web pages' 15 s) that its reset clears.  A
// cleared timer is gone as Node's clearTimeout makes it, not held in the queue until its time (before: 100,000 of
// them were, 40 s of one connection's budget)
#[test]
fn cleared_timers_leave_the_queue() {
    use crate::vhost::{RST, SYN, lan_frame};
    use crate::{PORT_BUDDY, PORT_HTTP, PORT_REDIRECTOR, VHOST_VIP};
    let mut w = World::new(Opts::default());
    w.mute = true;
    let g = w.client("10.77.0.2");
    let before = w.core.timers.queued();
    for k in 0..100_000u32 {
        let port = [PORT_BUDDY, PORT_REDIRECTOR, PORT_HTTP][k as usize % 3];
        let sport = 1000 + (k % 50_000) as u16;
        w.raw(g, &lan_frame(4, g, VHOST_VIP, sport, port, SYN, k, &[]));
        w.raw(g, &lan_frame(4, g, VHOST_VIP, sport, port, RST, k, &[]));
    }
    assert_eq!(w.core.vh.conns.len(), 0);
    let queued = w.core.timers.queued();
    assert!(queued < before + 2048, "{queued} places in the timer queue for {before} live timers");
}
