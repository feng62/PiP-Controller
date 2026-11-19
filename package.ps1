# Build a Chrome Web Store-ready ZIP from extension/.
# Usage: .\package.ps1
# Output: pip-controller-v<version>.zip

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$ExtensionRoot = Join-Path $Root "extension"
$ManifestPath = Join-Path $ExtensionRoot "manifest.json"

if (-not (Test-Path $ManifestPath -PathType Leaf)) {
  throw "extension\manifest.json not found"
}

$manifest = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version

if ($version -notmatch '^\d+\.\d+$') {
  throw "manifest version must use two numeric parts, for example 1.3"
}

$requiredPaths = @(
  "background.js",
  "popup.html",
  "popup.js",
  "popup-i18n.js",
  "content\bridge.js",
  "content\pip-toggle.js",
  "icons\icon16.png",
  "icons\icon32.png",
  "icons\icon48.png",
  "icons\icon128.png",
  "_locales\en\messages.json",
  "_locales\zh_CN\messages.json",
  "_locales\ja\messages.json"
)

foreach ($relativePath in $requiredPaths) {
  $path = Join-Path $ExtensionRoot $relativePath
  if (-not (Test-Path $path -PathType Leaf)) {
    throw "Missing extension file: extension\$relativePath"
  }
}

$zipPath = Join-Path $Root "pip-controller-v$version.zip"
if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}

# Compress the contents, not the extension directory itself, so manifest.json
# is placed at the root of the ZIP as required by the Chrome Web Store.
Compress-Archive `
  -Path (Join-Path $ExtensionRoot "*") `
  -DestinationPath $zipPath `
  -CompressionLevel Optimal

$sizeKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "OK: $zipPath ($sizeKb KB)"
Write-Host "Upload this ZIP in Chrome Web Store Developer Dashboard."
