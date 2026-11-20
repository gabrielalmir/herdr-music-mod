# Herdr Music

A Spotify Connect mini-player for Herdr on Windows.

Extract the Windows ZIP and run `.\Install-Music.ps1` in PowerShell. Open
**Music** from the `avlye-layout` tab bar. See the [installation guide](docs/install.md)
for Spotify setup and updates.

The offline package includes [Avlye Layout](https://github.com/gabrielalmir/herdr-avlye-layout)
v1.1.1 and [Herdr Vault](https://github.com/gabrielalmir/herdr-vault) v1.0.0.
Release archives and checksums are recorded in
[shared-dependencies.json](shared-dependencies.json).

## Development

Use npm with Node.js 20.19+, 22.13+, or 24 and newer. In a fresh checkout, run
`powershell -File scripts/fetch-dependencies.ps1` to prepare the ignored
dependency directories. Then run
`herdr-app check mods/herdr-music` with the same Herdr version you use to run the
mod. Keep the Herdr-generated `gpui-kit.d.ts` next to `main.js` for TypeScript.
If the file already exists in `HERDR_APP_HOME/mods/herdr-music`, copy it to
`mods/herdr-music/gpui-kit.d.ts` in your working copy.

```sh
npm ci
npm run check
```

- `npm run lint` reports the file, line, column, and ESLint rule for each issue.
- `npm run typecheck` reports the location and diagnostic code for type errors.
  If TypeScript cannot find the declaration file or Herdr modules, check that
  `gpui-kit.d.ts` is present.
- `npm test` runs local tests for PKCE, vault encryption, token renewal,
  disconnecting, and API errors.
- `herdr-app check mods/herdr-music` verifies that the mod loads and renders
  initially. To test the running panel, use an isolated `HERDR_APP_HOME` and
  exercise the disconnected state, test vault unlock, playback controls, and
  settings.

On Windows, use PowerShell to check script syntax and build the development ZIP.

```powershell
foreach ($file in 'scripts/package.ps1', 'tests/smoke.ps1', 'Install-Music.ps1', 'mods/herdr-music/vendor/herdr-vault/vault-kdf.ps1', 'vendor/herdr-avlye-layout/Install-Avlye.ps1') {
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        (Resolve-Path $file).Path, [ref]$null, [ref]$parseErrors
    )
    if ($parseErrors) { throw ($parseErrors | Out-String) }
}
./scripts/package.ps1 -Development
```

The ZIP includes the mod, both shared dependencies, their license notices and
the offline installer. Packaging downloads the pinned GitHub releases,
verifies their SHA-256 checksums, and produces a checksum for the output ZIP.
Set `HERDR_DEPENDENCY_ARCHIVES` to a directory with the pinned ZIPs to build
without a network connection.

[Installation](docs/install.md) · [Architecture](docs/architecture.md) · [Capabilities](docs/capabilities.md) · [Security](docs/security.md)
