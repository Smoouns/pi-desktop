import "../../../scripts/eval-network-guard.mjs";
const original = globalThis[Symbol.for("pi.eval.networkGuard")];
globalThis[Symbol.for("pi.e8.networkGuard")] = { active: true, fetches: 0, get denied() { return original.attempts; } };
