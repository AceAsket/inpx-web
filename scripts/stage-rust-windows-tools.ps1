param(
    [Parameter(Mandatory=$true)][string] $ApplicationDir,
    [Parameter(Mandatory=$true)][string] $ToolsDir
)

$ErrorActionPreference = 'Stop'
$app = (Resolve-Path -LiteralPath $ApplicationDir).Path
$bin = Join-Path $app 'bin'
$tools = (Resolve-Path -LiteralPath $ToolsDir).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio x64 C++ redistributable files are required' }
$redist = Join-Path $visualStudio 'VC/Redist/MSVC'
$crt = Get-ChildItem -LiteralPath $redist -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Get-Item -Path (Join-Path $_.FullName 'x64/Microsoft.VC*.CRT/vcruntime140.dll') -ErrorAction SilentlyContinue } |
    Select-Object -First 1
if (-not $crt) { throw "Missing x64 vcruntime140.dll under $redist" }

# Resolve tools beside the executable even when no converters or VC runtime are installed globally.
foreach ($name in 'fbc.exe','kindling.exe','LICENSE.kindling','7za.exe','djxl.exe','dwebp.exe') {
    Copy-Item -LiteralPath (Join-Path $tools $name) -Destination $bin -Force
}
foreach ($directory in $app,$bin) {
    Copy-Item -LiteralPath $crt.FullName -Destination $directory -Force
}
