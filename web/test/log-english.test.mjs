// The game log is English, and every tool that judges a run still finds the
// markers the runtime prints:
//   node --test web/test/log-english.test.mjs
// 1. The fault, time-limit and unresolved-call markers (runtime/mem.c,
//    runtime/dispatch.c, the web runners' own time-limit line)
//    are matched by the patterns of every runner and report that looks for
//    them: the web runners' regexes and includes(), the shell greps, the
//    Python reports.  None of them still looks for the old Turkish markers.
// 2. No string literal of the runtime or the C test harnesses carries a
//    Turkish word (the runtime started from a Turkish author's port, so half
//    the log was Turkish), including the machine-readable names that
//    tools/session_report.py, lift_profile.py and bcmp.py read (perflog's file
//    names, CSV columns and meta keys, the FPSCSV header, the frame-dump file
//    names).  Comments are not checked, and neither are shader comments inside
//    shader source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// C string literals of a source, comments skipped: [{ line, text }] (text as written, escapes kept)
function cLiterals(src) {
  const out = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2), j = e < 0 ? n : e + 2;
      for (let k = i; k < j; k++) if (src[k] === '\n') line++;
      i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, text = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < n) { text += src[j] + src[j + 1]; j += 2; continue; }
        text += src[j++];
      }
      if (c === '"') out.push({ line, text });
      i = j + 1; continue;
    }
    i++;
  }
  return out;
}

// a printf format rendered the way it prints (specifiers -> sample values), split into lines
function render(fmt) {
  return fmt.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t')
    .replace(/%%/g, '\u0000').replace(/%[-+ #0-9.*]*(?:ll|l|z|h|hh)?[diouxXfgeEcsp]/g, '1234abcd').replace(/\u0000/g, '%')
    .split('\n');
}

const MARKERS = {
  fault: ['FAULT IN GUEST', 'GUEST MEMORY FAULT', 'HOST SEGV'],
  timeout: ['TIME LIMIT REACHED'],
  unresolved: ['UNRESOLVED INDIRECT'],
};
const OLD = ['HATA GUEST', 'BELLEK HATASI', 'ZAMAN ASIMI', 'COZULEMEYEN', 'DOLAYLI'];

// the lines the runtime prints for each marker
function producedLines() {
  const lines = { fault: [], timeout: [], unresolved: [] };
  const take = (file, kind) => {
    for (const { text } of cLiterals(read(file))) {
      for (const l of render(text)) for (const m of MARKERS[kind]) if (l.includes(m)) lines[kind].push(l);
    }
  };
  take('runtime/mem.c', 'fault');
  take('runtime/dispatch.c', 'unresolved');
  // the web runners write their own time-limit line when they stop a run
  for (const f of ['web/tools/run-suite.mjs', 'web/tools/lan-pair.mjs']) {
    for (const m of read(f).matchAll(/`([^`]*TIME LIMIT REACHED[^`]*)`/g)) lines.timeout.push(m[1].replace(/\$\{[^}]*\}/g, '400'));
  }
  return lines;
}

// the patterns a consumer applies: JS regex literals and includes() strings,
// shell grep arguments (basic regex alternation \| -> |), Python raw strings
function patterns(file, src) {
  const p = [];
  if (file.endsWith('.mjs')) {
    src = src.replace(/^\s*\/\/.*$/gm, '');                    // whole-line comments
    for (const m of src.matchAll(/\/((?:[^/\n\\]|\\.)*(?:HOST SEGV|TIME LIMIT|UNRESOLVED|FAULT)(?:[^/\n\\]|\\.)*)\/([a-z]*)/g)) p.push(new RegExp(m[1], m[2]));
    for (const m of src.matchAll(/\.includes\('([^']*)'\)/g)) p.push(new RegExp(m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } else if (file.endsWith('.sh')) {
    for (const m of src.matchAll(/grep(?: -[A-Za-z]+)* "([^"]*)"/g)) p.push(new RegExp(m[1].replace(/\\\|/g, '|').replace(/\\\(/g, '\\(').replace(/\\\)/g, '\\)')));
  } else if (file.endsWith('.py')) {
    let joined = '';
    for (const m of src.matchAll(/r(["'])((?:(?!\1).)*)\1/g)) joined += m[2] + '\n';
    for (const m of joined.matchAll(/[^\n]*(?:HOST SEGV|TIME LIMIT|UNRESOLVED|FAULT)[^\n]*/g)) {
      for (const alt of m[0].split('|')) { try { p.push(new RegExp(alt.replace(/^\^?\(?/, '').replace(/\)?\$?$/, ''))); } catch {} }
    }
  }
  return p;
}

const CONSUMERS = {
  'tools/career_segments.sh': ['fault', 'timeout', 'unresolved'],
  'tools/career_report.py': ['fault', 'timeout', 'unresolved'],
  'web/tools/run-suite.mjs': ['fault', 'timeout', 'unresolved'],
  'web/tools/lan-pair.mjs': ['fault', 'timeout', 'unresolved'],
  'web/tools/input-suite.mjs': ['fault', 'timeout', 'unresolved'],
  'web/tools/shader-check.mjs': ['fault', 'timeout'],
};

test('the runtime prints every fault, time-limit and unresolved-call marker', () => {
  const lines = producedLines();
  for (const [kind, ms] of Object.entries(MARKERS)) {
    for (const m of ms) assert.ok(lines[kind].some(l => l.includes(m)), `no printed line carries '${m}'`);
  }
  assert.ok(lines.timeout.length >= 2, 'both web runners write a time-limit line');
});

test('every runner and report matches the markers the runtime prints', () => {
  const lines = producedLines();
  for (const [file, kinds] of Object.entries(CONSUMERS)) {
    const src = read(file);
    for (const o of OLD) assert.ok(!src.includes(o), `${file} still looks for the old marker '${o}'`);
    const pats = patterns(file, src);
    assert.ok(pats.length > 0, `${file}: no pattern found`);
    for (const kind of kinds) {
      for (const l of lines[kind]) {
        assert.ok(pats.some(re => re.test(l)), `${file} does not catch the ${kind} line ${JSON.stringify(l)}`);
      }
    }
  }
});

// Turkish words of the old log (the most frequent ones, all not English words)
const TURKISH = new Set(`kare kareler diger doku kose cizim cagri hedef dosya komut cihaz bayt kayit kez ucgen ekran yigin dolu acik gecis
  kapali sabit fonksiyon isin toplam farkli blok boyut birlestirme kup yol gecti geri yapi nesne kilit disi donus bulunamadi
  bellek atlanan anlik kosu cikis dolayli kaynak kurulamadi yazma tamponu adim cagrisi girdi fark asama tablo sanal izleme
  yakalama ornek yansima isabet bayrak basina pencere konuk yerel dogrulama bozuk adres cagiran efekt kopya atlandi oyun fazla
  yeniden iyi derlenemedi cok karisim yuva beklenen gercek bildirim tablosu zinciri sayi ofset basarisiz acildi hatasi olcek
  eski kurulum hazir uzak seviye yolu havuz sonrasi bekleme kullanim gecersiz ile saat dondu eleman dongu cikisi kayitli degil
  koruma dizi derinlik ozyineleme uyari okuma sonsuz kamera cekirdegi ornekleyici dokumu gecerli ayni kodlama kapandi ekrana
  yukleme duvar ifade farki nesnesi notu basi blogu uzun klavye olay sayildi cagrildi edilmemis calisma zamani adresleri izi
  agac kapasite dugum liste cevrim sinir dizini tutamac kontrolu acilamadi hata kurulumu kullanildi ofseti hesaplama boru depo
  onbellek karede piksel golgelendirici uretimi sabitler onceki kuruldu takas hedefi yuzeyi cizimi gecisi derleme orijinal
  uygun parametre tasti temiz uygulayici kirli karsilastirilmadi cerez kapsama cagrilan ayna uretilen akis olusturuldu giris
  sifir suresi kalan basladi koken bilinmeyen bagli oynatma bosluk imlec sessiz asimi cagirma dilim aralik cozulemeyen
  isaretci cozulemedi desteklenmeyen tavani yuru alindi sinif durumu istenen bulundu icin icinde ikinci tasmasi komutu yazildi
  toplami olarak satir ustu konum turu ortografik olmali kopyasiz bekleyen terfi sikistirma sifirlama ozet denetimi kopyasi
  maske icerik kuruluyor dagilimi gorunum dortgen kaldi yuklendi zamanlayici matris tampon ses yok sn`.split(/\s+/).filter(Boolean));

function lintFiles() {
  const list = [];
  for (const d of ['runtime', 'runtime/web']) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) if (/\.(c|m|h|inc)$/.test(f)) list.push(`${d}/${f}`);
  }
  return list;   // (NFSU2's native harness, tests/boot.c and tests/main_all.c, is not part of this port)
}

test('no Turkish word in a string literal of the runtime or the C test harnesses', () => {
  const bad = [];
  const files = lintFiles();
  assert.ok(files.length > 60, `${files.length} files`);
  for (const f of files) {
    for (const { line, text } of cLiterals(read(f))) {
      const t = text.replace(/\/\*.*?\*\//g, '');                 // shader source comments
      const words = t.replace(/\\[ntr"\\]/g, ' ').split(/[^A-Za-z\u00c0-\u024f]+|(?<=[a-z])(?=[A-Z])/).map(w => w.toLowerCase());
      const hit = words.filter(w => TURKISH.has(w));
      if (hit.length || /[\u00e7\u011f\u0131\u00f6\u015f\u00fc\u00c7\u011e\u0130\u00d6\u015e\u00dc]/.test(t)) bad.push(`${f}:${line}: [${hit.join(',')}] "${text.slice(0, 100)}"`);
    }
  }
  assert.deepEqual(bad, [], `Turkish in log strings:\n${bad.join('\n')}`);
});
