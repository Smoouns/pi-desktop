import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { recover } from "./journal.js";

// No SDK, project reopening, session mutation, credential resolution or retry.
await import(pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href);
const file = realpathSync(process.argv[2]);
const root = realpathSync(path.resolve("artifacts/harness/review-e8"));
const relative = path.relative(root, file);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "E8_RECOVERY_OUTSIDE_ARTIFACTS");
const value = recover(file);
assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")].attempts, 0);
console.log(JSON.stringify({ ...value, rows: undefined, mode: "cold-read-only", networkAttempts: 0, realModelCalls: 0 }));
