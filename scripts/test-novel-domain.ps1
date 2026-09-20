$ErrorActionPreference = "Stop"
$out = Join-Path $env:TEMP "pi-desktop-novel-domain-smoke.mjs"
try {
  npx --yes esbuild scripts/novel-domain-smoke.ts --bundle --platform=node --format=esm --outfile=$out | Out-Host
  node $out
  if ($LASTEXITCODE -ne 0) { throw "Novel domain smoke failed" }
} finally {
  Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
}
