# Exercise the real Pilot runner with a Windows 8.3 TEMP alias, when supported.
# The environment override is process-local and is restored in finally.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PilotJournalShortPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetShortPathName(string path, StringBuilder output, uint capacity);
}
'@

$journalTempParent = (& node --input-type=module -e "import {realpath} from 'node:fs/promises'; import os from 'node:os'; console.log(await realpath(os.tmpdir()));").Trim()
if ($LASTEXITCODE -ne 0) { throw 'JOURNAL_TEMP_ROOT_PROBE_FAILED' }
$journalTestDirectory = Join-Path $journalTempParent ('pi-journal-path-test-' + [Guid]::NewGuid().ToString('N'))
$journalOriginalTemp = $env:TEMP
$journalOriginalTmp = $env:TMP
$journalExitCode = 0
New-Item -ItemType Directory -Path $journalTestDirectory | Out-Null
try {
    $journalShortBuffer = New-Object System.Text.StringBuilder 32768
    $journalShortLength = [PilotJournalShortPath]::GetShortPathName($journalTestDirectory, $journalShortBuffer, $journalShortBuffer.Capacity)
    if ($journalShortLength -eq 0 -or $journalShortLength -ge $journalShortBuffer.Capacity) {
        throw 'JOURNAL_SHORT_PATH_PROBE_FAILED'
    }
    $journalShortPath = $journalShortBuffer.ToString()
    if ($journalShortPath -ceq $journalTestDirectory) {
        Write-Output 'UNSUPPORTED journal.windows-short-temp: filesystem does not provide an 8.3 alias; not counted as passed.'
    } else {
        $env:TEMP = $journalShortPath
        $env:TMP = $journalShortPath
        Write-Output 'Running Pilot tests with process-local Windows 8.3 TEMP alias (paths redacted).'
        & node scripts/run-pilot-evals.mjs test
        $journalExitCode = $LASTEXITCODE
        if ($journalExitCode -eq 0) { Write-Output 'PASS journal.windows-short-temp' }
    }
} finally {
    $env:TEMP = $journalOriginalTemp
    $env:TMP = $journalOriginalTmp
    $journalResolvedTarget = (& node --input-type=module -e "import {realpath} from 'node:fs/promises'; console.log(await realpath(process.argv[1]));" $journalTestDirectory).Trim()
    if ($LASTEXITCODE -ne 0 -or $journalResolvedTarget -cne $journalTestDirectory -or (Split-Path -Parent $journalResolvedTarget) -cne $journalTempParent -or (Split-Path -Leaf $journalResolvedTarget) -notmatch '^pi-journal-path-test-[a-f0-9]{32}$') {
        throw 'UNSAFE_JOURNAL_WINDOWS_TEST_CLEANUP'
    }
    Remove-Item -LiteralPath $journalResolvedTarget -Recurse -Force
}
exit $journalExitCode
