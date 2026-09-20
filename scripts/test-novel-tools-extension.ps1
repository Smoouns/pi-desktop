$ErrorActionPreference = "Stop"
node --experimental-strip-types scripts/novel-tools-extension-smoke.ts
if ($LASTEXITCODE -ne 0) { throw "Novel Tools extension smoke failed" }
