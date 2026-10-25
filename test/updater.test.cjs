'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertPublicHttpsUrl, fetchManifest } = require('../src/update/updater');

test('the update source must be a public https origin', () => {
  assertPublicHttpsUrl('https://example.com/latest.json');
  assertPublicHttpsUrl('https://github.com/Angelyeye/island-hud/releases/download/v0.3.1/latest.json');
  assertPublicHttpsUrl('https://8.8.8.8/latest.json', 'a public IP literal is not local');
  for (const bad of [
    'http://example.com/latest.json',
    'file:///C:/Windows/win.ini',
    'ftp://example.com/latest.json',
    'https://localhost/latest.json',
    'https://updates.localhost/latest.json',
    'https://printer.local/latest.json',
    'https://127.0.0.1/latest.json',
    'https://127.8.9.9/latest.json',
    'https://10.1.2.3/latest.json',
    'https://172.16.0.1/latest.json',
    'https://172.31.255.255/latest.json',
    'https://192.168.1.1/latest.json',
    'https://169.254.7.7/latest.json',
    'https://100.64.0.1/latest.json',
    'https://0.0.0.0/latest.json',
    'https://224.0.0.1/latest.json',
    'https://[::1]/latest.json',
    'https://[fe80::1]/latest.json',
    'https://[fc00::1]/latest.json',
    'https://[fd12::1]/latest.json',
    'https://[::ffff:127.0.0.1]/latest.json',
    'not a url',
  ]) {
    assert.throws(() => assertPublicHttpsUrl(bad), { message: /更新源/ }, bad);
  }
});

test('fetchManifest refuses a non-public source before any request is made', async () => {
  const realFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => { requested = true; throw new Error('must not be called'); };
  try {
    await assert.rejects(fetchManifest('http://127.0.0.1:8080/latest.json', '0.3.1'), { message: /更新源/ });
    await assert.rejects(fetchManifest('https://192.168.0.10/latest.json', '0.3.1'), { message: /更新源/ });
    assert.equal(requested, false, 'validation happens before the fetch');
  } finally {
    globalThis.fetch = realFetch;
  }
});
