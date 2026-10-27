import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DIST = path.join(__dirname, 'dist');
const DIST_DEV = path.join(__dirname, 'dist-dev');
const OUT = path.join(REPO, 'out/web');
const CERT_KEY = path.join(REPO, 'out/cert/key.pem');
const CERT_FILE = path.join(REPO, 'out/cert/cert.pem');
const DATA_DIR = process.env.NFSU_DATA;   // the game folder (the one with SPEED.EXE): ./run.sh sets it
if (!DATA_DIR || !fs.existsSync(DATA_DIR)) { console.error(`NFSU_DATA=<game folder> node web/server.mjs (got: ${DATA_DIR ?? 'nothing'})`); process.exit(1); }
const PORT = parseInt(process.env.PORT || '8080', 10);
// HTTPS only on request (a phone or another PC on the LAN needs it; localhost does not): it would take 8443 from compose.local.yml
const HTTPS_PORT = process.env.HTTPS_PORT ? parseInt(process.env.HTTPS_PORT, 10) : 0;
const lanIp = () => Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address ?? '<this machine>';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Case-insensitive file path resolution
function resolveCaseInsensitive(baseDir, relativePath) {
  const parts = relativePath.split(/[/\\]+/).filter(Boolean);
  let current = baseDir;
  for (const part of parts) {
    if (!fs.existsSync(current)) return null;
    const entries = fs.readdirSync(current);
    const match = entries.find(e => e.toLowerCase() === part.toLowerCase());
    if (!match) return null;
    current = path.join(current, match);
  }
  return current;
}

// Generate data manifest
let cachedManifest = null;
let lastManifestTime = 0;

function getManifest() {
  const now = Date.now();
  if (cachedManifest && now - lastManifestTime < 10000) {
    return cachedManifest;
  }
  const files = [];
  function walk(dir, relPrefix) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const fullPath = path.join(dir, ent.name);
      const relPath = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(fullPath, relPath);
      } else if (ent.isFile()) {
        const stat = fs.statSync(fullPath);
        files.push({
          p: relPath,
          s: stat.size,
          m: Math.floor(stat.mtimeMs / 1000),
        });
      }
    }
  }
  walk(DATA_DIR, '');
  cachedManifest = JSON.stringify({ files });
  lastManifestTime = now;
  return cachedManifest;
}

function sendFile(req, res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType || MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
  };

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    if (start >= total || end >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    const chunksize = end - start + 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    headers['Content-Length'] = chunksize;
    res.writeHead(206, headers);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    headers['Content-Length'] = total;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }
}

const requestHandler = (req, res) => {
  const protocol = req.socket.encrypted ? 'https' : 'http';
  const parsed = new URL(req.url, `${protocol}://${req.headers.host}`);
  let pathname = decodeURIComponent(parsed.pathname);

  console.log(`[req] ${req.method} ${pathname} (${req.socket.remoteAddress})`);

  // Default headers for SharedArrayBuffer / WebGPU
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname === '/data-manifest') {
    const json = getManifest();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
    return;
  }

  if (pathname === '/game.wasm') {
    const wasmPath = fs.existsSync(path.join(OUT, 'nfsu1.wasm')) ? path.join(OUT, 'nfsu1.wasm') : path.join(OUT, 'nfsu2.wasm');
    sendFile(req, res, wasmPath, 'application/wasm');
    return;
  }

  if (pathname === '/game.json') {
    const jsonPath = fs.existsSync(path.join(OUT, 'nfsu1.json')) ? path.join(OUT, 'nfsu1.json') : path.join(OUT, 'nfsu2.json');
    sendFile(req, res, jsonPath, 'application/json');
    return;
  }

  if (pathname.startsWith('/data/')) {
    const rel = pathname.slice('/data/'.length);
    const resolved = resolveCaseInsensitive(DATA_DIR, rel);
    if (!resolved) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File Not Found');
      return;
    }
    sendFile(req, res, resolved, 'application/octet-stream');
    return;
  }

  // Static site assets
  if (pathname === '/' || pathname === '/index.html') {
    sendFile(req, res, path.join(DIST, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  // Try DIST first, then DIST_DEV
  let localPath = path.join(DIST, pathname);
  if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
    sendFile(req, res, localPath);
    return;
  }
  localPath = path.join(DIST_DEV, pathname);
  if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
    sendFile(req, res, localPath);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
};

const httpServer = http.createServer(requestHandler);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`🎮 NFSU 1 Web Server running at:`);
  console.log(`   HTTP (Local):   http://localhost:${PORT}/`);
  console.log(`   Data:           ${DATA_DIR}`);
  console.log(`   WASM:           ${path.join(OUT, 'nfsu1.wasm')}`);
  console.log(`========================================\n`);
});

if (HTTPS_PORT && fs.existsSync(CERT_KEY) && fs.existsSync(CERT_FILE)) {
  const httpsServer = https.createServer({
    key: fs.readFileSync(CERT_KEY),
    cert: fs.readFileSync(CERT_FILE),
  }, requestHandler);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`🔒 HTTPS (WebGPU/Secure Context for Remote/LAN):`);
    console.log(`   Local:  https://localhost:${HTTPS_PORT}/`);
    console.log(`   LAN:    https://${lanIp()}:${HTTPS_PORT}/`);
    console.log(`========================================\n`);
  });
}
