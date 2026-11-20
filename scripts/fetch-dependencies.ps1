param([string]$Destination = (Split-Path $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$pins = Get-Content -Raw -LiteralPath (Join-Path $root 'shared-dependencies.json') | ConvertFrom-Json
$paths = @{
    'herdr-avlye-layout' = 'vendor/herdr-avlye-layout'
    'herdr-vault' = 'mods/herdr-music/vendor/herdr-vault'
}
$scratch = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    foreach ($name in $paths.Keys) {
        $pin = $pins.$name
        $asset = ($pin.archive -split '/')[-1]
        if ($env:HERDR_DEPENDENCY_ARCHIVES) {
            $zip = Join-Path $env:HERDR_DEPENDENCY_ARCHIVES $asset
        } else {
            $zip = Join-Path $scratch $asset
            Invoke-WebRequest -UseBasicParsing -Uri $pin.archive -OutFile $zip
        }
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $pin.sha256) {
            throw "SHA-256 mismatch for $name $($pin.version)"
        }
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $scratch)
        $versionFile = Join-Path $scratch "$name/VERSION"
        $version = (Get-Content -Raw -LiteralPath $versionFile).Trim()
        if ("v$version" -cne $pin.version) { throw "Unexpected version for $name ($version)" }
    }
    foreach ($name in $paths.Keys) {
        $target = Join-Path $Destination $paths[$name]
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Get-ChildItem -LiteralPath (Join-Path $scratch $name) |
            Copy-Item -Destination $target -Recurse -Force
    }
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
