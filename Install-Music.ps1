$ErrorActionPreference = 'Stop'
$herdrHome = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME }
    elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'herdr-app' }
    else { Join-Path $HOME '.config/herdr-app' }
$source = Join-Path $PSScriptRoot 'mods/herdr-music'
$target = Join-Path $herdrHome 'mods/herdr-music'
$vault = Join-Path $target 'vendor/herdr-vault'
New-Item -Path $vault -ItemType Directory -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $source 'vendor/herdr-vault') -File | Copy-Item -Destination $vault -Force
Copy-Item -LiteralPath (Join-Path $source 'icons') -Destination $target -Recurse -Force
foreach ($file in @('spotify.js', 'main.js', 'mod.json')) {
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination $target -Force
}
& (Join-Path $PSScriptRoot 'vendor/herdr-avlye-layout/Install-Avlye.ps1')
