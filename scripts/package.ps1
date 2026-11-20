param([switch]$Development)
$ErrorActionPreference = 'Stop'
Push-Location "$PSScriptRoot/.."
try {
    $name = if ($Development) { 'herdr-music-windows-dev.zip' } else { 'herdr-music-windows.zip' }
    $stage = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
    $archive = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '.zip')
    $mod = New-Item (Join-Path $stage 'mods/herdr-music') -ItemType Directory -Force
    try {
        Copy-Item Install-Music.ps1,README.md,shared-dependencies.json $stage
        Copy-Item -LiteralPath docs -Destination $stage -Recurse
        Copy-Item mods/herdr-music/main.js,mods/herdr-music/spotify.js,mods/herdr-music/mod.json $mod
        Copy-Item mods/herdr-music/icons $mod -Recurse
        & (Join-Path $PSScriptRoot 'fetch-dependencies.ps1') -Destination $stage
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::CreateFromDirectory($stage, $archive)
        Move-Item -LiteralPath $archive -Destination $name -Force
        $checksum = Get-FileHash $name
        [IO.File]::WriteAllText((Join-Path (Get-Location) "$name.sha256"), "$($checksum.Hash.ToLowerInvariant())  $name`n")
        $checksum
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    }
} finally { Pop-Location }
