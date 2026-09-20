[CmdletBinding()]
param(
    [string]$SourceRoot = "D:\PycharmProjects\novel_test\fate-control-cycle",
    [string]$DestinationRoot = "D:\PycharmProjects\pi-desktop\fixtures\novel-projects\fate-control-cycle-sample"
)

$ErrorActionPreference = "Stop"

function Get-TargetPath {
    param([string]$SourceRelativePath)

    $path = $SourceRelativePath.Replace("\", "/")
    $rootTargets = @{
        "01-cosmos-and-rules.md" = "canon/world/01-cosmos-and-rules.md"
        "02-cultivation-and-combat.md" = "canon/world/02-cultivation-and-combat.md"
        "03-interfaces-order-and-relics.md" = "canon/world/03-interfaces-order-and-relics.md"
        "04-cycle-and-endgame.md" = "canon/world/04-cycle-and-endgame.md"
        "05-characters-and-story-structure.md" = "canon/characters/05-characters-and-story-structure.md"
        "06-earth-arc.md" = "canon/world/06-earth-arc.md"
        "07-youming-and-six-realms.md" = "canon/world/07-youming-and-six-realms.md"
        "08-insect-infiltration.md" = "canon/world/08-insect-infiltration.md"
        "09-earth-characters-and-events.md" = "canon/characters/09-earth-characters-and-events.md"
        "10-earth-arc-outline.md" = "planning/arc-outlines/10-earth-arc-outline.md"
        "11-current-story-state.md" = "canon/continuity/current-story-state.md"
        "12-earth-secular-order-and-xiayun.md" = "canon/world/12-earth-secular-order-and-xiayun.md"
        "13-earth-opening-ten-chapter-outline.md" = "archive/retired-planning/13-earth-opening-ten-chapter-outline.md"
        "14-draft-planning-lessons.md" = "craft/14-draft-planning-lessons.md"
        "15-beasts-equipment-and-formations.md" = "canon/world/15-beasts-equipment-and-formations.md"
        "16-earth-cities-and-factions.md" = "canon/world/16-earth-cities-and-factions.md"
        "agent-handoff.md" = "craft/agent-handoff.md"
        "chapter-brief-template.md" = "craft/templates/chapter-brief-template.md"
        "open-questions.md" = "notes/open-questions.md"
        "README.md" = "archive/legacy-layout/README.md"
        "style_guide.md" = "craft/style_guide.md"
        "writing-guide.md" = "craft/writing-guide.md"
        "writing-style-guide.md" = "craft/writing-style-guide.md"
        "plan/canon-text-index.md" = "canon/indexes/canonical-text-index.md"
        "plan/continuity-ledger.md" = "canon/continuity/continuity-ledger.md"
        "plan/story-bible-index.md" = "planning/story-bible-index.md"
    }

    if ($rootTargets.ContainsKey($path)) {
        return $rootTargets[$path]
    }

    if ($path -match "^drafts/earth-volume-1/chapters/(00[1-9]|01[0-6])\.md$") {
        return "manuscript/volumes/earth-volume-1/chapters/$($path.Split('/')[-1])"
    }

    if ($path -eq "drafts/earth-volume-1/chapters/017.md") {
        return "drafts/candidates/earth-volume-1/chapters/017.md"
    }

    if ($path -match "^drafts/") {
        return "drafts/history/$($path.Substring('drafts/'.Length))"
    }

    if ($path -eq "plan/event-outlines/004-005-first-threshold.md" -or
        $path -eq "plan/event-outlines/004-006-entry-screening.md") {
        return "archive/superseded-planning/$($path.Split('/')[-1])"
    }

    if ($path -match "^plan/") {
        return "planning/$($path.Substring('plan/'.Length))"
    }

    throw "No migration mapping exists for '$SourceRelativePath'."
}

function Get-DocumentClassification {
    param([string]$TargetPath)

    if ($TargetPath -match "^manuscript/") {
        return @{ ContentType = "manuscript"; Authority = "canonical"; Reason = "Listed as canonical prose by the canonical text index." }
    }

    if ($TargetPath -match "^canon/") {
        return @{ ContentType = "canon"; Authority = "canonical"; Reason = "Imported from a current canon source or canon index." }
    }

    if ($TargetPath -match "^drafts/candidates/") {
        return @{ ContentType = "draft"; Authority = "proposed"; Reason = "Chapter 017 is beyond CANONICAL_THROUGH_016 and awaits user acceptance." }
    }

    if ($TargetPath -match "^drafts/history/") {
        return @{ ContentType = "draft"; Authority = "historical"; Reason = "Historical trial, rewrite, or model-comparison source; excluded from current continuity." }
    }

    if ($TargetPath -match "^archive/") {
        return @{ ContentType = "archive"; Authority = "historical"; Reason = "Explicitly retired or superseded planning material." }
    }

    if ($TargetPath -match "^planning/continuity-proposals/017\.md$") {
        return @{ ContentType = "planning"; Authority = "proposed"; Reason = "Pending Chapter 017 continuity proposal." }
    }

    if ($TargetPath -match "^planning/") {
        return @{ ContentType = "planning"; Authority = "planning"; Reason = "Planning record; its own Markdown status remains authoritative." }
    }

    if ($TargetPath -match "^craft/") {
        return @{ ContentType = "craft"; Authority = "reference"; Reason = "Writing-process or style reference." }
    }

    if ($TargetPath -match "^notes/") {
        return @{ ContentType = "note"; Authority = "proposed"; Reason = "Open question or unconfirmed working note." }
    }

    throw "No classification exists for '$TargetPath'."
}

function Get-DeclaredStatus {
    param([string]$FilePath)

    $match = Select-String -LiteralPath $FilePath -Pattern "^status:\s*(.+)$" -CaseSensitive | Select-Object -First 1
    if ($null -eq $match) {
        return $null
    }

    return $match.Matches[0].Groups[1].Value.Trim()
}

$source = (Resolve-Path -LiteralPath $SourceRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $source "plan\canon-text-index.md"))) {
    throw "SourceRoot is not the expected fate-control-cycle project: '$source'."
}

$destinationParent = Split-Path -Parent $DestinationRoot
if (-not (Test-Path -LiteralPath $destinationParent)) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
}

if (Test-Path -LiteralPath $DestinationRoot) {
    $existingItems = Get-ChildItem -LiteralPath $DestinationRoot -Force
    if ($existingItems.Count -gt 0) {
        throw "DestinationRoot already contains files. Choose an empty destination: '$DestinationRoot'."
    }
}

New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null

$sourceFiles = Get-ChildItem -LiteralPath $source -File -Recurse -Filter "*.md" | Sort-Object FullName
$manifestFiles = [System.Collections.Generic.List[object]]::new()

foreach ($sourceFile in $sourceFiles) {
    $relative = $sourceFile.FullName.Substring($source.Length).TrimStart("\")
    $targetRelative = Get-TargetPath -SourceRelativePath $relative
    $targetFullPath = Join-Path $DestinationRoot $targetRelative
    $targetDirectory = Split-Path -Parent $targetFullPath

    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $targetFullPath

    $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $targetHash = (Get-FileHash -LiteralPath $targetFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceHash -ne $targetHash) {
        throw "Hash mismatch after copying '$relative'."
    }

    $classification = Get-DocumentClassification -TargetPath $targetRelative
    $manifestFiles.Add([ordered]@{
        sourceRelativePath = $relative.Replace("\", "/")
        targetPath = $targetRelative
        sha256 = $sourceHash
        bytes = $sourceFile.Length
        contentType = $classification.ContentType
        authority = $classification.Authority
        reason = $classification.Reason
        sourceDeclaredStatus = Get-DeclaredStatus -FilePath $sourceFile.FullName
    })
}

$novelDirectory = Join-Path $DestinationRoot ".novel"
New-Item -ItemType Directory -Path $novelDirectory -Force | Out-Null

$project = [ordered]@{
    formatVersion = 1
    name = "Fate Control Cycle Sample"
    localFirst = $true
    layout = [ordered]@{
        manuscript = @("manuscript")
        canon = @("canon")
        planning = @("planning")
        drafts = @("drafts")
        craft = @("craft")
        notes = @("notes")
        memory = @("memory")
        archive = @("archive")
        research = @("research")
        assets = @("assets")
        exports = @("exports")
    }
    authority = [ordered]@{
        canonicalTextIndex = "canon/indexes/canonical-text-index.md"
        currentState = "canon/continuity/current-story-state.md"
        continuityLedger = "canon/continuity/continuity-ledger.md"
        canonicalPaths = @("manuscript/volumes/earth-volume-1/chapters")
        proposedPaths = @("drafts/candidates/earth-volume-1/chapters")
    }
    import = [ordered]@{
        mode = "non-destructive-copy"
        manifest = ".novel/import-manifest.json"
        sourceProject = "fate-control-cycle"
    }
}

$manifest = [ordered]@{
    formatVersion = 1
    importedAtUtc = [DateTime]::UtcNow.ToString("o")
    sourceRoot = $source
    destinationRoot = $DestinationRoot
    sourceFileCount = $sourceFiles.Count
    copiedFileCount = $manifestFiles.Count
    files = $manifestFiles
}

$project | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $novelDirectory "project.json") -Encoding utf8
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $novelDirectory "import-manifest.json") -Encoding utf8

$report = @"
# Fate Control Cycle Import Report

- Source: $source
- Imported Markdown files: $($manifestFiles.Count)
- Copy mode: non-destructive; every copied file was SHA-256 verified.
- Canonical manuscript: Chapters 001-016 only, as declared by canon/indexes/canonical-text-index.md.
- Pending manuscript: Chapter 017 remains under drafts/candidates/.
- Retired and superseded plans remain under archive/.
- memory/, research/, assets/, and exports/ are intentionally empty reserved directories.

The imported Markdown is byte-identical to its source. Legacy links inside those files are preserved; .novel/import-manifest.json provides the original-to-new path mapping for the application.
"@

$report | Set-Content -LiteralPath (Join-Path $novelDirectory "import-report.md") -Encoding utf8
foreach ($reservedDirectory in @("memory", "research", "assets", "exports")) {
    New-Item -ItemType Directory -Path (Join-Path $DestinationRoot $reservedDirectory) -Force | Out-Null
}

Write-Host "Imported $($manifestFiles.Count) Markdown files into '$DestinationRoot'."
