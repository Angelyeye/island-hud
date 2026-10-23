'use strict';
/**
 * Island HUD bridge transport (Windows).
 *
 * The DSH plugin talks to the app through a per-process named pipe hosted by
 * the bundled pipe-host helper; the helper forwards frames to this loopback
 * TCP server. The v2 descriptor (integration-v2.json) carries the pipe name
 * and a random per-launch token that every envelope must present.
 *
 * Security posture (v0.1):
 * - Random pipe name + 192-bit per-launch token, descriptor under LocalAppData
 * - Mismatched token closes the socket; frames are validated by the hub
 * - Descriptor ACL is hardened with icacls (current user + SYSTEM + Administrators)
 * - The helper creates the named pipe with an explicit per-user DACL
 *
 * The legacy v1 intervention callbacks are retained only as the transport base;
 * Island HUD itself uses the v2 hub path.
 */
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const VERSION = 1;
const DEFAULT_TIMEOUT_MS = 60_000;

function defaultDescriptorPath() {
  if (process.env.ISLAND_HUD_BRIDGE_FILE) return process.env.ISLAND_HUD_BRIDGE_FILE;
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(root, 'IslandHUD', 'bridge.json');
}

class BridgeServer {
  constructor({ onIntervention = () => {}, onCancel = () => {}, log = () => {}, descriptorPath, helperPath = '' } = {}) {
    this.onIntervention = onIntervention;
    this.onCancel = onCancel;
    this.log = log;
    this.descriptorPath = descriptorPath || defaultDescriptorPath();
    this.helperPath = helperPath;
    this.server = null;
    this.tcpServer = null;
    this.helper = null;
    this.secured = false;
    this.started = false;
    this.stopped = false;
    this.pipeName = '';
    this.pipePath = '';
    this.token = '';
    this.pending = new Map();
    this.startedAt = 0;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    this.token = crypto.randomBytes(24).toString('hex');
    this.pipeName = `island-hud-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.pipePath = `\\\\.\\pipe\\${this.pipeName}`;

    try {
      fs.mkdirSync(path.dirname(this.descriptorPath), { recursive: true });
    } catch { /* ignore */ }

    this.tcpServer = net.createServer((sock) => this.handleSocket(sock));
    this.tcpServer.on('error', (e) => this.log('bridge tcp error: ' + e.message));
    this.tcpServer.listen(0, '127.0.0.1', () => {
      const port = this.tcpServer.address().port;
      this.log(`bridge tcp listening 127.0.0.1:${port}`);
      if (this.helperPath && fs.existsSync(this.helperPath)) {
        this.startHelper(port);
      } else {
        this.log('bridge helper missing; using direct named pipe (no custom ACL)');
        this.startDirectPipe();
      }
    });
  }

  /** Spawn the C# helper that hosts the pipe with an explicit per-user DACL. */
  startHelper(port) {
    if (this.stopped || this.secured) return;
    let ready = false;
    try {
      this.helper = spawn(this.helperPath, [this.pipeName, String(port), String(process.pid)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.log('bridge helper spawn failed: ' + e.message);
      this.startDirectPipe();
      return;
    }
    const timer = setTimeout(() => {
      if (!ready && !this.stopped) {
        this.log('bridge helper timeout; falling back to direct pipe');
        try { this.helper?.kill(); } catch { /* ignore */ }
        this.helper = null;
        this.startDirectPipe();
      }
    }, 5000);
    let outBuf = '';
    this.helper.stdout.on('data', (data) => {
      outBuf += data.toString();
      let idx;
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx).trim();
        outBuf = outBuf.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith('ACL ')) {
          this.log('bridge pipe ' + line);
        } else if (line === 'READY' && !ready) {
          ready = true;
          clearTimeout(timer);
          this.secured = true;
          this.writeDescriptor();
          this.log(`bridge listening ${this.pipePath} (secured pipe)`);
        }
      }
    });
    this.helper.stderr.on('data', (d) => this.log('bridge helper: ' + d.toString().trim().slice(0, 300)));
    this.helper.on('exit', (code) => {
      this.log('bridge helper exited ' + code);
      this.helper = null;
      clearTimeout(timer);
      if (!this.stopped) this.startDirectPipe();
    });
  }

  startDirectPipe() {
    if (this.server || this.stopped) return;
    this.server = net.createServer((sock) => this.handleSocket(sock));
    this.server.on('error', (e) => this.log('bridge pipe error: ' + e.message));
    this.server.listen(this.pipePath, () => {
      if (!this.secured) this.writeDescriptor();
      this.log(`bridge listening ${this.pipePath} (direct pipe fallback)`);
    });
  }

  writeDescriptor() {
    const d = {
      v: VERSION,
      pipe: this.pipeName,
      token: this.token,
      pid: process.pid,
      createdAt: this.startedAt,
    };
    try {
      const tmp = this.descriptorPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
      fs.renameSync(tmp, this.descriptorPath);
      this.hardenDescriptor();
    } catch (e) {
      this.log('bridge descriptor write failed: ' + e.message);
    }
  }

  /** Best-effort per-user ACL: only current user + SYSTEM + Administrators. */
  hardenDescriptor() {
    execFile('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) return;
      const m = /S-1-5-[\d-]+/.exec(String(stdout));
      if (!m) return;
      const sid = m[0];
      execFile('icacls', [
        this.descriptorPath,
        '/inheritance:r',
        '/grant:r', `*${sid}:F`,
        '*S-1-5-18:F',      // SYSTEM
        '*S-1-5-32-544:F',  // Administrators
      ], { windowsHide: true, timeout: 5000 }, (err2, _so, se) => {
        if (err2) this.log('bridge ACL failed: ' + String(se || err2.message).trim());
        else this.log('bridge ACL hardened (user+SYSTEM+Administrators)');
      });
    });
  }

  handleSocket(sock) {
    let buf = '';
    let handled = false;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        if (handled) { sock.destroy(); return; }
        handled = true;
        let msg;
        try { msg = JSON.parse(line); } catch { sock.destroy(); return; }
        this.handleMessage(msg, sock);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => this.cleanupSocket(sock));
  }

  handleMessage(msg, sock) {
    if (!msg || msg.v !== VERSION || msg.token !== this.token
      || !msg.id || (msg.kind !== 'approval' && msg.kind !== 'question')) {
      this.log('bridge reject envelope');
      sock.destroy();
      return;
    }
    const timeoutMs = Math.max(5_000, Math.min(300_000, Number(msg.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const rec = {
      sock,
      msg,
      timer: setTimeout(() => {
        this.log(`bridge timeout ${msg.id}`);
        this.pending.delete(msg.id);
        try { this.onCancel(msg.id); } catch { /* ignore */ }
        sock.destroy();
      }, timeoutMs),
    };
    this.pending.set(msg.id, rec);
    this.log(`bridge intervention ${msg.kind} ${msg.id} (${msg.agent || 'unknown'})`);
    try {
      this.onIntervention({
        id: msg.id,
        kind: msg.kind,
        agent: msg.agent || '',
        payload: msg.payload || {},
        timeoutMs,
        receivedAt: Date.now(),
      });
    } catch (e) {
      this.log('onIntervention failed: ' + e.message);
    }
  }

  respond(id, decision, extra = {}) {
    const rec = this.pending.get(id);
    if (!rec) return false;
    clearTimeout(rec.timer);
    this.pending.delete(id);
    try {
      rec.sock.write(JSON.stringify({ v: VERSION, id, decision, ...extra }) + '\n');
      rec.sock.end();
    } catch { /* ignore */ }
    this.log(`bridge respond ${id} ${decision}${extra.optionIndex != null ? '#' + extra.optionIndex : ''}`);
    return true;
  }

  cancel(id) {
    const rec = this.pending.get(id);
    if (!rec) return false;
    clearTimeout(rec.timer);
    this.pending.delete(id);
    try { rec.sock.destroy(); } catch { /* ignore */ }
    this.log('bridge cancel ' + id);
    return true;
  }

  cleanupSocket(sock) {
    for (const [id, rec] of this.pending) {
      if (rec.sock === sock) {
        clearTimeout(rec.timer);
        this.pending.delete(id);
        this.log('bridge client disconnected ' + id);
        try { this.onCancel(id); } catch { /* ignore */ }
      }
    }
  }

  getStatus() {
    return {
      mode: this.secured ? 'secured-pipe' : (this.server ? 'direct-pipe' : 'tcp-only'),
      secured: this.secured,
      tcpPort: this.tcpServer ? this.tcpServer.address()?.port : 0,
      pending: this.pending.size,
    };
  }

  stop() {
    this.stopped = true;
    for (const [, rec] of this.pending) {
      clearTimeout(rec.timer);
      try { rec.sock.destroy(); } catch { /* ignore */ }
    }
    this.pending.clear();
    if (this.helper) {
      try { this.helper.kill(); } catch { /* ignore */ }
      this.helper = null;
    }
    if (this.tcpServer) {
      try { this.tcpServer.close(); } catch { /* ignore */ }
      this.tcpServer = null;
    }
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
    }
    try {
      if (fs.existsSync(this.descriptorPath)) {
        const d = JSON.parse(fs.readFileSync(this.descriptorPath, 'utf8'));
        if (d.pid === process.pid) fs.unlinkSync(this.descriptorPath);
      }
    } catch { /* ignore */ }
  }
}

module.exports = { BridgeServer, VERSION, defaultDescriptorPath };
