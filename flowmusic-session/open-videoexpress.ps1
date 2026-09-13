$ErrorActionPreference = 'Stop'
$ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$ProfileDir = Join-Path $PSScriptRoot 'chrome-profile'
Start-Process -FilePath $ChromePath -ArgumentList @(
  "--user-data-dir=$ProfileDir",
  '--remote-debugging-port=9222',
  '--no-first-run',
  '--no-default-browser-check',
  'https://app.videoexpress.ai/'
)
Write-Output "Opened Video Express with project-local profile: $ProfileDir"
