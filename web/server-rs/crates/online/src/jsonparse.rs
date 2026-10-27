//! `JSON.parse` for the two files the online host reads (stats.json, buddies.json), as lenient as V8 where
//! serde_json is stricter, and with V8's error messages (the console line of a file that does not parse quotes
//! one).  What serde_json would refuse and V8 takes:
//!
//! - a number beyond the doubles (1e400): V8 reads Infinity.  A `serde_json::Value` cannot hold one, so it is read as
//!   `true`: every rule of the two loaders treats Infinity and `true` alike (not a finite number, a truthy count
//!   block, no `name`, no `seen`, no list).
//! - an escaped lone surrogate ("\ud800"): read as U+FFFD (no string the loaders keep can hold one: names, months and
//!   track keys are checked against ASCII patterns).
//! - nesting deeper than serde_json's 128 levels: this parser keeps its own stack, and what it made is let go
//!   without recursion too ([`Parsed`]): a file nested deeper than a thread's stack (V8 reads one of millions of
//!   levels) would otherwise overflow it when dropped, and take the whole server down at its start.

use std::ops::Deref;

use serde_json::{Map, Number, Value};

const MAX_CONTEXT: usize = 10;

/// `JSON.parse(text)`: the value, or V8's message (`e.message`)
pub fn parse(text: &str) -> Result<Parsed, String> {
    let mut stack = Vec::new();
    let r = Parser { s: text.as_bytes(), text, i: 0 }.run(&mut stack);
    // (what a text that does not parse had made so far)
    for f in stack {
        match f {
            Frame::Array(a) => drop_flat(Value::Array(a)),
            Frame::Object(m, _) => drop_flat(Value::Object(m)),
        }
    }
    r.map(Parsed)
}

/// A parsed file's value: read through `Deref`; let go without recursion, however deep it is (a serde_json `Value`
/// drops each level from the one above it, a stack frame a level).  The loaders only borrow from it (a clone of a
/// part would recurse the same way).
#[derive(Debug)]
pub struct Parsed(Value);

impl Deref for Parsed {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.0
    }
}

impl Drop for Parsed {
    fn drop(&mut self) {
        drop_flat(std::mem::take(&mut self.0));
    }
}

/// a value let go level by level: each array or object's members are moved out before it goes
fn drop_flat(v: Value) {
    let mut todo = vec![v];
    while let Some(v) = todo.pop() {
        match v {
            Value::Array(a) => todo.extend(a),
            Value::Object(m) => todo.extend(m.into_iter().map(|(_, v)| v)),
            _ => {}
        }
    }
}

enum Frame {
    Array(Vec<Value>),
    Object(Map<String, Value>, String),
}

struct Parser<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn skip_ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.i += 1;
        }
    }

    /// the value (what a text that does not parse made is left on `stack`, for `parse` to let go)
    fn run(&mut self, stack: &mut Vec<Frame>) -> Result<Value, String> {
        'value: loop {
            self.skip_ws();
            let mut v = match self.peek() {
                Some(b'{') => {
                    self.i += 1;
                    self.skip_ws();
                    if self.peek() == Some(b'}') {
                        self.i += 1;
                        Value::Object(Map::new())
                    } else {
                        let key = self.key("Expected property name or '}'")?;
                        stack.push(Frame::Object(Map::new(), key));
                        continue 'value;
                    }
                }
                Some(b'[') => {
                    self.i += 1;
                    self.skip_ws();
                    if self.peek() == Some(b']') {
                        self.i += 1;
                        Value::Array(Vec::new())
                    } else {
                        stack.push(Frame::Array(Vec::new()));
                        continue 'value;
                    }
                }
                Some(b'"') => {
                    self.i += 1;
                    Value::String(self.string()?)
                }
                Some(b'-' | b'0'..=b'9') => self.number()?,
                Some(b't') => self.literal("true", Value::Bool(true))?,
                Some(b'f') => self.literal("false", Value::Bool(false))?,
                Some(b'n') => self.literal("null", Value::Null)?,
                _ => return Err(self.unexpected()),
            };
            loop {
                match stack.last_mut() {
                    None => {
                        self.skip_ws();
                        if self.i < self.s.len() {
                            let (pos, line, col) = self.location();
                            drop_flat(v);
                            return Err(format!(
                                "Unexpected non-whitespace character after JSON at position {pos} (line {line} column {col})"
                            ));
                        }
                        return Ok(v);
                    }
                    Some(Frame::Array(a)) => {
                        a.push(v);
                        self.skip_ws();
                        match self.peek() {
                            Some(b',') => {
                                self.i += 1;
                                continue 'value;
                            }
                            Some(b']') => {
                                self.i += 1;
                                let Some(Frame::Array(a)) = stack.pop() else { unreachable!() };
                                v = Value::Array(a);
                            }
                            _ => return Err(self.at("Expected ',' or ']' after array element")),
                        }
                    }
                    Some(Frame::Object(m, k)) => {
                        // a repeated key: the last value, in the first one's place (as JSON.parse)
                        m.insert(std::mem::take(k), v);
                        self.skip_ws();
                        match self.peek() {
                            Some(b',') => {
                                self.i += 1;
                                self.skip_ws();
                                let key = self.key("Expected double-quoted property name")?;
                                if let Some(Frame::Object(_, k)) = stack.last_mut() {
                                    *k = key;
                                }
                                continue 'value;
                            }
                            Some(b'}') => {
                                self.i += 1;
                                let Some(Frame::Object(m, _)) = stack.pop() else { unreachable!() };
                                v = Value::Object(m);
                            }
                            _ => return Err(self.at("Expected ',' or '}' after property value")),
                        }
                    }
                }
            }
        }
    }

    /// a property name and its colon (whitespace before it skipped)
    fn key(&mut self, missing: &str) -> Result<String, String> {
        if self.peek() != Some(b'"') {
            return Err(self.at(missing));
        }
        self.i += 1;
        let k = self.string()?;
        self.skip_ws();
        if self.peek() != Some(b':') {
            return Err(self.at("Expected ':' after property name"));
        }
        self.i += 1;
        Ok(k)
    }

    /// the rest of a string (the opening quote taken)
    fn string(&mut self) -> Result<String, String> {
        let mut out = String::new();
        let mut units: Vec<u16> = Vec::new();
        loop {
            let start = self.i;
            while let Some(c) = self.peek() {
                if c == b'"' || c == b'\\' || c < 0x20 {
                    break;
                }
                self.i += 1;
            }
            if self.i > start {
                flush_units(&mut units, &mut out);
                out.push_str(&self.text[start..self.i]);
            }
            match self.peek() {
                None => return Err(self.at("Unterminated string")),
                Some(b'"') => {
                    self.i += 1;
                    flush_units(&mut units, &mut out);
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let e = self.peek();
                    let simple = match e {
                        Some(b'"') => Some('"'),
                        Some(b'\\') => Some('\\'),
                        Some(b'/') => Some('/'),
                        Some(b'b') => Some('\u{8}'),
                        Some(b'f') => Some('\u{c}'),
                        Some(b'n') => Some('\n'),
                        Some(b'r') => Some('\r'),
                        Some(b't') => Some('\t'),
                        _ => None,
                    };
                    if let Some(c) = simple {
                        flush_units(&mut units, &mut out);
                        out.push(c);
                        self.i += 1;
                    } else if e == Some(b'u') {
                        let mut v = 0u32;
                        for _ in 0..4 {
                            self.i += 1;
                            match self.peek().and_then(|c| (c as char).to_digit(16)) {
                                Some(d) => v = v * 16 + d,
                                None => return Err(self.at("Bad Unicode escape")),
                            }
                        }
                        self.i += 1;
                        units.push(v as u16);
                    } else if e.is_none() {
                        return Err(self.at("Unterminated string"));
                    } else {
                        return Err(self.at("Bad escaped character"));
                    }
                }
                Some(_) => return Err(self.at("Bad control character in string literal")),
            }
        }
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.i += 1;
                if self.peek().is_some_and(|c| c.is_ascii_digit()) {
                    return Err(self.at("Unexpected number"));
                }
            }
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.at("No number after minus sign")),
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            if !self.peek().is_some_and(|c| c.is_ascii_digit()) {
                return Err(self.at("Unterminated fractional number"));
            }
            self.digits();
        }
        if let Some(b'e' | b'E') = self.peek() {
            self.i += 1;
            if let Some(b'+' | b'-') = self.peek() {
                self.i += 1;
            }
            if !self.peek().is_some_and(|c| c.is_ascii_digit()) {
                return Err(self.at("Exponent part is missing a number"));
            }
            self.digits();
        }
        let x: f64 = self.text[start..self.i].parse().unwrap_or(f64::NAN);
        Ok(number(x))
    }

    fn digits(&mut self) {
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.i += 1;
        }
    }

    fn literal(&mut self, word: &str, v: Value) -> Result<Value, String> {
        for &w in word.as_bytes() {
            match self.peek() {
                Some(c) if c == w => self.i += 1,
                _ => return Err(self.unexpected()),
            }
        }
        Ok(v)
    }

    /// the UTF-16 position of the cursor, and its line and column (\r, \n and \r\n end a line)
    fn location(&self) -> (usize, usize, usize) {
        let u: Vec<u16> = self.text[..self.i.min(self.text.len())].encode_utf16().collect();
        let n = u.len();
        let (mut line, mut last_break, mut k) = (1, 0, 0);
        while k < n {
            if u[k] == 13 && k + 1 < n && u[k + 1] == 10 {
                k += 1;
            }
            if u[k] == 13 || u[k] == 10 {
                line += 1;
                last_break = k + 1;
            }
            k += 1;
        }
        (n, line, 1 + n - last_break)
    }

    /// "<what> in JSON at position N (line L column C)"
    fn at(&self, what: &str) -> String {
        let (pos, line, col) = self.location();
        format!("{what} in JSON at position {pos} (line {line} column {col})")
    }

    /// V8's message for a token where none fits: the end, a number, a string, else the character with some context
    fn unexpected(&self) -> String {
        let Some(c) = self.text[self.i..].chars().next() else { return "Unexpected end of JSON input".into() };
        match c {
            '-' | '0'..='9' => return self.at("Unexpected number"),
            '"' => return self.at("Unexpected string"),
            _ => {}
        }
        if matches!(self.text, "NaN" | "Infinity" | "undefined" | "[object Object]") {
            return format!("\"{}\" is not valid JSON", self.text);
        }
        let all: Vec<u16> = self.text.encode_utf16().collect();
        let pos: usize = self.text[..self.i].encode_utf16().count();
        let tok = String::from_utf16_lossy(&all[pos..pos + 1]);
        let sub = |a: usize, b: usize| String::from_utf16_lossy(&all[a..b.min(all.len())]);
        if all.len() < 2 * MAX_CONTEXT + 1 {
            format!("Unexpected token '{tok}', \"{}\" is not valid JSON", self.text)
        } else if pos < MAX_CONTEXT {
            format!("Unexpected token '{tok}', \"{}\"... is not valid JSON", sub(0, pos + MAX_CONTEXT))
        } else if pos < all.len() - MAX_CONTEXT {
            format!("Unexpected token '{tok}', ...\"{}\"... is not valid JSON", sub(pos - MAX_CONTEXT, pos + MAX_CONTEXT))
        } else {
            format!("Unexpected token '{tok}', ...\"{}\" is not valid JSON", sub(pos - MAX_CONTEXT, all.len()))
        }
    }
}

/// escaped UTF-16 units into text: pairs joined, a lone surrogate as U+FFFD
fn flush_units(units: &mut Vec<u16>, out: &mut String) {
    if !units.is_empty() {
        out.extend(char::decode_utf16(units.drain(..)).map(|r| r.unwrap_or('\u{FFFD}')));
    }
}

/// a JSON number as JS holds it: whole numbers as integers, Infinity as `true` (see the module's text)
fn number(x: f64) -> Value {
    if x.is_infinite() {
        return Value::Bool(true);
    }
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        return Value::from(x as i64);
    }
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values() {
        assert_eq!(parse(r#" {"a":[1,2.5,-0,"xé😀"],"b":{},"a":true} "#).unwrap().to_string(), r#"{"a":true,"b":{}}"#);
        assert_eq!(*parse("1e400").unwrap(), Value::Bool(true));
        assert_eq!(*parse(r#""\ud800""#).unwrap(), Value::String("\u{FFFD}".into()));
        let deep = "[".repeat(5000) + &"]".repeat(5000);
        assert!(parse(&deep).is_ok());
    }

    #[test]
    fn messages() {
        assert_eq!(parse("{not json").unwrap_err(), "Expected property name or '}' in JSON at position 1 (line 1 column 2)");
        assert_eq!(parse("").unwrap_err(), "Unexpected end of JSON input");
        assert_eq!(parse("abc").unwrap_err(), "Unexpected token 'a', \"abc\" is not valid JSON");
    }
}
