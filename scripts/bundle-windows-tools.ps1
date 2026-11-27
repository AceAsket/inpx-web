param(
  [string] $TargetDir = ""
)

$ErrorActionPreference = 'Stop'

function Get-EnvOrDefault {
  param(
    [string] $Name,
    [string] $Default
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }

  return $value
}

function Reset-Directory {
  param([string] $Path)

  if (Test-Path $Path) {
    Remove-Item $Path -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Download-VerifiedFile {
  param(
    [string] $Uri,
    [string] $OutFile,
    [string] $ExpectedSha256
  )

  Invoke-WebRequest -Uri $Uri -OutFile $OutFile
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
    $stream = [System.IO.File]::OpenRead($OutFile)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $actual = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha256.Dispose()
      $stream.Dispose()
    }
    $expected = $ExpectedSha256.Trim().ToLowerInvariant()
    if ($actual -ne $expected) {
      Remove-Item -Path $OutFile -Force -ErrorAction SilentlyContinue
      throw "SHA-256 mismatch for $Uri : expected $expected, got $actual"
    }
  }
}

function Invoke-SevenZipExtract {
  param(
    [string] $Executable,
    [string] $Archive,
    [string] $Destination
  )

  & $Executable x $Archive "-o$Destination" -y
  if ($LASTEXITCODE -ne 0) {
    throw "7-Zip extraction failed for $Archive (exit code $LASTEXITCODE)"
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($TargetDir)) {
  $TargetDir = Join-Path $repoRoot 'dist/win'
}

$targetDir = (Resolve-Path $TargetDir).Path
$binDir = Join-Path $targetDir 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$sevenZipExtraUrl = Get-EnvOrDefault 'WINDOWS_7ZIP_EXTRA_URL' 'https://github.com/ip7z/7zip/releases/download/26.06/7z2606-extra.7z'
$sevenZipExtraSha256 = Get-EnvOrDefault 'WINDOWS_7ZIP_EXTRA_SHA256' '396c180f12d2247c24b0b1fcd482c6fc2a2700f61211ffede1061dd971f5e104'
$sevenZipBootstrapUrl = Get-EnvOrDefault 'WINDOWS_7ZIP_BOOTSTRAP_URL' 'https://github.com/ip7z/7zip/releases/download/26.06/7zr.exe'
$sevenZipBootstrapSha256 = Get-EnvOrDefault 'WINDOWS_7ZIP_BOOTSTRAP_SHA256' 'e80db2dad715a6c5adabe292d31ed54e11f4e9b99ca349827b50573b175891bc'

$windowsJxlUrl = Get-EnvOrDefault 'WINDOWS_JXL_URL' 'https://github.com/libjxl/libjxl/releases/download/v0.13.0/jxl-x64-windows-static.zip'
$windowsJxlSha256 = Get-EnvOrDefault 'WINDOWS_JXL_SHA256' 'e394519c05ea9e5b83947f89b40afbf1ea7c631a608406c5de945a4c5bdcdcb7'

$windowsWebpUrl = Get-EnvOrDefault 'WINDOWS_WEBP_URL' 'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-windows-x64.zip'
$windowsWebpSha256 = Get-EnvOrDefault 'WINDOWS_WEBP_SHA256' '48886f506b21f62e4661f0f4cbfca19800897c385128e8902542d29a950c93f1'

$fb2cngUrl = Get-EnvOrDefault 'FB2CNG_WINDOWS_URL' 'https://github.com/rupor-github/fb2cng/releases/download/v2.1.1/fbc-windows-amd64.zip'
$fb2cngSha256 = Get-EnvOrDefault 'FB2CNG_WINDOWS_SHA256' 'c5ce359dfa1765439eb8b438fe1927390ebef8780012ce1976e618df5322eb1b'

Write-Host "Bundling verified Windows tools into $binDir"

$sevenZipArchive = Join-Path $env:TEMP '7z2606-extra.7z'
$sevenZipBootstrap = Join-Path $env:TEMP '7zr-bootstrap.exe'
$sevenZipExtract = Join-Path $env:TEMP 'inpx-web-7zip-extra'
Reset-Directory $sevenZipExtract

Download-VerifiedFile $sevenZipExtraUrl $sevenZipArchive $sevenZipExtraSha256
Download-VerifiedFile $sevenZipBootstrapUrl $sevenZipBootstrap $sevenZipBootstrapSha256
Invoke-SevenZipExtract $sevenZipBootstrap $sevenZipArchive $sevenZipExtract
$sevenZipSource = Get-ChildItem -Path $sevenZipExtract -Recurse -File -Filter '7za.exe' | Select-Object -First 1
if (-not $sevenZipSource) {
  throw 'Unable to find 7za.exe in the 7-Zip extra package'
}
$sevenZipTool = Join-Path $binDir '7za.exe'
Copy-Item $sevenZipSource.FullName -Destination $sevenZipTool -Force

$jxlArchive = Join-Path $env:TEMP 'jxl-x64-windows-static.zip'
$jxlExtract = Join-Path $env:TEMP 'inpx-web-jxl-x64-windows-static'
Reset-Directory $jxlExtract
Download-VerifiedFile $windowsJxlUrl $jxlArchive $windowsJxlSha256
Invoke-SevenZipExtract $sevenZipTool $jxlArchive $jxlExtract
Get-ChildItem -Path $jxlExtract -Recurse -File |
  Where-Object { $_.Extension -in @('.exe', '.dll') } |
  ForEach-Object {
    Copy-Item $_.FullName -Destination (Join-Path $binDir $_.Name) -Force
  }

$webpArchive = Join-Path $env:TEMP 'libwebp-windows-x64.zip'
$webpExtract = Join-Path $env:TEMP 'inpx-web-libwebp-windows-x64'
Reset-Directory $webpExtract
Download-VerifiedFile $windowsWebpUrl $webpArchive $windowsWebpSha256
Invoke-SevenZipExtract $sevenZipTool $webpArchive $webpExtract
Get-ChildItem -Path $webpExtract -Recurse -File |
  Where-Object { $_.Extension -in @('.exe', '.dll') } |
  ForEach-Object {
    Copy-Item $_.FullName -Destination (Join-Path $binDir $_.Name) -Force
  }

$fbcArchive = Join-Path $env:TEMP 'fbc-windows-amd64.zip'
$fbcExtract = Join-Path $env:TEMP 'inpx-web-fb2cng-win'
Reset-Directory $fbcExtract
Download-VerifiedFile $fb2cngUrl $fbcArchive $fb2cngSha256
Invoke-SevenZipExtract $sevenZipTool $fbcArchive $fbcExtract
$fbcSource = Get-ChildItem -Path $fbcExtract -Recurse -File |
  Where-Object { $_.Name -eq 'fbc.exe' } |
  Select-Object -First 1
if (-not $fbcSource) {
  throw 'Unable to find fbc.exe in fbc-windows-amd64.zip'
}
Copy-Item $fbcSource.FullName -Destination (Join-Path $binDir 'fbc.exe') -Force

Write-Host 'Windows tool bundle complete.'
