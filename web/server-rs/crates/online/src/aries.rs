//! The lobby protocol's framing (EA DirtySock "ProtoAries", as SPEED2.EXE's lobby client and EA's server.dll speak
//! it):
//!
//! - `[0..3]` kind: four ASCII characters ("auth", "+rom", "@dir", ...)
//! - `[4..7]` code: four bytes; 0 in a request and in a reply that succeeded, an error tag ("imst", "pass", ...)
//!   or a subkind ("new7") otherwise; "filt" in a game list search made with the Filter the player set (the runtime's
//!   own, runtime/olfilter.c)
//! - `[8..11]` u32 big-endian: the whole message's length, these 12 bytes included
//! - `[12..]` the body: KEY=VALUE fields, NUL-terminated
//!
//! The body is DirtySock's "TagField" text.  The client finds a field by its key (case-insensitive) after any byte
//! <= 0x20 (so tabs, newlines and spaces all separate fields) and writes a value (0x741A50) with every byte below
//! 0x20, 0x7F and = " : % ^ as %xx (lowercase hex), in double quotes when the value has a space.  This module
//! writes exactly that and reads both that and plain values.
//!
//! Secrets: the login messages carry PASS (the account password, XOR-masked or encrypted, both reversible: as good
//! as plain text), REGKEY (the CD key) and PSES (a checksum of the player's game files).  [`parse_fields`] takes a
//! test of keys to skip, and the lobby skips [`SECRET_KEYS`] for every message: their values are never decoded, so
//! nothing after the parser can keep or log one.  The one exception is PASS in gcre and gjoi, which is a game's own
//! password there (the lobby keeps only a digest of it).  [`redact_body`] is for the dev-only frame trace (trace.rs).

use std::borrow::Cow;

use indexmap::IndexMap;
use nfsu2_util::{js, json};

use crate::jsx;

/// keys whose values the server never reads: the account password, the CD key, the file checksum (but PASS in gcre
/// and gjoi: a game's password)
pub const SECRET_KEYS: [&str; 3] = ["PASS", "REGKEY", "PSES"];

pub const HDR: usize = 12;
/// the client's receive buffer is 0x8000 bytes; nothing it sends or needs is near this
pub const MAX_FRAME: usize = 8192;

/// a field's value: a string, a number (written as JavaScript writes one: `js::number_to_string`), or nothing (the
/// field is left out)
#[derive(Clone, Debug, PartialEq)]
pub enum V {
    S(String),
    N(f64),
    Null,
}

impl From<&str> for V {
    fn from(s: &str) -> V {
        V::S(s.to_string())
    }
}
impl From<String> for V {
    fn from(s: String) -> V {
        V::S(s)
    }
}
impl From<&String> for V {
    fn from(s: &String) -> V {
        V::S(s.clone())
    }
}
impl From<Option<String>> for V {
    fn from(s: Option<String>) -> V {
        s.map_or(V::Null, V::S)
    }
}
impl From<Option<&str>> for V {
    fn from(s: Option<&str>) -> V {
        s.map_or(V::Null, |s| V::S(s.to_string()))
    }
}
impl From<&Option<String>> for V {
    fn from(s: &Option<String>) -> V {
        s.as_ref().map_or(V::Null, |s| V::S(s.clone()))
    }
}
macro_rules! v_num {
    ($($t:ty),*) => { $(impl From<$t> for V { fn from(x: $t) -> V { V::N(x as f64) } })* };
}
v_num!(f64, i64, u64, i32, u32, u16, usize);

/// a body's fields: (key, value), in order
pub type Fields = Vec<(Cow<'static, str>, V)>;

/// `fields![(k, v), ...]`: a [`Fields`] (a Vec: most are sent as they are, some grow)
macro_rules! fields {
    ($(($k:expr, $v:expr)),* $(,)?) => {{
        #[allow(clippy::useless_vec)]
        let f: $crate::aries::Fields = vec![$((::std::borrow::Cow::from($k), $crate::aries::V::from($v))),*];
        f
    }};
}

const HEXD: &[u8; 16] = b"0123456789abcdef";

fn special(c: u8) -> bool {
    matches!(c, 0x3d | 0x22 | 0x3a | 0x25 | 0x5e | 0x7f)
}

/// a value as the client writes one (latin1 bytes)
pub fn encode_value(v: &V, out: &mut Vec<u8>) {
    let mut b = Vec::new();
    match v {
        V::S(s) => jsx::latin1_encode(s, &mut b),
        V::N(x) => b.extend_from_slice(js::number_to_string(*x).as_bytes()),
        V::Null => b.extend_from_slice(b"null"),
    }
    let quote = b.contains(&0x20);
    if quote {
        out.push(b'"');
    }
    for c in b {
        if c < 0x20 || special(c) {
            out.extend_from_slice(&[b'%', HEXD[(c >> 4) as usize], HEXD[(c & 15) as usize]]);
        } else {
            out.push(c);
        }
    }
    if quote {
        out.push(b'"');
    }
}

/// `/^[A-Za-z0-9_+@$~]{1,32}$/`
fn good_key(k: &str) -> bool {
    (1..=32).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"_+@$~".contains(&b))
}

/// a body: "K=V<sep>K=V<sep>" (no NUL), as latin1 bytes; a field name that is not one (`good_key`) is an error
pub fn encode_fields(fields: &[(Cow<'static, str>, V)], sep: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(16 * fields.len());
    encode_fields_into(fields, sep, &mut out)?;
    Ok(out)
}

fn encode_fields_into(fields: &[(Cow<'static, str>, V)], sep: u8, out: &mut Vec<u8>) -> Result<(), String> {
    for (k, v) in fields {
        if *v == V::Null {
            continue;
        }
        if !good_key(k) {
            let mut q = String::new();
            json::write_str(&mut q, k);
            return Err(format!("bad field name {q}"));
        }
        out.extend_from_slice(k.as_bytes());
        out.push(b'=');
        encode_value(v, out);
        out.push(sep);
    }
    Ok(())
}

/// a 4-character kind or code ("" for 0), padded with NULs
fn tag4(t: &str, what: &str, out: &mut Vec<u8>) -> Result<(), String> {
    let mut b = Vec::with_capacity(4);
    jsx::latin1_encode(t, &mut b);
    if b.len() > 4 {
        let mut q = String::new();
        json::write_str(&mut q, t);
        return Err(format!("{what} {q} is longer than 4 characters"));
    }
    b.resize(4, 0);
    out.extend_from_slice(&b);
    Ok(())
}

/// one message (code "" = 0, success), fields separated by newlines
pub fn encode_frame(kind: &str, code: &str, fields: &[(Cow<'static, str>, V)]) -> Result<Vec<u8>, String> {
    encode_frame_sep(kind, code, fields, b'\n')
}

/// one message, fields separated by `sep` (the fields are checked first, then the kind, then the code: the error is
/// the first one's)
pub fn encode_frame_sep(kind: &str, code: &str, fields: &[(Cow<'static, str>, V)], sep: u8) -> Result<Vec<u8>, String> {
    let mut f = Vec::with_capacity(HDR + 24 * fields.len() + 1);
    f.extend_from_slice(&[0; HDR]);
    encode_fields_into(fields, sep, &mut f)?;
    f.push(0);
    let mut tags = Vec::with_capacity(8);
    tag4(kind, "kind", &mut tags)?;
    tag4(code, "code", &mut tags)?;
    f[..8].copy_from_slice(&tags);
    let n = f.len() as u32;
    f[8..12].copy_from_slice(&n.to_be_bytes());
    Ok(f)
}

/// one message of a ready body (latin1 text, without its NUL)
#[cfg(test)]
pub fn encode_frame_text(kind: &str, code: &str, text: &str) -> Result<Vec<u8>, String> {
    let mut f = Vec::with_capacity(HDR + text.len() + 1);
    tag4(kind, "kind", &mut f)?;
    tag4(code, "code", &mut f)?;
    f.extend_from_slice(&[0; 4]);
    jsx::latin1_encode(text, &mut f);
    f.push(0);
    let n = f.len() as u32;
    f[8..12].copy_from_slice(&n.to_be_bytes());
    Ok(f)
}

/// a 4-byte tag as text: printable characters kept, NULs dropped, anything else as \xNN
pub fn tag_text(b: &[u8]) -> String {
    let mut s = String::with_capacity(4);
    for &c in b {
        if c == 0 {
            continue;
        }
        if (0x20..0x7f).contains(&c) {
            s.push(c as char);
        } else {
            s.push_str("\\x");
            s.push(HEXD[(c >> 4) as usize] as char);
            s.push(HEXD[(c & 15) as usize] as char);
        }
    }
    s
}

/// one message of a stream: kind and code as text, the body (the bytes after the header, NUL included)
#[derive(Clone, Debug)]
pub struct Msg {
    pub kind: String,
    pub code: String,
    pub body: Vec<u8>,
}

/// The messages in a byte stream.  `push` returns the complete messages so far; a length
/// below 12 or above `max` makes the stream bad (`error` set, nothing more is returned: the caller drops the
/// connection).
#[derive(Debug)]
pub struct FrameReader {
    max: usize,
    buf: Vec<u8>,
    pub error: Option<String>,
}

impl Default for FrameReader {
    fn default() -> Self {
        FrameReader::new(MAX_FRAME)
    }
}

impl FrameReader {
    pub fn new(max: usize) -> Self {
        FrameReader { max, buf: Vec::new(), error: None }
    }
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Msg> {
        let mut out = Vec::new();
        if self.error.is_some() {
            return out;
        }
        self.buf.extend_from_slice(chunk);
        let mut pos = 0;
        while self.buf.len() - pos >= HDR {
            let b = &self.buf[pos..];
            let n = u32::from_be_bytes([b[8], b[9], b[10], b[11]]) as usize;
            if n < HDR || n > self.max {
                self.error = Some(format!("a message of {n} bytes (at most {})", self.max));
                self.buf = Vec::new();
                return out;
            }
            if b.len() < n {
                break;
            }
            out.push(Msg { kind: tag_text(&b[0..4]), code: tag_text(&b[4..8]), body: b[HDR..n].to_vec() });
            pos += n;
        }
        if pos == self.buf.len() {
            self.buf.clear();
        } else if pos > 0 {
            self.buf.drain(..pos);
        }
        out
    }
    /// bytes waiting for the rest of a message
    #[cfg(test)]
    pub fn pending(&self) -> usize {
        self.buf.len()
    }
}

/// each %xx (two hex digits, either case) as the character xx; any other % stays
fn unescape(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16))
        {
            s.push(char::from((h * 16 + l) as u8));
            i += 3;
            continue;
        }
        s.push(b[i] as char);
        i += 1;
    }
    s
}

/// The fields of a body, in order, keys upper-cased; a key `skip` says yes to is
/// passed over without its value being decoded (it appears with the value None, so a caller can tell that one
/// was sent).  Text after the first NUL is ignored.
pub fn parse_fields(b: &[u8], skip: impl Fn(&str) -> bool) -> Vec<(String, Option<String>)> {
    let end = memchr_nul(b);
    let mut out = Vec::new();
    let mut i = 0;
    while i < end {
        while i < end && b[i] <= 0x20 {
            i += 1;
        }
        if i >= end {
            break;
        }
        let mut k = i;
        while k < end && b[k] > 0x20 && b[k] != 0x3d {
            k += 1;
        }
        // a word without "=": not a field
        if k >= end || b[k] != 0x3d {
            i = k;
            continue;
        }
        let key = jsx::latin1_decode(&b[i..k]).to_uppercase();
        let j = k + 1;
        let raw;
        if j < end && b[j] == 0x22 {
            // "quoted value"
            let mut q = j + 1;
            while q < end && b[q] != 0x22 {
                q += 1;
            }
            raw = if skip(&key) { None } else { Some(&b[j + 1..q]) };
            i = q + 1;
        } else {
            let mut q = j;
            while q < end && b[q] > 0x20 {
                q += 1;
            }
            raw = if skip(&key) { None } else { Some(&b[j..q]) };
            i = q;
        }
        out.push((key, raw.map(unescape)));
    }
    out
}

fn memchr_nul(b: &[u8]) -> usize {
    b.iter().position(|&c| c == 0).unwrap_or(b.len())
}

/// the lobby's skip: SECRET_KEYS
pub fn is_secret(k: &str) -> bool {
    SECRET_KEYS.contains(&k)
}

/// [`parse_fields`] as a map (the first of a repeated key wins, as the client's own search finds the first), in the
/// order the keys came
#[derive(Clone, Debug, Default)]
pub struct FieldMap(pub IndexMap<String, Option<String>>);

impl FieldMap {
    /// a body's fields ([`SECRET_KEYS`] skipped)
    pub fn parse(body: &[u8]) -> FieldMap {
        Self::parse_with(body, is_secret)
    }
    pub fn parse_with(body: &[u8], skip: impl Fn(&str) -> bool) -> FieldMap {
        let mut m = IndexMap::new();
        for (k, v) in parse_fields(body, skip) {
            m.entry(k).or_insert(v);
        }
        FieldMap(m)
    }
    /// a field's value: None when the field is missing or was skipped
    pub fn get(&self, k: &str) -> Option<&str> {
        self.0.get(k).and_then(|v| v.as_deref())
    }
    /// the field was sent (a skipped one too)
    pub fn has(&self, k: &str) -> bool {
        self.0.contains_key(k)
    }
    /// a field's value, "" when the field is missing or was skipped
    pub fn str(&self, k: &str) -> &str {
        self.get(k).unwrap_or("")
    }
    /// a field's number (as `jsx::to_number` reads its text), `def` when the field is missing
    pub fn num(&self, k: &str, def: f64) -> f64 {
        match self.0.get(k) {
            Some(Some(v)) => jsx::to_number(v),
            // a skipped field's number is 0 (the lobby never asks for one)
            Some(None) => 0.0,
            None => def,
        }
    }
}

/// keys a trace must not show (the secrets, a game's own password, and the key of a persona's Messenger login):
/// `/^(PASS\w*|REGKEY|PSES|LKEY)$/i` on the upper-cased key
fn redacted(k: &str) -> bool {
    matches!(k, "REGKEY" | "PSES" | "LKEY")
        || k.strip_prefix("PASS").is_some_and(|r| r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
}

/// a body as one printable line for the dev-only trace, every secret replaced
pub fn redact_body(body: &[u8]) -> String {
    let mut s = String::new();
    for (i, (k, v)) in parse_fields(body, redacted).into_iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&k);
        s.push('=');
        match v {
            None => s.push_str("<redacted>"),
            Some(v) => json::write_str(&mut s, &v),
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn latin1(b: &[u8]) -> String {
        jsx::latin1_decode(b)
    }

    // header: kind, code, big-endian length with the NUL-terminated body
    #[test]
    fn header() {
        let f = encode_frame("auth", "", &fields![("NAME", "Bob"), ("ADDR", "10.77.0.3")]).unwrap();
        assert_eq!(&f[0..4], b"auth");
        assert_eq!(&f[4..8], &[0, 0, 0, 0]);
        assert_eq!(u32::from_be_bytes([f[8], f[9], f[10], f[11]]) as usize, f.len());
        assert_eq!(latin1(&f[HDR..]), "NAME=Bob\nADDR=10.77.0.3\n\0");
        let e = encode_frame("auth", "pass", &[]).unwrap();
        assert_eq!(&e[4..8], b"pass");
        assert_eq!(e.len(), HDR + 1);
        assert_eq!(&encode_frame_text("news", "new7", "X=1").unwrap()[4..8], b"new7");
        assert!(encode_frame("toolong", "", &[]).is_err());
        assert!(encode_fields(&fields![("BAD KEY", 1)], b'\n').is_err());
    }

    // values as the game writes them
    #[test]
    fn values() {
        let ev = |v: V| {
            let mut o = Vec::new();
            encode_value(&v, &mut o);
            latin1(&o)
        };
        assert_eq!(ev("plain".into()), "plain");
        assert_eq!(ev("two words".into()), "\"two words\"");
        assert_eq!(ev("a=b".into()), "a%3db");
        assert_eq!(ev("q\"u:o%t^e".into()), "q%22u%3ao%25t%5ee");
        assert_eq!(ev("tab\there\nnl".into()), "tab%09here%0anl");
        assert_eq!(ev("\x7f".into()), "%7f");
        assert_eq!(ev(1234.into()), "1234");
        // latin1 bytes >= 0x80 stay as they are
        assert_eq!(ev("\u{c4}".into()), "\u{c4}");
    }

    // round trip through the reader, both separators, quotes, escapes
    #[test]
    fn round_trip() {
        let fields = fields![("NAME", "two words"), ("TEXT", "hi = \"you\": 100% ^^"), ("N", "7"), ("EMPTY", "")];
        let want: Vec<(String, Option<String>)> = fields
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string(),
                    Some(match v {
                        V::S(s) => s.clone(),
                        _ => unreachable!(),
                    }),
                )
            })
            .collect();
        for sep in *b"\n\t" {
            let f = encode_frame_sep("mesg", "", &fields, sep).unwrap();
            let m = FrameReader::default().push(&f);
            assert_eq!(m[0].kind, "mesg");
            assert_eq!(m[0].code, "");
            assert_eq!(parse_fields(&m[0].body, is_secret), want);
        }
        // what the client itself sends: spaces between fields, a word without "=" skipped, text after the NUL ignored
        let body = b"NAME=x  junk PERS=\"a b\"\tLKEY=k\0NAME=after";
        let got = parse_fields(body, is_secret);
        let s = |a: &str, b: &str| (a.to_string(), Some(b.to_string()));
        assert_eq!(got, vec![s("NAME", "x"), s("PERS", "a b"), s("LKEY", "k")]);
        // keys are found case-insensitively, the first one wins (as the client's own search)
        let m = FieldMap::parse(b"name=a\nNAME=b\n\0");
        assert_eq!(m.get("NAME"), Some("a"));
    }

    // stream: split and packed messages, the size limit
    #[test]
    fn stream() {
        let a = encode_frame("addr", "", &fields![("ADDR", "10.77.0.5"), ("PORT", "50000")]).unwrap();
        let b = encode_frame("skey", "", &fields![("SKEY", "$37940faf2a8d1381a3b7d0d2f570e6a7")]).unwrap();
        let all = [a.clone(), b].concat();
        let mut cut = 1;
        while cut < all.len() {
            let mut r = FrameReader::default();
            let mut got = r.push(&all[..cut]);
            got.extend(r.push(&all[cut..]));
            assert_eq!(got.iter().map(|m| m.kind.as_str()).collect::<Vec<_>>(), ["addr", "skey"], "cut at {cut}");
            assert_eq!(r.pending(), 0);
            cut += 3;
        }
        let mut r = FrameReader::new(64);
        let big = encode_frame("mesg", "", &fields![("TEXT", "x".repeat(100))]).unwrap();
        assert!(r.push(&big).is_empty());
        assert!(r.error.as_deref().unwrap().contains("at most 64"));
        assert!(r.push(&a).is_empty(), "nothing after a bad length");
        let mut tiny = vec![0u8; 12];
        tiny[..4].copy_from_slice(b"xxxx");
        tiny[8..12].copy_from_slice(&4u32.to_be_bytes());
        let mut r2 = FrameReader::default();
        r2.push(&tiny);
        assert!(r2.error.is_some());
    }

    // secrets: never decoded, never in the trace
    #[test]
    fn secrets() {
        let pw = "CANARY-PASSWORD-123";
        let mut body = encode_fields(
            &fields![("NAME", "Bob"), ("PASS", pw), ("TOS", "1"), ("REGKEY", "ABCD-EFGH"), ("PSES", "0123abcd"), ("PASSWORD", "gamepw")],
            b'\n',
        )
        .unwrap();
        body.push(0);
        let f = parse_fields(&body, is_secret);
        assert_eq!(f.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["NAME", "PASS", "TOS", "REGKEY", "PSES", "PASSWORD"]);
        for (k, v) in &f {
            if SECRET_KEYS.contains(&k.as_str()) {
                assert_eq!(*v, None, "{k}");
            }
        }
        assert!(FieldMap::parse(&body).has("PASS") && FieldMap::parse(&body).get("PASS").is_none());
        let quoted = format!("NAME=a PASS=\"{pw} x\" REGKEY={pw}\0");
        assert!(parse_fields(quoted.as_bytes(), is_secret).iter().all(|(k, v)| k == "NAME" || v.is_none()));
        let line = redact_body(&body);
        assert!(!line.contains(pw) && !line.contains("ABCD") && !line.contains("0123abcd") && !line.contains("gamepw"), "{line}");
        assert!(line.contains("PASS=<redacted>") && line.contains("NAME=\"Bob\""));
    }
}
