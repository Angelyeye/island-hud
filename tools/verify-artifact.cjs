'use strict';
const fs = require('node:fs');
const path = require('node:path');
if (!process.argv[2]) throw new Error('Pass an extracted portable directory, optional manifest SHA-256 and optional report path');
const result = { status: 'passed', check: 'Complete extracted portable files match the tested build manifest',
  ...require('./artifact-manifest.cjs').verify(path.resolve(process.argv[2]), process.argv[3]) };
if (process.argv[4]) fs.writeFileSync(path.resolve(process.argv[4]), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
