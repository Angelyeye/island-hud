'use strict';
/**
 * Island HUD update check.
 *
 * Manifest format (served over HTTPS in production):
 *   {
 *     "version": "0.9.0",
 *     "url": "https://example.com/IslandHUD-Setup-0.9.0.exe",
 *     "sha256": "<hex sha256 of the installer>",
 *     "notes": "optional"
 *   }
 *
 * The updater only compares versions and reports the result. It never
 * downloads or launches installers: builds are unsigned, so the user always
 * fetches the artifact from the project's Releases page themselves.
 */

function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map((n) => Number(n) || 0);
  const pb = normalizeVersion(b).split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for manifest`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchManifest(manifestUrl, currentVersion) {
  const m = await fetchJson(manifestUrl);
  if (!m || typeof m !== 'object') throw new Error('invalid manifest');
  if (!m.version) throw new Error('manifest missing version');
  if (!m.url) throw new Error('manifest missing url');
  const latestVersion = normalizeVersion(m.version);
  // The version is displayed and compared; treat it as untrusted input.
  if (!/^[0-9]+(\.[0-9]+)*$/.test(latestVersion)) throw new Error('manifest version invalid');
  return {
    latestVersion,
    currentVersion: normalizeVersion(currentVersion),
    newer: compareVersions(latestVersion, currentVersion) > 0,
    url: String(m.url),
    sha256: m.sha256 ? String(m.sha256).trim().toLowerCase() : '',
    notes: m.notes ? String(m.notes) : '',
  };
}

const RELEASES_URL = 'https://github.com/Angelyeye/island-hud/releases';

module.exports = {
  normalizeVersion,
  compareVersions,
  fetchManifest,
  RELEASES_URL,
};
