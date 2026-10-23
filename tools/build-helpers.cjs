'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
function build() {
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('The Windows .NET Framework 4 C# compiler is required to build the bundled pipe helper');
  const source = path.join(root, 'tools/pipe-host.cs'), binary = path.join(root, 'src/tools/pipe-host.exe'), metadata = path.join(root, 'src/tools/pipe-host-build.json');
  // src/tools only contains ignored build products, so a fresh clone has no such
  // directory until the first build creates it.
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  // Source hashes are computed over LF-normalized text so that a CRLF working tree
  // (Git for Windows core.autocrlf=true) does not look like an edited C# source.
  const rawDigest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const textDigest = file => createHash('sha256').update(fs.readFileSync(file).toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
  let old; try { old = JSON.parse(fs.readFileSync(metadata, 'utf8')); } catch { /* First build. */ }
  const sourceSha256 = textDigest(source);
  if (old?.sourceSha256 === sourceSha256 && fs.existsSync(binary) && old.binarySha256 === rawDigest(binary)) return;
  execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/out:' + binary, source], { windowsHide: true, stdio: 'pipe' });
  fs.writeFileSync(metadata, JSON.stringify({ compiler: '.NET Framework 4 C#', sourceSha256, binarySha256: rawDigest(binary) }, null, 2) + '\n');
}
if (require.main === module) { build(); console.log('Compiled pipe-host from the reviewed source'); }
module.exports = { build };
