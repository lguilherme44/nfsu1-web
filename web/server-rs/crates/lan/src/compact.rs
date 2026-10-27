//! Compact bundles (kind 33): the datagrams of a bundle to a page whose hello said "compact":1, without what the page
//! can put back exactly.  What reaches the game is the same, byte for byte; what goes over the network is about a
//! quarter less (a free-roam snapshot of 90 bytes cost 110 in a bundle, 84 here).  On nfsu2.xyz the port is the
//! limit (486 Mbit/s of 1000 at 2,960 players, 2026-10-22), and almost all of it is these snapshots.
//!
//! A bundle: [0] 33, [1..3] reserved, then entries of
//!   [0] flags: bits 0-2 the frame's kind (1-7); 0x08 to the broadcast address (else to the page's own); 0x10 the
//!       ports follow (else both are RC_DEFAULT_PORT, free roam's 47210); 0x20 a free-roam datagram without its
//!       "N2FR", version, length and CRC (the page writes them back, the CRC computed again: the switch checked it
//!       first); 0x40 the whole frame follows as it is (its 16-byte header included; the other bits 0)
//!   [1..2] u16 the source address's low 16 bits (10.77.x.y)
//!   [3..4] u16 the length of what follows: the ports (u16 source, u16 destination) when 0x10, then the data
//!
//! Left out per entry: the bundle entry's 4 bytes and the frame's 16-byte header for 5 (9 with ports); a free-roam
//! datagram's magic, version, length and CRC (11 bytes).  The page (web/src/net) puts the frame together again
//! before the game's mailbox sees it.
//!
//! To a page whose hello said "delta":1 too, a free-roam datagram to it on free roam's ports (0x20 without 0x08 and
//! 0x10) may go as what changed since the last one of its type from the same source (`Refs`): flags 0x80 with 0x20,
//! then its type, a bitmap of its body's bytes (bit i % 8 of byte i / 8: byte i of the body is new; the body as long
//! as the last one's), and the new bytes in order.  A friend's snapshots 20 times a second change in their position,
//! speed and turn, little else: a moving car's about 40 % fewer bytes, a standing one's about 75 % (an estimate from
//! the snapshot's fields, roam_core.c put_state).  Every such entry, in either form, is the last one of its source
//! and type for the next; the page keeps the same, entry for entry, and the stream (TCP) loses and reorders
//! nothing, so the game still gets each datagram byte for byte.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use bytes::Bytes;

use crate::{BASE, BROADCAST};

/// a compact bundle (page and switch only: the switch never routes one from a client)
pub(crate) const KIND_COMPACT: u8 = 33;
/// runtime/roam_core.h RC_DEFAULT_PORT
const ROAM_PORT: u16 = 47210;
const F_BCAST: u8 = 0x08;
const F_PORTS: u8 = 0x10;
const F_ROAM: u8 = 0x20;
const F_WHOLE: u8 = 0x40;
const F_DELTA: u8 = 0x80;
/// the sources and types whose last bodies a connection keeps at most: a new one past that, and they all go first
/// (the page does the same, so both keep the same ones)
pub(crate) const REFS_MAX: usize = 256;
/// an entry's own bytes
const ENTRY: usize = 5;
/// "N2FR", version, length (left out at the front) and the CRC (at the end)
const ROAM_CUT: usize = 11;
/// a frame's byte 1 (reserved on the wire) in the switch's own copy of it: its datagram is a free-roam one whose
/// magic, version, length and CRC checked out (`mark`), so a compact bundle may leave them out
pub(crate) const ROAM_OK: u8 = 1;

/// a free-roam datagram (runtime/roam_core.c rc_encode) as the game's decoder takes it: "N2FR", version 1, its length
/// (u16 LE) the datagram's, the CRC-32 (zlib's, LE) of what comes before it
fn roam_ok(d: &[u8]) -> bool {
    let n = d.len();
    n >= 20
        && &d[..4] == b"N2FR"
        && d[4] == 1
        && u16::from_le_bytes([d[6], d[7]]) as usize == n
        && u32::from_le_bytes([d[n - 4], d[n - 3], d[n - 2], d[n - 1]]) == crc32fast::hash(&d[..n - 4])
}

/// the switch's copy of a browser's frame, with byte 1 saying whether its free-roam datagram may go compact (byte 1
/// is reserved on the wire: what a client put there is not kept; the writers send 0 there)
pub(crate) fn mark(data: &[u8]) -> Bytes {
    let mut v = data.to_vec();
    v[1] = if data[0] == crate::KIND_UDP && v.len() > 16 && roam_ok(&data[16..]) { ROAM_OK } else { 0 };
    Bytes::from(v)
}

/// an entry's flags and the bytes it takes, for a datagram of `data` from src to dst at a page holding `own`.  A frame
/// shorter than the 16 bytes of a header with ports goes whole: the reader takes any frame of 12 bytes or more, and
/// the compact form reads the ports and what follows them (the third audit: one 12-byte broadcast panicked the writer
/// of every page that takes compact bundles, which dropped them all)
fn plan(data: &[u8], src: u32, dst: u32, own: u32) -> (u8, usize) {
    let kind = data[0];
    if data.len() < 16 || kind == 0 || kind > 7 || src >> 16 != BASE >> 16 || (dst != own && dst != BROADCAST) {
        return (F_WHOLE, ENTRY + data.len());
    }
    let mut flags = kind;
    let mut n = ENTRY;
    if dst == BROADCAST {
        flags |= F_BCAST;
    }
    if u16::from_be_bytes([data[12], data[13]]) != ROAM_PORT || u16::from_be_bytes([data[14], data[15]]) != ROAM_PORT {
        flags |= F_PORTS;
        n += 4;
    }
    if data[1] == ROAM_OK {
        flags |= F_ROAM;
        n += data.len() - 16 - ROAM_CUT;
    } else {
        n += data.len() - 16;
    }
    (flags, n)
}

/// the bytes `entry` writes without deltas
#[cfg(test)]
pub(crate) fn entry_len(data: &[u8], src: u32, dst: u32, own: u32) -> usize {
    plan(data, src, dst, own).1
}

/// The last body (a free-roam datagram past its type, as an 0x20 entry carries it) of each source and type that went
/// to one page in a compact bundle: what its 0x80 entries are made against.  Its writer's own.
#[derive(Default)]
pub(crate) struct Refs {
    last: HashMap<u32, Vec<u8>, BuildHasherDefault<KeyHash>>,
}

/// a key's hash: one multiply, folded (a map of at most `REFS_MAX` keys, made of a source and a type)
#[derive(Default)]
struct KeyHash(u64);

impl Hasher for KeyHash {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, b: &[u8]) {
        for &x in b {
            self.write_u32(x as u32);
        }
    }
    fn write_u32(&mut self, k: u32) {
        let x = (self.0 ^ k as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        self.0 = x ^ x >> 32;
    }
}

impl Refs {
    /// the entry of a free-roam datagram's type and body from src: as what changed since that source's and type's
    /// last body when there is one as long and that is shorter, else as it is; body is their last now either way
    fn entry(&mut self, buf: &mut Vec<u8>, flags: u8, src: u32, kind: u8, body: &[u8], plain: impl FnOnce(&mut Vec<u8>)) {
        let key = (src & 0xFFFF) << 8 | kind as u32;
        match self.last.get_mut(&key) {
            Some(last) if last.len() == body.len() => {
                // in one pass: the bitmap, the new bytes after it, the last body brought up to date
                let start = buf.len();
                let map = body.len().div_ceil(8);
                buf.push(flags | F_DELTA);
                buf.extend_from_slice(&(src as u16).to_be_bytes());
                buf.extend_from_slice(&[0, 0, kind]);
                let at = buf.len();
                buf.resize(at + map, 0);
                for (i, (&b, l)) in body.iter().zip(last.iter_mut()).enumerate() {
                    if b != *l {
                        buf[at + i / 8] |= 1 << (i % 8);
                        buf.push(b);
                        *l = b;
                    }
                }
                let n = buf.len() - at + 1;
                if n < 1 + body.len() {
                    buf[start + 3..start + 5].copy_from_slice(&(n as u16).to_be_bytes());
                } else {
                    buf.truncate(start);
                    plain(buf);
                }
            }
            Some(last) => {
                last.clear();
                last.extend_from_slice(body);
                plain(buf);
            }
            None => {
                if self.last.len() >= REFS_MAX {
                    self.last.clear();
                }
                self.last.insert(key, body.to_vec());
                plain(buf);
            }
        }
    }
}

/// one entry; with `refs` (a page that takes deltas) a free-roam datagram to it goes as what changed when that is
/// shorter, and is its source's last either way
pub(crate) fn entry(buf: &mut Vec<u8>, data: &[u8], src: u32, dst: u32, own: u32, refs: Option<&mut Refs>) {
    let (flags, n) = plan(data, src, dst, own);
    match refs.filter(|_| flags & (F_ROAM | F_PORTS | F_BCAST | F_WHOLE) == F_ROAM) {
        Some(refs) => {
            let d = &data[16..];
            refs.entry(buf, flags, src, d[5], &d[8..d.len() - 4], |buf| plain(buf, data, src, dst, flags, n));
        }
        None => plain(buf, data, src, dst, flags, n),
    }
}

fn plain(buf: &mut Vec<u8>, data: &[u8], src: u32, dst: u32, flags: u8, n: usize) {
    buf.push(flags);
    if flags == F_WHOLE {
        buf.extend_from_slice(&[0, 0]);
        buf.extend_from_slice(&((n - ENTRY) as u16).to_be_bytes());
        crate::conn::with_addrs(buf, data, src, dst);
        return;
    }
    buf.extend_from_slice(&(src as u16).to_be_bytes());
    buf.extend_from_slice(&((n - ENTRY) as u16).to_be_bytes());
    if flags & F_PORTS != 0 {
        buf.extend_from_slice(&data[12..16]);
    }
    let d = &data[16..];
    if flags & F_ROAM != 0 {
        buf.push(d[5]);
        buf.extend_from_slice(&d[8..d.len() - 4]);
    } else {
        buf.extend_from_slice(d);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// what the page does with a compact bundle (web/src/net/proto.ts unpackCompact): the frames as the game gets them
    pub(crate) fn unpack(b: &[u8], own: u32) -> Vec<Vec<u8>> {
        unpack_with(b, own, None)
    }

    /// the same for a page that takes deltas: refs its last bodies (by source and type), as `Refs` keeps them
    pub(crate) fn unpack_with(b: &[u8], own: u32, mut refs: Option<&mut HashMap<u32, Vec<u8>>>) -> Vec<Vec<u8>> {
        assert_eq!(b[0], KIND_COMPACT);
        let mut out = Vec::new();
        let mut at = 4;
        while at + ENTRY <= b.len() {
            let flags = b[at];
            let src = BASE | u16::from_be_bytes([b[at + 1], b[at + 2]]) as u32;
            let n = u16::from_be_bytes([b[at + 3], b[at + 4]]) as usize;
            let mut p = at + ENTRY;
            let end = p + n;
            assert!(end <= b.len());
            if flags == F_WHOLE {
                out.push(b[p..end].to_vec());
                at = end;
                continue;
            }
            let mut f = vec![flags & 7, 0, 0, 0];
            f.extend_from_slice(&src.to_be_bytes());
            f.extend_from_slice(&(if flags & F_BCAST != 0 { BROADCAST } else { own }).to_be_bytes());
            if flags & F_PORTS != 0 {
                f.extend_from_slice(&b[p..p + 4]);
                p += 4;
            } else {
                f.extend_from_slice(&ROAM_PORT.to_be_bytes());
                f.extend_from_slice(&ROAM_PORT.to_be_bytes());
            }
            if flags & F_ROAM != 0 {
                let kind = b[p];
                let key = (src & 0xFFFF) << 8 | kind as u32;
                let body = if flags & F_DELTA != 0 {
                    let last = refs.as_ref().unwrap().get(&key).expect("a delta's last body").clone();
                    let map = last.len().div_ceil(8);
                    let mut next = p + 1 + map;
                    let body: Vec<u8> = (0..last.len())
                        .map(|i| {
                            if b[p + 1 + i / 8] >> (i % 8) & 1 == 1 {
                                next += 1;
                                b[next - 1]
                            } else {
                                last[i]
                            }
                        })
                        .collect();
                    assert_eq!(next, end, "the new bytes fill the entry");
                    body
                } else {
                    b[p + 1..end].to_vec()
                };
                if let Some(r) = refs.as_deref_mut().filter(|_| flags & (F_PORTS | F_BCAST) == 0) {
                    if r.len() >= REFS_MAX && !r.contains_key(&key) {
                        r.clear();
                    }
                    r.insert(key, body.clone());
                }
                let len = body.len() + 1 + ROAM_CUT;
                let mut d = b"N2FR".to_vec();
                d.push(1);
                d.push(kind);
                d.extend_from_slice(&(len as u16).to_le_bytes());
                d.extend_from_slice(&body);
                let crc = crc32fast::hash(&d);
                d.extend_from_slice(&crc.to_le_bytes());
                f.extend_from_slice(&d);
            } else {
                f.extend_from_slice(&b[p..end]);
            }
            out.push(f);
            at = end;
        }
        out
    }

    /// a free-roam datagram as rc_encode makes it: a type, a body, the length and CRC filled in
    pub(crate) fn roam(kind: u8, body: &[u8]) -> Vec<u8> {
        let mut d = b"N2FR".to_vec();
        d.extend_from_slice(&[1, kind, 0, 0]);
        d.extend_from_slice(&0x1234_5678u32.to_le_bytes());
        d.extend_from_slice(&[7, 0, 0, 0]);
        d.extend_from_slice(body);
        let n = d.len() + 4;
        d[6..8].copy_from_slice(&(n as u16).to_le_bytes());
        let crc = crc32fast::hash(&d);
        d.extend_from_slice(&crc.to_le_bytes());
        d
    }

    /// a frame of `kind` as a browser sends it (its source and destination as the switch writes them going out)
    fn frame(kind: u8, src: u32, dst: u32, sport: u16, dport: u16, data: &[u8]) -> Vec<u8> {
        let mut f = vec![kind, 0, 0, 0];
        f.extend_from_slice(&src.to_be_bytes());
        f.extend_from_slice(&dst.to_be_bytes());
        f.extend_from_slice(&sport.to_be_bytes());
        f.extend_from_slice(&dport.to_be_bytes());
        f.extend_from_slice(data);
        f
    }

    // every kind of entry comes back as the frame it was, byte for byte, and the usual one is a quarter smaller
    #[test]
    fn entries_come_back_byte_for_byte() {
        let own = BASE | 0x0305;
        let (a, b) = (BASE | 0x0102, BASE | 0x0F07);
        let snap = roam(3, &[9u8; 70]);
        let mut broken = roam(3, &[9u8; 70]);
        *broken.last_mut().unwrap() ^= 1;
        let cases: Vec<(Vec<u8>, u32, u32)> = vec![
            // a snapshot to us on free roam's ports: the compact form
            (frame(1, a, own, ROAM_PORT, ROAM_PORT, &snap), a, own),
            // a broadcast (discovery without a hub)
            (frame(1, b, BROADCAST, ROAM_PORT, ROAM_PORT, &roam(1, b"hello")), b, BROADCAST),
            // other ports (a second game on one browser, the Roam port setting)
            (frame(1, a, own, 47211, 47300, &snap), a, own),
            // a CRC that does not check out, not a free-roam datagram, a short one: their bytes as they are
            (frame(1, a, own, ROAM_PORT, ROAM_PORT, &broken), a, own),
            (frame(1, a, own, ROAM_PORT, ROAM_PORT, b"just some bytes of a datagram"), a, own),
            (frame(1, a, own, ROAM_PORT, ROAM_PORT, b""), a, own),
            // LAN play's UDP and ICMP, and the test loopback
            (frame(3, b, own, 6112, 6113, &[1, 64, 0, 0, 0, 0, 0, 7, 42, 42]), b, own),
            (frame(5, b, BROADCAST, 0, 0, &[8, 64, 0, 0, 0, 0, 0, 1]), b, BROADCAST),
            (frame(2, a, BROADCAST, 47300, 47300, &snap), a, BROADCAST),
            // a source outside 10.77/16 (none on the switch today) and a destination that is neither: whole
            (frame(1, 0x0B00_0001, own, ROAM_PORT, ROAM_PORT, &snap), 0x0B00_0001, own),
            (frame(1, a, BASE | 9, ROAM_PORT, ROAM_PORT, &snap), a, BASE | 9),
        ];
        let mut b = vec![KIND_COMPACT, 0, 0, 0];
        let mut want = Vec::new();
        for (f, src, dst) in &cases {
            let m = mark(f);
            let before = b.len();
            entry(&mut b, &m, *src, *dst, own, None);
            assert_eq!(b.len() - before, entry_len(&m, *src, *dst, own));
            want.push(f.clone());
        }
        assert_eq!(unpack(&b, own), want);
        // the snapshot: 90 bytes of datagram, 110 in a bundle of before, 84 here
        let m = mark(&cases[0].0);
        assert_eq!(snap.len(), 90);
        assert_eq!(entry_len(&m, a, own, own), 84);
        assert_eq!(mark(&cases[3].0)[1], 0, "a broken CRC is not left out");
    }

    // a frame too short for its ports (12 to 15 bytes: the reader takes them) goes whole, broadcast or not
    #[test]
    fn a_frame_without_ports_goes_whole() {
        let (own, a) = (BASE | 0x0305, BASE | 0x0102);
        let mut b = vec![KIND_COMPACT, 0, 0, 0];
        let mut want = Vec::new();
        for (kind, dst, len) in [(1u8, BROADCAST, 12usize), (1, own, 15), (3, BROADCAST, 13), (5, own, 14)] {
            let mut f = vec![kind, 0, 0, 0];
            f.extend_from_slice(&a.to_be_bytes());
            f.extend_from_slice(&dst.to_be_bytes());
            f.resize(len, 0xAB);
            let m = mark(&f);
            let before = b.len();
            entry(&mut b, &m, a, dst, own, None);
            assert_eq!(b.len() - before, entry_len(&m, a, dst, own));
            assert_eq!(b[before], F_WHOLE);
            want.push(f);
        }
        assert_eq!(unpack(&b, own), want);
    }

    // to a page that takes deltas: every datagram comes back byte for byte (snapshots changing a few bytes at a time,
    // other types between them, a longer body, ports, broadcasts, LAN play's, bundles cut where they fill), and a
    // snapshot that changed a little takes far fewer bytes
    #[test]
    fn deltas_come_back_byte_for_byte() {
        let own = BASE | 0x0305;
        let srcs = [BASE | 0x0102, BASE | 0x0F07, BASE | 0x1301];
        let mut seed = 0x9E37_79B9u32;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        let mut bodies: Vec<Vec<u8>> = srcs.iter().map(|_| (0..75).map(|_| rnd() as u8).collect()).collect();
        let mut frames = Vec::new();
        for step in 0..400 {
            let i = rnd() as usize % srcs.len();
            let body = &mut bodies[i];
            // a snapshot: a few of its bytes new (a moving car's position and speed), now and then a longer one
            for _ in 0..rnd() % 30 {
                let k = rnd() as usize % body.len();
                body[k] = rnd() as u8;
            }
            if step % 97 == 0 {
                body.push(rnd() as u8);
            }
            frames.push((frame(1, srcs[i], own, ROAM_PORT, ROAM_PORT, &roam(3, body)), srcs[i], own));
            match step % 13 {
                0 => frames.push((frame(1, srcs[i], own, ROAM_PORT, ROAM_PORT, &roam(1, b"a hello")), srcs[i], own)),
                5 => frames.push((frame(1, srcs[i], BROADCAST, ROAM_PORT, ROAM_PORT, &roam(3, body)), srcs[i], BROADCAST)),
                7 => frames.push((frame(1, srcs[i], own, 47211, 47211, &roam(3, body)), srcs[i], own)),
                9 => frames.push((frame(3, srcs[i], own, 6112, 6113, &[1, 64, 0, 0, 0, 0, 0, 7, 42]), srcs[i], own)),
                _ => {}
            }
        }
        // in bundles of about 2 KB, each made after the last as the writer makes them
        let mut refs = Refs::default();
        let (mut bundles, mut b) = (Vec::new(), vec![KIND_COMPACT, 0, 0, 0]);
        let (mut plain_bytes, mut delta_bytes) = (0, 0);
        for (f, src, dst) in &frames {
            let m = mark(f);
            let at = b.len();
            entry(&mut b, &m, *src, *dst, own, Some(&mut refs));
            plain_bytes += entry_len(&m, *src, *dst, own);
            delta_bytes += b.len() - at;
            if b.len() > 2000 {
                bundles.push(b);
                b = vec![KIND_COMPACT, 0, 0, 0];
            }
        }
        bundles.push(b);
        let mut page = HashMap::new();
        let got: Vec<Vec<u8>> = bundles.iter().flat_map(|b| unpack_with(b, own, Some(&mut page))).collect();
        assert_eq!(got.len(), frames.len());
        for (g, (f, ..)) in got.iter().zip(&frames) {
            assert_eq!(g, f);
        }
        assert!(delta_bytes * 10 < plain_bytes * 7, "{delta_bytes} bytes with deltas, {plain_bytes} without");
    }

    // past REFS_MAX sources the writer's last bodies all go, and the page's with them: still byte for byte
    #[test]
    fn many_sources_the_last_bodies_go_together() {
        let own = BASE | 0x0305;
        let mut refs = Refs::default();
        let mut page = HashMap::new();
        for round in 0..3u8 {
            let mut b = vec![KIND_COMPACT, 0, 0, 0];
            let mut want = Vec::new();
            for s in 0..(REFS_MAX as u32 + 40) {
                let src = BASE | (s / 250) << 8 | (s % 250 + 2);
                let f = frame(1, src, own, ROAM_PORT, ROAM_PORT, &roam(3, &[round, s as u8, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7]));
                entry(&mut b, &mark(&f), src, own, own, Some(&mut refs));
                want.push(f);
            }
            assert_eq!(unpack_with(&b, own, Some(&mut page)), want, "round {round}");
            assert!(refs.last.len() <= REFS_MAX && page.len() == refs.last.len());
        }
    }

    /// what an entry costs the writer, with deltas and without (a snapshot of 75 body bytes, 20 of them new each time,
    /// from 32 friends)
    #[test]
    #[ignore]
    fn what_an_entry_costs() {
        let own = BASE | 0x0305;
        let frames: Vec<(Vec<u8>, u32)> = (0..32u32)
            .flat_map(|s| {
                let src = BASE | (s + 2);
                (0..8u8).map(move |k| {
                    let body: Vec<u8> = (0..75u8).map(|i| if i % 4 == k % 4 { i ^ k } else { i }).collect();
                    (mark(&frame(1, src, own, ROAM_PORT, ROAM_PORT, &roam(3, &body))).to_vec(), src)
                })
            })
            .collect();
        for refs in [false, true] {
            let mut r = Refs::default();
            let mut b = Vec::with_capacity(64 << 10);
            let (t, mut bytes) = (std::time::Instant::now(), 0);
            let n = 1_000_000;
            for i in 0..n {
                let (f, src) = &frames[i % frames.len()];
                if b.len() > 30_000 {
                    bytes += b.len();
                    b.clear();
                }
                entry(&mut b, f, *src, own, own, refs.then_some(&mut r));
            }
            bytes += b.len();
            println!("deltas {refs}: {:.0} ns an entry, {:.1} bytes", t.elapsed().as_secs_f64() * 1e9 / n as f64, bytes as f64 / n as f64);
        }
    }

    // byte 1 of the switch's copy is its own: what a client wrote there never says "checked"
    #[test]
    fn a_clients_byte_1_is_not_kept() {
        let mut f = frame(1, BASE | 2, BASE | 3, ROAM_PORT, ROAM_PORT, b"not free roam");
        f[1] = ROAM_OK;
        assert_eq!(mark(&f)[1], 0);
        let mut g = frame(3, BASE | 2, BASE | 3, 1, 2, &roam(3, &[0; 8]));
        g[1] = ROAM_OK;
        assert_eq!(mark(&g)[1], 0, "only kind 1 is free roam's");
    }
}
