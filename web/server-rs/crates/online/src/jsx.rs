//! The JavaScript rules the online host keeps from the Node server it replaced, beyond nfsu2_util::js, so that a
//! field the game sends reads as the same number and a text is cut in the same place: `Number(s)` and what `| 0`
//! and `>>> 0` make of it, latin1 buffers, slices in UTF-16 code units, `Math.round`, and the few patterns of names
//! and text written out by hand.  Every text the online host reads comes from latin1 bytes (aries.rs), so its
//! strings hold characters up to U+00FF only; the helpers still follow JS for any string.

use nfsu2_util::js;
use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_normalization::UnicodeNormalization;

/// JS `Number(s)` of a string: JS white space trimmed, "" is 0, decimal (with "Infinity"), 0x/0o/0b, else NaN.
pub fn to_number(s: &str) -> f64 {
    let t = js::trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let b = t.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            return radix_number(&t[2..], radix);
        }
    }
    let (sign, rest) = match b[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if rest == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal(rest) {
        return f64::NAN;
    }
    // the grammar is checked: Rust's parser rounds as JS does (to the nearest double)
    sign * rest.parse::<f64>().unwrap_or(f64::NAN)
}

/// StrUnsignedDecimalLiteral without "Infinity": digits, an optional fraction, an optional exponent
fn is_decimal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let s0 = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - s0
    };
    let mut n = digits(&mut i);
    if i < b.len() && b[i] == b'.' {
        i += 1;
        n += digits(&mut i);
    }
    if n == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

/// the digits of a 0x/0o/0b literal, rounded to the nearest double as JS rounds them
fn radix_number(s: &str, radix: u32) -> f64 {
    if s.is_empty() {
        return f64::NAN;
    }
    let bits = radix.trailing_zeros();
    let (mut acc, mut shift, mut sticky) = (0u128, 0i32, false);
    for c in s.chars() {
        let Some(d) = c.to_digit(radix) else { return f64::NAN };
        if acc < (1u128 << (128 - bits)) {
            acc = (acc << bits) | d as u128;
        } else {
            shift += bits as i32;
            sticky |= d != 0;
        }
    }
    // more than 128 bits: the lowest kept bit stands for what was cut (it is far below the double's precision,
    // so it only breaks a tie the way the exact value would)
    if sticky {
        acc |= 1;
    }
    (acc as f64) * 2f64.powi(shift)
}

/// JS ToInt32 (`x | 0`)
pub fn to_int32(x: f64) -> i32 {
    to_uint32(x) as i32
}

/// JS ToUint32 (`x >>> 0`)
pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    x.trunc().rem_euclid(4_294_967_296.0) as u32
}

/// JS `Math.round`: the nearest integer, a half up
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let r = x.floor();
    if x - r >= 0.5 { r + 1.0 } else { r }
}

/// Node's `Buffer.from(s, 'latin1')`: the low byte of each UTF-16 code unit
pub fn latin1_encode(s: &str, out: &mut Vec<u8>) {
    for c in s.chars() {
        let u = c as u32;
        if u <= 0xFFFF {
            out.push(u as u8);
        } else {
            let v = u - 0x10000;
            out.push((0xD800 + (v >> 10)) as u8);
            out.push((0xDC00 + (v & 0x3FF)) as u8);
        }
    }
}

/// Node's `buf.toString('latin1')`: each byte a character
pub fn latin1_decode(b: &[u8]) -> String {
    b.iter().map(|&x| x as char).collect()
}

/// JS `s.slice(0, n)` in UTF-16 code units (a pair the cut would split is left out: the online host's strings are
/// latin1 and have none)
pub fn slice16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// what the game lets one type for a persona or account (letters, digits, - and _), 3 to 15
/// characters
pub fn valid_name(s: &str) -> bool {
    (3..=15).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// text another player will see (chat, game names): NFC, control and format
/// characters as spaces, white space collapsed and trimmed, at most max code points
pub fn clean_text(s: &str, max: usize) -> String {
    let nfc: String = s.nfc().collect();
    let spaced: String = nfc
        .chars()
        .map(|c| match get_general_category(c) {
            GeneralCategory::Control | GeneralCategory::Format => ' ',
            _ => c,
        })
        .collect();
    let collapsed = js::collapse_space(&spaced, " ");
    js::trim(&collapsed).chars().take(max).collect()
}

/// JS line terminators: where `.` stops
fn line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// the name before a "@domain" or "/resource" (EA Messenger's USER): the pattern `[@/].*$` cut off.  `.` does not
/// cross a line terminator and `$` is the end of the text, so the cut is at the first @ or / after the last line
/// terminator.
pub fn strip_at(s: &str) -> &str {
    let from = s.char_indices().rfind(|(_, c)| line_terminator(*c)).map_or(0, |(i, c)| i + c.len_utf8());
    match s[from..].find(['@', '/']) {
        Some(i) => &s[..from + i],
        None => s,
    }
}

/// JS `toLowerCase()`
pub fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// a day as the lobby writes it, "2026.1.5" (UTC, no leading zeros), of a time in ms since 1970
pub fn day(t: f64) -> String {
    let (y, m, d, ..) = js::utc_parts(t.trunc() as i64);
    format!("{y}.{m}.{d}")
}

/// `YYYY-MM` (UTC) of a time in ms since 1970: the month the results and the friends lists keep
pub fn month_of(t: f64) -> String {
    let (y, m, ..) = js::utc_parts(t.trunc() as i64);
    format!("{y}-{m:02}")
}

/// a month as the files keep it: `YYYY-MM`, in digits
pub fn is_month(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit())
}

/// lowercase hex
pub fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_as_js_reads_them() {
        for (s, v) in [
            ("0x1F", 31.0),
            (" 12 ", 12.0),
            ("1e3", 1000.0),
            ("", 0.0),
            ("Infinity", f64::INFINITY),
            (".5", 0.5),
            ("5.", 5.0),
            ("0b101", 5.0),
            ("0o17", 15.0),
            ("\u{a0}12", 12.0),
            ("-Infinity", f64::NEG_INFINITY),
            ("+7", 7.0),
            ("0x", f64::NAN),
            ("-0x1", f64::NAN),
            ("1_0", f64::NAN),
            ("inf", f64::NAN),
            ("nan", f64::NAN),
            ("1e", f64::NAN),
            (".", f64::NAN),
            ("0xFFFFFFFFFFFFFFFFF", 295147905179352830000.0),
            ("00012", 12.0),
        ] {
            let got = to_number(s);
            assert!(got == v || (got.is_nan() && v.is_nan()), "{s:?}: {got}");
        }
        assert_eq!(to_int32(to_number("4294967297")), 1);
        assert_eq!(to_int32(to_number("2147483648")), -2147483648);
        assert_eq!(to_uint32(to_number("-1")), 4294967295);
        assert_eq!(to_uint32(to_number("x")), 0);
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
    }

    #[test]
    fn text() {
        assert_eq!(strip_at("a@b"), "a");
        assert_eq!(strip_at("a@b\nc"), "a@b\nc");
        assert_eq!(strip_at("a@b\u{2028}c@d"), "a@b\u{2028}c");
        assert_eq!(strip_at("x/y"), "x");
        assert_eq!(clean_text("hello \u{9b} there\u{7}", 255), "hello there");
        assert_eq!(clean_text("  a\u{ad}b  ", 255), "a b");
        assert_eq!(clean_text("abcdef", 3), "abc");
        assert_eq!(slice16("a\u{1F600}b", 2), "a");
        assert!(valid_name("Speedy") && !valid_name("x y") && !valid_name("ab") && !valid_name("abcdefghijklmnop"));
        assert_eq!(day(1_000_000.0), "1970.1.1");
        assert_eq!(month_of(1_792_565_740_123.0), "2026-10");
        let mut b = Vec::new();
        latin1_encode("A\u{100}\u{1F600}", &mut b);
        assert_eq!(b, [0x41, 0x00, 0x3d, 0x00]);
    }
}
