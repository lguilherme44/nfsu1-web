#!/usr/bin/env python3
"""
lang_tool.py - Extract and rebuild EA NFSU1 language .bin files.
"""

import struct
import sys
import os
import json

def unpack_lang_bin(path):
    with open(path, 'rb') as f:
        data = f.read()

    # Search for chunk 0x00039000
    pos = 0
    chunk_data = None
    while pos < len(data) - 8:
        cid, length = struct.unpack('<II', data[pos:pos+8])
        if cid == 0x00039000:
            chunk_data = data[pos+8 : pos+8+length]
            break
        pos += 8 + length

    if not chunk_data:
        raise ValueError("Language chunk 0x00039000 not found")

    hdr = struct.unpack('<IIII', chunk_data[:16])
    magic, num_entries, num_strings, str_block_offset = hdr
    print(f"Header: magic={magic}, entries={num_entries}, strings={num_strings}, str_offset={str_block_offset}")

    entries = []
    # Entry table starts at offset 16, each entry is 8 bytes: (key_hash, str_offset_relative)
    for i in range(num_entries):
        epos = 16 + i * 8
        key_hash, rel_offset = struct.unpack('<II', chunk_data[epos:epos+8])
        abs_offset = str_block_offset + rel_offset
        if abs_offset < len(chunk_data):
            raw = chunk_data[abs_offset:].split(b'\x00')[0]
            text = raw.decode('latin1', 'replace')
        else:
            text = ""
        entries.append({
            'index': i,
            'key': f"0x{key_hash:08x}",
            'rel_offset': rel_offset,
            'text': text
        })

    return entries, data

def dump_to_json(bin_path, out_json):
    entries, _ = unpack_lang_bin(bin_path)
    with open(out_json, 'w', encoding='utf-8') as f:
        json.dump(entries, f, indent=2, ensure_ascii=False)
    print(f"Dumped {len(entries)} entries to {out_json}")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit('usage: lang_tool.py <game>/Languages/English.bin tools/strings_en.json   (the output is EA text: never commit it)')
    src, dst = sys.argv[1], sys.argv[2]
    dump_to_json(src, dst)
