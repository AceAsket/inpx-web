param([Parameter(Mandatory=$true)][string] $Installer)

$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{6C431F21-C954-4300-A296-3374C1C21A86}_is1'
if (Test-Path -LiteralPath $key) { throw 'Run the clean install check in a profile without a registered inpx-web installation' }
$dir = Join-Path ([IO.Path]::GetTempPath()) ('inpx setup ' + [guid]::NewGuid())
$setup = (Resolve-Path -LiteralPath $Installer).Path
$app = Join-Path $dir 'inpx-web.exe'
try {
    $process = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',
        '/NOCLOSEAPPLICATIONS','/NORESTARTAPPLICATIONS','/NOICONS','/TASKS=!desktopicon',"/DIR=`"$dir`"") -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode) { throw "Installer exited with $($process.ExitCode)" }
    if (-not (Test-Path -LiteralPath $app)) { throw "Missing installed application in $dir" }
    foreach ($file in 'vcruntime140.dll','bin/vcruntime140.dll','bin/djxl.exe','bin/dwebp.exe','bin/7za.exe','bin/LICENSE.quickjs') {
        if (-not (Test-Path -LiteralPath (Join-Path $dir $file))) { throw "Missing installed file $file" }
    }
    & node (Join-Path $PSScriptRoot 'binary-smoke-test.js') $app --rust --require-converters
    if ($LASTEXITCODE) { throw "Installed application test exited with $LASTEXITCODE" }
} finally {
    $uninstall = Join-Path $dir 'unins000.exe'
    if (Test-Path -LiteralPath $uninstall) {
        $process = Start-Process -FilePath $uninstall -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -or (Test-Path -LiteralPath $app) -or (Test-Path -LiteralPath $key)) {
            throw 'The test installation was not successfully uninstalled'
        }
    }
}
Write-Output 'Clean Windows installation, HTTP conversion and uninstall passed'
