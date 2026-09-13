$ErrorActionPreference = 'Stop'

$ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$ProfileDir = Join-Path $PSScriptRoot 'chrome-profile'
$CdpPort = 9222

if (-not (Test-Path -LiteralPath $ChromePath)) {
  throw "Chrome not found at $ChromePath"
}
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$already = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like "*$ProfileDir*" } |
  Select-Object -First 1

if (-not $already) {
  Start-Process -FilePath $ChromePath -ArgumentList @(
    "--remote-debugging-port=$CdpPort",
    "--user-data-dir=$ProfileDir",
    '--no-first-run',
    '--no-default-browser-check',
    'https://www.flowmusic.app/'
  )
}

for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  try {
    $v = curl.exe -s "http://127.0.0.1:$CdpPort/json/version" | ConvertFrom-Json
    if ($v.Browser) {
      Write-Output "Flow Music Chrome is ready with project-local profile: $ProfileDir"
      Write-Output "CDP: http://127.0.0.1:$CdpPort"
      exit 0
    }
  } catch { }
}

throw "CDP endpoint did not respond."
