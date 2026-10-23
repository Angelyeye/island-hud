'use strict';
/**
 * Tiny self-hosted update server for Island HUD releases.
 *
 * Serves a release folder produced by island\tools\release.ps1:
 *   latest.json
 *   IslandHUD-Setup-<version>.exe
 *
 * Usage:
 *   node island\tools\update-server.cjs [dir] [port]
 * Defaults: C:\IslandHUDReleases and 8899 (bound to 127.0.0.1).
 *
 * For a real deployment put latest.json + installer on any HTTPS static host;
 * the app only needs the absolute URL to latest.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(process.argv[2] || 'C:\\IslandHUDReleases');
const PORT = Number(process.argv[3] || 8899);
const HOST = process.env.UPDATE_HOST || '127.0.0.1';

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const name = url === '/' ? 'latest.json' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, name);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', name }));
    return;
  }
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  console.log(`${new Date().toISOString()} ${req.method} /${name} ${stat.size}`);
});

server.listen(PORT, HOST, () => {
  console.log(`Island HUD update server: http://${HOST}:${PORT}/latest.json (root ${ROOT})`);
});
