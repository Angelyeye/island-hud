'use strict';
// This produces an explicitly labelled DSH candidate build.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
async function main() {
  if (!process.argv[2]) throw new Error('Pass a new output directory');
  const out = path.resolve(process.argv[2]);
  if (fs.existsSync(out)) throw new Error('Output must be a new directory: ' + out);
  const metadata = require('../package.json'), version = metadata.version;
  require('./build-helpers.cjs').build();
  const electron = process.env.ISLAND_HUD_ELECTRON_DIST || path.join(root, 'node_modules/electron/dist');
  const actual = execFileSync(path.join(electron, 'electron.exe'), ['-p', 'process.versions.electron'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim();
  if (actual !== '33.4.11') throw new Error('Preserved Electron 33.4.11 runtime required');
  require('./build-integrations.cjs');
  const portable = path.join(out, 'portable'), appRoot = path.join(portable, 'resources/app');
  fs.mkdirSync(appRoot, { recursive: true });
  for (const entry of fs.readdirSync(electron)) {
    if (entry === 'resources') continue;
    fs.cpSync(path.join(electron, entry), path.join(portable, entry === 'electron.exe' ? 'IslandHUD.exe' : entry), { recursive: true });
  }
  const omitted = new Set();
  fs.cpSync(path.join(root, 'src'), path.join(appRoot, 'src'), { recursive: true,
    filter: source => !omitted.has(path.basename(source)) && path.basename(source) !== 'probe' });
  fs.cpSync(path.join(root, 'integrations/dsh'), path.join(appRoot, 'integrations/dsh'), { recursive: true });
  fs.cpSync(path.join(root, 'node_modules/fzstd'), path.join(appRoot, 'node_modules/fzstd'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'island-hud', productName: 'Island HUD', version,
    description: metadata.description, author: 'Angelyeye', main: 'src/main.js', type: 'commonjs', dependencies: { fzstd: '0.1.1' } }, null, 2));
  // MIT attribution for the bundled DSH preset must travel with the distributed copies.
  for (const name of ['LICENSE', 'NOTICE']) {
    fs.copyFileSync(path.join(root, name), path.join(portable, name));
    fs.copyFileSync(path.join(root, name), path.join(appRoot, name));
  }
  const status = { version, kind: 'experimental-candidate', stable: false, providers: ['dsh'], electron: actual,
    verification: 'Protocol and GUI checks do not replace real-client verification; see README for known limitations' };
  status.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  status.sourceDirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  status.helperBuild = JSON.parse(fs.readFileSync(path.join(root, 'src/tools/pipe-host-build.json'), 'utf8'));
  fs.writeFileSync(path.join(portable, '打开悬浮岛.cmd'), '@echo off\r\nset ELECTRON_RUN_AS_NODE=\r\nstart "" "%~dp0IslandHUD.exe"\r\n');
  execFileSync(process.execPath, [path.join(root, 'tools/patch-exe.cjs'), path.join(portable, 'IslandHUD.exe'), path.join(root, 'build/icon.ico'), version], { windowsHide: true, stdio: 'inherit' });
  status.portableManifest = require('./artifact-manifest.cjs').create(portable);
  fs.writeFileSync(path.join(out, 'BUILD-STATUS.json'), JSON.stringify(status, null, 2));
  const { build, Platform, Arch } = require('electron-builder');
  await build({ targets: Platform.WINDOWS.createTarget(['nsis', 'zip'], Arch.x64), prepackaged: portable, publish: 'never',
    config: { appId: 'io.github.angelyeye.islandhud', productName: 'Island HUD', electronVersion: actual,
      artifactName: 'IslandHUD-' + version + '-DSH-portable-x64.${ext}',
      directories: { output: path.join(out, 'installer'), buildResources: path.join(root, 'build') },
      npmRebuild: false, asar: false, compression: 'normal',
      win: { executableName: 'IslandHUD', icon: path.join(root, 'build/icon.ico'), signAndEditExecutable: false },
      nsis: { oneClick: false, perMachine: false, allowElevation: false, packElevateHelper: false, allowToChangeInstallationDirectory: true,
        runAfterFinish: false, createDesktopShortcut: true, createStartMenuShortcut: true, deleteAppDataOnUninstall: false,
        artifactName: `IslandHUD-${version}-DSH-Setup-x64.exe`, include: path.join(root, 'build/installer.nsh'),
        uninstallDisplayName: 'Island HUD (DSH)', shortcutName: 'Island HUD' },
    },
  });
  require('./artifact-manifest.cjs').verify(portable, status.portableManifest.sha256);
  const zipName = `IslandHUD-${version}-DSH-portable-x64.zip`;
  fs.renameSync(path.join(out, 'installer', zipName), path.join(out, zipName));
  const files = fs.readdirSync(path.join(out, 'installer')).filter(name => name.endsWith('.exe')).map(name => 'installer/' + name);
  files.push(zipName, 'portable/FILE-MANIFEST.json');
  const sums = [];
  for (const name of files) {
    sums.push(createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex') + '  ' + name);
  }
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  console.log('DSH candidate built: ' + out);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
