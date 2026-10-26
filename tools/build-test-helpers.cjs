'use strict';
// Test-only C# helpers. They are compiled from reviewed sources like the bundled
// helpers but are never shipped inside the app, so their build metadata stays
// out of BUILD-STATUS.json and package-dsh omits the binary.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const HELPERS = [
  { name: 'input-helper', source: 'tools/input-helper.cs' },
];
function build() {
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('The Windows .NET Framework 4 C# compiler is required to build the test helpers');
  fs.mkdirSync(path.join(root, 'src/tools'), { recursive: true });
  const rawDigest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const textDigest = file => createHash('sha256').update(fs.readFileSync(file).toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
  for (const helper of HELPERS) {
    const source = path.join(root, helper.source);
    const binary = path.join(root, 'src/tools', helper.name + '.exe');
    const metadata = path.join(root, 'src/tools', helper.name + '-build.json');
    let old; try { old = JSON.parse(fs.readFileSync(metadata, 'utf8')); } catch { /* First build. */ }
    const sourceSha256 = textDigest(source);
    if (old?.sourceSha256 === sourceSha256 && fs.existsSync(binary) && old.binarySha256 === rawDigest(binary)) continue;
    execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/out:' + binary, source], { windowsHide: true, stdio: 'pipe' });
    fs.writeFileSync(metadata, JSON.stringify({ compiler: '.NET Framework 4 C#', sourceSha256, binarySha256: rawDigest(binary) }, null, 2) + '\n');
  }
}
if (require.main === module) { build(); console.log('Compiled ' + HELPERS.map(helper => helper.name).join(', ') + ' for the GUI suites'); }
module.exports = { build, HELPERS };
