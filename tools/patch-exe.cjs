'use strict';
/**
 * Patch a Windows executable's icon + version resources with pure JS (resedit).
 *
 * rcedit's native resource APIs are blocked on this machine ("Unable to commit
 * changes"), so this uses resedit-js, which rewrites the PE resource section in
 * JavaScript. The output is unsigned (fine for a personal build).
 *
 * Usage:
 *   node island/tools/patch-exe.cjs <exe> <icon.ico> <version>
 * Example:
 *   node island/tools/patch-exe.cjs C:\IslandHUDApp\IslandHUD.exe island\build\icon.ico 0.3.0
 */
const fs = require('node:fs');
const path = require('node:path');

const ResEdit = require('resedit');

function main() {
  const [exePath, icoPath, versionArg] = process.argv.slice(2);
  if (!exePath || !icoPath) {
    console.error('usage: node patch-exe.cjs <exe> <icon.ico> [version]');
    process.exit(2);
  }
  const version = (versionArg || '0.0.0').split('.').map((n) => Number(n) || 0);
  while (version.length < 4) version.push(0);

  const exeBuf = fs.readFileSync(exePath);
  console.log(`read ${path.basename(exePath)} (${(exeBuf.length / 1048576).toFixed(0)} MB)`);

  const exe = ResEdit.NtExecutable.from(exeBuf, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const iconGroupId = groups.length ? groups[0].id : 101;
  const iconLang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    iconGroupId,
    iconLang,
    iconFile.icons.map((item) => item.data),
  );
  console.log(`icon: group ${iconGroupId}/${iconLang}, ${iconFile.icons.length} images`);

  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (viList.length) {
    const vi = viList[0];
    vi.setFileVersion(version[0], version[1], version[2], version[3], 1033);
    if (typeof vi.setProductVersion === 'function') {
      vi.setProductVersion(version[0], version[1], version[2], version[3], 1033);
    }
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: 'Island HUD',
      FileDescription: 'Island HUD for Windows',
      CompanyName: 'Island HUD',
      OriginalFilename: 'IslandHUD.exe',
      InternalName: 'IslandHUD',
      LegalCopyright: 'Personal build',
    });
    vi.outputToResourceEntries(res.entries);
    console.log('version: ' + version.join('.'));
  } else {
    console.warn('no version resource found; icon only');
  }

  res.outputResource(exe);
  const out = Buffer.from(exe.generate());
  const tmp = exePath + '.patched.tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, exePath);
  console.log(`patched ${path.basename(exePath)} (${(out.length / 1048576).toFixed(0)} MB)`);
}

main();
