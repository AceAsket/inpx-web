param([string]$Directory='dist/android/layout-checks')
$ErrorActionPreference='Stop'
$taskOriginal=(adb shell settings get system font_scale).Trim()
New-Item -ItemType Directory -Path $Directory -Force | Out-Null
try {
    foreach($taskScale in @('1.0','1.4')) {
        adb shell settings put system font_scale $taskScale | Out-Null
        Start-Sleep -Seconds 1
        $taskResult=adb shell am instrument -w ru.inpx.server.test/ru.inpx.server.UiSmokeInstrumentation
        $taskResult | Set-Content -LiteralPath (Join-Path $Directory "font-$taskScale.txt") -Encoding utf8
        if(($taskResult -join "`n") -notmatch '"passed": true' -or ($taskResult -join "`n") -match 'UI CHECK FAILED|Process crashed') { throw "Layout check failed at font scale $taskScale" }
        $taskOutput=Join-Path $Directory "font-$taskScale"
        New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
        foreach($taskFile in @('report.json','tv.png','touch.png','diagnostics.png','power.png','power-open.png','community.png')) {
            adb pull "/sdcard/Android/data/ru.inpx.server/files/ui-checks/$taskFile" (Join-Path $taskOutput $taskFile) | Out-Null
        }
        Write-Output "PASS: touch and TV layouts, font scale $taskScale"
    }
} finally {
    if($taskOriginal -eq 'null'){adb shell settings delete system font_scale | Out-Null}
    else{adb shell settings put system font_scale $taskOriginal | Out-Null}
    Write-Output "Restored font scale: $taskOriginal"
}
