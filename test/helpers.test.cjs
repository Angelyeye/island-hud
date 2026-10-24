'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');

// CI builds the helpers (npm run build:helpers) before running the tests, so a
// missing or stale binary fails here instead of at app runtime.
for (const helper of require('../tools/build-helpers.cjs').HELPERS) {
  test(`bundled helper ${helper.name} is built from the reviewed source`, () => {
    const binary = path.join(root, 'src/tools', helper.name + '.exe');
    const metadata = path.join(root, 'src/tools', helper.name + '-build.json');
    assert.ok(fs.existsSync(binary), `${helper.name}.exe missing; run npm run build:helpers`);
    const meta = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    assert.equal(meta.compiler, '.NET Framework 4 C#');
    const sourceSha = createHash('sha256')
      .update(fs.readFileSync(path.join(root, helper.source)).toString('utf8').replace(/\r\n/g, '\n'))
      .digest('hex');
    assert.equal(meta.sourceSha256, sourceSha, `${helper.source} changed since the last build`);
    assert.equal(createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), meta.binarySha256);
  });
}

test('packaging requires every helper listed by build-helpers', () => {
  const packager = fs.readFileSync(path.join(root, 'tools/package-dsh.cjs'), 'utf8');
  for (const helper of require('../tools/build-helpers.cjs').HELPERS) {
    assert.ok(packager.includes(`'${helper.name}'`), `package-dsh must record ${helper.name} build metadata`);
  }
});
