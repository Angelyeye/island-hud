'use strict';
const fs = require('node:fs');
const { createDiagnosticOutput } = require('../../src/logs/diagnostic-output.cjs');

const report = process.env.ISLAND_EPIPE_REPORT;
if (!report) throw new Error('ISLAND_EPIPE_REPORT is required');
const output = createDiagnosticOutput(process.stdout, {
  onError: error => fs.appendFileSync(report, `${error.code || 'stream-error'}: ${error.message}\n`),
});
output.write('READY\n');

let lines = 0;
const timer = setInterval(() => {
  lines += 1;
  output.write(`LINE ${lines}\n`);
  if (lines >= 30) {
    clearInterval(timer);
    setTimeout(() => process.exit(0), 100);
  }
}, 40);

setTimeout(() => {
  fs.appendFileSync(report, `TIMEOUT lines=${lines}\n`);
  process.exit(3);
}, 4000).unref();
