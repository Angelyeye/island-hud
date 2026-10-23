'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const manifestName = 'FILE-MANIFEST.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function filesIn(root, prefix = '') {
  const files = [];
  for (const item of fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? prefix + '/' + item.name : item.name;
    if (!prefix && relative === manifestName) continue;
    if (item.isDirectory()) files.push(...filesIn(root, relative));
    else if (item.isFile()) files.push(relative);
    else throw new Error('Unexpected artifact link: ' + relative);
  }
  return files;
}
function create(root) {
  const files = filesIn(root).map(relative => {
    const bytes = fs.readFileSync(path.join(root, relative));
    return { path: relative, size: bytes.length, sha256: sha256(bytes) };
  });
  const bytes = Buffer.from(JSON.stringify({ format: 1, files }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, manifestName), bytes, { flag: 'wx' });
  return { sha256: sha256(bytes), files: files.length };
}
function verify(root, expected) {
  const bytes = fs.readFileSync(path.join(root, manifestName)), digest = sha256(bytes), manifest = JSON.parse(bytes);
  if (expected && digest !== expected) throw new Error('Artifact manifest changed');
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid artifact manifest');
  const actual = filesIn(root);
  if (actual.length !== manifest.files.length || actual.some((file, i) => file !== manifest.files[i].path)) throw new Error('Artifact file list changed');
  for (const file of manifest.files) {
    const current = fs.readFileSync(path.join(root, file.path));
    if (current.length !== file.size || sha256(current) !== file.sha256) throw new Error('Artifact file changed: ' + file.path);
  }
  return { sha256: digest, files: actual.length };
}
module.exports = { create, verify };
