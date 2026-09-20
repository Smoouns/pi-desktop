$ErrorActionPreference = "Stop"
node --experimental-strip-types scripts/novel-verifier-smoke.ts
if ($LASTEXITCODE -ne 0) { throw "Novel verifier smoke failed" }
