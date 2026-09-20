[CmdletBinding()]
param(
  [string]$Source,
  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Source)) {
  $Source = Join-Path (Split-Path -Parent $PSCommandPath) "..\fixtures\novel-projects\fate-control-cycle-sample"
}
$sourcePath = [System.IO.Path]::GetFullPath($Source)
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw "Source Novel Project does not exist: $sourcePath" }
if (-not (Test-Path -LiteralPath (Join-Path $sourcePath ".novel\project.json") -PathType Leaf)) { throw "Source is not a Novel Project: $sourcePath" }
if ([string]::Equals($sourcePath, $destinationPath, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Destination must differ from Source." }
if (Test-Path -LiteralPath $destinationPath) {
  if ((Get-ChildItem -LiteralPath $destinationPath -Force).Count -gt 0) { throw "Destination must not exist or must be empty: $destinationPath" }
} else {
  New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
}
Get-ChildItem -LiteralPath $sourcePath -Force | Copy-Item -Destination $destinationPath -Recurse -Force
$verifierSource = Join-Path $PSScriptRoot "verify-novel-chapter.ts"
$verifierDirectory = Join-Path $destinationPath ".novel\tools"
if (-not (Test-Path -LiteralPath $verifierSource -PathType Leaf)) { throw "Verifier source does not exist: $verifierSource" }
New-Item -ItemType Directory -Path $verifierDirectory -Force | Out-Null
Copy-Item -LiteralPath $verifierSource -Destination (Join-Path $verifierDirectory "verify-novel-chapter.ts") -Force
$baselinePath = Join-Path $destinationPath ".novel\agent-test-baseline.json"
$files = Get-ChildItem -LiteralPath $destinationPath -File -Recurse -Force | Where-Object { $_.FullName -ne $baselinePath } | Sort-Object FullName | ForEach-Object {
  $relativePath = $_.FullName.Substring($destinationPath.Length).TrimStart('\', '/') -replace '\\', '/'
  [PSCustomObject]@{ path = $relativePath; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = $_.Length }
}
[PSCustomObject]@{ version = 1; createdAt = [DateTime]::UtcNow.ToString("o"); source = $sourcePath; files = @($files) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $baselinePath -Encoding utf8
Write-Host "Created isolated Novel Agent test copy: $destinationPath"
Write-Host "Baseline: $baselinePath ($($files.Count) files)"
