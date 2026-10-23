'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const lib = path.join(root, 'integrations/dsh/lib');
fs.mkdirSync(lib, { recursive: true });
for (const name of ['client', 'contract']) {
  const source = fs.readFileSync(path.join(root, `src/integrations/${name}.js`), 'utf8').replace("require('./contract')", "require('./contract.cjs')");
  fs.writeFileSync(path.join(lib, `${name}.cjs`), source);
}
console.log('DSH bundle prepared: integrations/dsh');
