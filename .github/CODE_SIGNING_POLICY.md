# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## Status

Island HUD has applied to **SignPath Foundation** for free open-source code signing. Until that application is approved and the first signed build is published, all release artifacts remain **unsigned** and Windows SmartScreen may warn on first run.

## Team roles

- Committers and reviewers: [Angelyeye](https://github.com/Angelyeye)
- Approvers: [Angelyeye](https://github.com/Angelyeye)

Every signing request is approved manually by an approver after the release checks pass. Pull requests from non-committers are reviewed by a committer before merge.

## Artifacts covered by signing

- `IslandHUD-<version>-DSH-Setup-x64.exe` (NSIS installer)
- the NSIS uninstaller generated during packaging

The portable ZIP contains the upstream **Electron** runtime renamed to `IslandHUD.exe`. It is not compiled from this repository's source, so it may not be signed under the project's SignPath certificate. Whether the portable launcher can be covered will be confirmed with SignPath during application review; the signed installer remains the supported distribution path.

## Metadata requirements

Every signed binary has the product name `Island HUD` and the release version set through `build/icon.ico` patching and `electron-builder` configuration. SignPath artifact configurations enforce the same product name and version for each build.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. All bridge traffic stays on `127.0.0.1`; DSH session data stays in the user's own profile.

## Verifying a release

```powershell
signtool verify /pa /v .\IslandHUD-<version>-DSH-Setup-x64.exe
Get-AuthenticodeSignature .\IslandHUD-<version>-DSH-Setup-x64.exe
```

Release assets are also published with `SHA256SUMS.txt`; compare the downloaded file hash before running it. A valid signature means the binary was built from this repository by the automated build and signed by SignPath Foundation; it does not by itself guarantee that SmartScreen reputation has already accumulated.
