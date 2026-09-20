$ErrorActionPreference = "Stop"
$worldTestOutput = Join-Path $env:TEMP ("pi-world-change-" + [Guid]::NewGuid().ToString('N') + ".mjs")
try {
  & .\node_modules\.bin\esbuild.cmd scripts/world-change-smoke.ts --bundle --platform=node --format=esm --alias:@tauri-apps/plugin-fs=./scripts/world-change-test-fs.ts --outfile=$worldTestOutput
  if ($LASTEXITCODE -ne 0) { throw "World change test bundle failed" }
  node $worldTestOutput
  if ($LASTEXITCODE -ne 0) { throw "World change smoke failed" }
} finally {
  if (Test-Path -LiteralPath $worldTestOutput) { Remove-Item -LiteralPath $worldTestOutput -Force }
}
