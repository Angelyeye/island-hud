'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
if (!process.argv[2] || !process.argv[3]) throw new Error('Pass candidate directory and a new result directory');
const build = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]), portable = path.join(build, 'portable');
if (fs.existsSync(out)) throw new Error('Result directory must be new');
fs.mkdirSync(out, { recursive: true });
const exe = path.join(portable, 'IslandHUD.exe'), appRoot = path.join(portable, 'resources/app');
const envFor = name => {
  const env = { ...process.env, ISLAND_HUD_TEST_ROOT: path.join(out, name) };
  for (const key of Object.keys(env)) if (key !== 'ISLAND_HUD_TEST_ROOT' && (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ISLAND_')) || key === 'ISLAND_HUD_UPDATE_URL' || key === 'ISLAND_HUD_DSH_SESSIONS' || key === 'ISLAND_HUD_BRIDGE_FILE') delete env[key];
  fs.mkdirSync(env.ISLAND_HUD_TEST_ROOT, { recursive: true }); return env;
};
function run(name, args, env) {
  const result = spawnSync(exe, args, { env, cwd: portable, windowsHide: true, timeout: 25000, encoding: 'utf8' });
  fs.writeFileSync(path.join(out, name + '-stdout.log'), result.stdout || '');
  fs.writeFileSync(path.join(out, name + '-stderr.log'), result.stderr || '');
  assert.ifError(result.error); assert.equal(result.status, 0); return result;
}
const checks = [];
try {
  const artifact = require('./artifact-manifest.cjs').verify(portable, JSON.parse(fs.readFileSync(path.join(build, 'BUILD-STATUS.json'))).portableManifest.sha256);
  checks.push('complete portable runtime and resource manifest matches the build fingerprint');
  const env = envFor('startup'); env.ISLAND_TEST_DIAGNOSTICS = path.join(env.ISLAND_HUD_TEST_ROOT, 'diagnostics.json');
  run('startup', [], env);
  const diagnostics = JSON.parse(fs.readFileSync(env.ISLAND_TEST_DIAGNOSTICS, 'utf8'));
  assert.equal(diagnostics.packaged, true); assert.equal(diagnostics.version, require('../package.json').version);
  assert.equal(diagnostics.settings.autoCheckUpdates, false);
  checks.push('actual DSH packaged EXE starts in a Chinese/space path with isolated data and offline defaults');
  const visualEnv = envFor('visual'); visualEnv.ISLAND_SHOT_DIR = path.join(visualEnv.ISLAND_HUD_TEST_ROOT, 'shots');
  const visual = run('visual', ['--demo'], visualEnv);
  for (const scene of ['compact','overview','approval','ask','jump','approved','all']) assert.ok(fs.statSync(path.join(visualEnv.ISLAND_SHOT_DIR, `app-${scene}.png`)).size > 100);
  assert.doesNotMatch(visual.stdout + visual.stderr, /Uncaught|did-fail-load|render-process-gone/);
  checks.push('actual package renders and captures all seven scenes without script or load errors');
  for (const file of ['src/main.js','src/renderer/island.css','src/renderer/island.js','src/renderer/index.html','src/renderer/question-drafts.js','src/renderer/native-requests.js','src/app/dsh-integration-manager.cjs','integrations/dsh/index.mjs','src/tools/pipe-host.exe']) {
    const actual = fs.readFileSync(path.join(appRoot, file)), source = fs.readFileSync(path.join(__dirname, '..', file));
    assert.ok(actual.equals(source), 'Packaged source differs: ' + file);
  }
  checks.push('packaged DSH sources match the tested sources');
  const cleanupEnv = envFor('cleanup'), profileDir = path.join(cleanupEnv.ISLAND_HUD_TEST_ROOT, 'dsh/profiles/desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  const initial = { name: 'packaged-cleanup-fixture', dependencies: { other: 'untouched' }, dsh: { profile: { bundles: ['other'] } } };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(initial));
  const { DshIntegrationManager } = require(path.join(appRoot, 'src/app/dsh-integration-manager.cjs'));
  const manager = new DshIntegrationManager({ profileDir, dataDir: cleanupEnv.ISLAND_HUD_TEST_ROOT,
    sourceDir: path.join(appRoot, 'integrations/dsh'), descriptorPath: path.join(cleanupEnv.ISLAND_HUD_TEST_ROOT, 'integration-v2.json') });
  manager.install(); assert.equal(manager.status().installed, true);
  run('cleanup', ['--uninstall-cleanup'], cleanupEnv);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')), initial);
  assert.equal(manager.status().installed, false);
  checks.push('actual packaged uninstall-cleanup removes only its integration from an isolated profile');
  const report = { status: 'passed', version: diagnostics.version, checks, artifact, sha256: createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),
    note: 'Packaged application checks only; not real-client DSH or installer lifecycle verification.' };
  fs.writeFileSync(path.join(out, 'packaged-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: checks.length }));
} catch (error) {
  fs.writeFileSync(path.join(out, 'packaged-result.json'), JSON.stringify({ status: 'failed', checks, error: error.stack }, null, 2)); throw error;
}
