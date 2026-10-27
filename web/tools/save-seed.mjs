// A save tree (NFSU2_SAVE_SEED, a player's "Download a backup" unzipped, the
// Mac port's work/seed/...) written into a page's OPFS save directory, from a
// page of the server's origin; the test page then runs without &fresh.
// Used by run-suite.mjs and roam-pair.mjs (--seed).
import fs from 'node:fs';
import path from 'node:path';

export async function seedSave(page, base, dir, tree) {
  const files = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) files.push([r, fs.readFileSync(path.join(d, e.name)).toString('base64')]);
    }
  })(tree, '');
  await page.goto(`${base}/players`);
  return page.evaluate(async ([dir, files]) => {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry(dir, { recursive: true }); } catch { /* none yet */ }
    const top = await root.getDirectoryHandle(dir, { create: true });
    for (const [rel, b64] of files) {
      const parts = rel.split('/'); let d = top;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); await w.close();
    }
    return files.length;
  }, [dir, files]);
}
