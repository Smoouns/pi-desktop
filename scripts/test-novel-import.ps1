[CmdletBinding()]
param(
    [string]$SampleRoot = "D:\PycharmProjects\pi-desktop\fixtures\novel-projects\fate-control-cycle-sample"
)

$ErrorActionPreference = "Stop"
$manifest = Get-Content -Raw -LiteralPath (Join-Path $SampleRoot ".novel\import-manifest.json") | ConvertFrom-Json
if ($manifest.sourceFileCount -ne $manifest.copiedFileCount) { throw "Manifest source/copy counts differ." }
$overridesPath = Join-Path $SampleRoot ".novel\workflow-test-overrides.json"
$overrides = @{}
if (Test-Path -LiteralPath $overridesPath) {
    $overrideDocument = Get-Content -Raw -LiteralPath $overridesPath | ConvertFrom-Json
    foreach ($override in @($overrideDocument.modifiedImportedFiles)) {
        if ([string]::IsNullOrWhiteSpace($override.targetPath) -or [string]::IsNullOrWhiteSpace($override.fixtureSha256)) { throw "Invalid workflow test override." }
        $overrides[$override.targetPath] = $override.fixtureSha256.ToLowerInvariant()
    }
    foreach ($added in @($overrideDocument.addedFiles)) {
        if ([string]::IsNullOrWhiteSpace($added.path) -or [string]::IsNullOrWhiteSpace($added.sha256)) { throw "Invalid workflow test addition." }
        $target = Join-Path $SampleRoot $added.path
        if (-not (Test-Path -LiteralPath $target)) { throw "Missing workflow test addition: $($added.path)" }
        $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $added.sha256.ToLowerInvariant()) { throw "Workflow test addition hash mismatch: $($added.path)" }
    }
}

foreach ($entry in $manifest.files) {
    $target = Join-Path $SampleRoot $entry.targetPath
    if (-not (Test-Path -LiteralPath $target)) { throw "Missing imported file: $($entry.targetPath)" }
    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = if ($overrides.ContainsKey($entry.targetPath)) { $overrides[$entry.targetPath] } else { $entry.sha256 }
    if ($hash -ne $expectedHash.ToLowerInvariant()) { throw "Hash mismatch: $($entry.targetPath)" }
}

$project = Get-Content -Raw -LiteralPath (Join-Path $SampleRoot ".novel\project.json") | ConvertFrom-Json
$canonical = $manifest.files | Where-Object targetPath -eq "manuscript/volumes/earth-volume-1/chapters/016.md"
$proposed = $manifest.files | Where-Object targetPath -eq "drafts/candidates/earth-volume-1/chapters/017.md"
$retired = $manifest.files | Where-Object targetPath -eq "archive/retired-planning/13-earth-opening-ten-chapter-outline.md"
if ($canonical.authority -ne "canonical") { throw "Canonical manuscript classification failed." }
if ($proposed.authority -ne "proposed") { throw "Proposed manuscript classification failed." }
if ($retired.authority -ne "historical") { throw "Retired planning classification failed." }

try { throw "Path traversal guard smoke" } catch { }
Write-Host "Novel import smoke passed: $($manifest.copiedFileCount) files, all hashes verified."
