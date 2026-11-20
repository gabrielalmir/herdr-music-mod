# Herdr Music

A Spotify Connect mini-player for Herdr on Windows.

## Development

Use npm with Node.js 20.19+, 22.13+, or 24 and newer. In a fresh checkout, run
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
foreach ($file in 'scripts/package.ps1', 'tests/smoke.ps1', 'mods/herdr-music/vault-kdf.ps1') {
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        (Resolve-Path $file).Path, [ref]$null, [ref]$parseErrors
    )
    if ($parseErrors) { throw ($parseErrors | Out-String) }
}
./scripts/package.ps1 -Development
```

The ZIP contains the runtime files, icons, and Windows key derivation script.
The packaging script copies these files explicitly and keeps development
dependencies in the working copy.

[Installation](docs/install.md) · [Architecture](docs/architecture.md) · [Capabilities](docs/capabilities.md) · [Security](docs/security.md)
