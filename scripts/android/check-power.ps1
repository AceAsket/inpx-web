param([string]$Base = 'http://127.0.0.1:22380', [string]$Report = 'dist/android/device-power-checks.json', [int]$IdleSeconds = 45)
$ErrorActionPreference = 'Stop'
$taskPackage = 'ru.inpx.server'
$taskWhitelist = @(adb shell dumpsys deviceidle whitelist)
$taskExempt = [bool]($taskWhitelist | Where-Object { $_ -match '^user,ru\.inpx\.server,' })
$taskBattery = (adb shell dumpsys battery) -join "`n"
if ($taskBattery -match 'UPDATES STOPPED') { throw 'Battery simulation is already active; preserve the existing test state.' }
$taskPower = (adb shell dumpsys power) -join "`n"
$taskAwake = $taskPower -match 'mWakefulness=Awake'
$taskResult = [ordered]@{ url=$Base; originalExemption=$taskExempt; checks=@() }
function Read-Server([string]$Name) {
    $taskResponse = node (Join-Path $PSScriptRoot 'probe-health.js') $Base
    if ($LASTEXITCODE -ne 0 -or !$taskResponse) { throw 'Health probe did not run' }
    $taskState = ((adb shell dumpsys deviceidle) | Select-String 'mState=|mLightState=') -join '; '
    $taskResult.checks += [ordered]@{name=$Name; idle=$taskState.Trim(); response=($taskResponse | ConvertFrom-Json)}
}
try {
    Read-Server 'awake-on-power'
    adb shell input keyevent 223 | Out-Null
    Start-Sleep -Seconds 2
    Read-Server 'screen-off-on-power'
    adb shell dumpsys battery unplug | Out-Null
    $taskForce = (adb shell dumpsys deviceidle force-idle) -join ' '
    $taskResult.forcedIdle = $taskForce
    if ($taskForce -notmatch 'deep idle mode') { throw "Cannot enter forced Doze: $taskForce" }
    Start-Sleep -Seconds $IdleSeconds
    Read-Server 'forced-doze-original-settings'
    $taskDownloads = node (Join-Path $PSScriptRoot 'check-server.js') $Base
    if ($LASTEXITCODE -ne 0) { throw 'Book download check failed during forced Doze' }
    $taskResult.downloadsDuringDoze = ($taskDownloads -join "`n") | ConvertFrom-Json
    if (!$taskExempt) {
        adb shell dumpsys deviceidle whitelist "+$taskPackage" | Out-Null
        Start-Sleep -Seconds 2
        Read-Server 'forced-doze-temporary-exemption'
    }
} finally {
    adb shell dumpsys deviceidle unforce | Out-Null
    adb shell dumpsys battery reset | Out-Null
    if (!$taskExempt) { adb shell dumpsys deviceidle whitelist "-$taskPackage" | Out-Null }
    if ($taskAwake) { adb shell input keyevent 224 | Out-Null }
    Read-Server 'restored-power-settings'
    $taskResult | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Report -Encoding utf8
    $taskResult | ConvertTo-Json -Depth 12
}
