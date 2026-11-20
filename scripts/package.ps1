param([switch]$Development)
$ErrorActionPreference = 'Stop'
Push-Location "$PSScriptRoot/.."
try {
    $name = if ($Development) { 'herdr-music-windows-dev.zip' } else { 'herdr-music-windows.zip' }
    $stage = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
    $mod = New-Item (Join-Path $stage 'herdr-music') -ItemType Directory -Force
    try {
        Copy-Item mods/herdr-music/main.js,mods/herdr-music/spotify.js,mods/herdr-music/mod.json,mods/herdr-music/vault-crypto.js,mods/herdr-music/THIRD-PARTY.txt,mods/herdr-music/windows-kdf.js,mods/herdr-music/vault-kdf.ps1 $mod
        Copy-Item mods/herdr-music/icons $mod -Recurse
        Compress-Archive $mod.FullName $name -Force
        Get-FileHash $name
    } finally { Remove-Item $stage -Recurse -Force }
} finally { Pop-Location }
