import type { RunScope } from "../../../src/harness/types.js";
import type { ToolErrorKind } from "../../../src/harness/tool-policy.js";
import type { RunSupervisor, RunSupervisorSnapshot, RunSupervisorState } from "./run-supervisor.js";

export const RUN_STATUS_ENTRY = "pi-desktop-run-status/v1";

export interface SupervisorRuntime {
	disable(): void;
	markExplicitInput(source: string): void;
	restore(branch: unknown[], scope: Omit<RunScope, "runId" | "generation">, generation: number): RunSupervisorSnapshot | null;
	start(scope: RunScope): RunSupervisorSnapshot | null;
	snapshot(): RunSupervisorSnapshot | null;
	tool(callId: string, name: string): { allowed: boolean; snapshot: RunSupervisorSnapshot | null };
	turn(): RunSupervisorSnapshot | null;
	evidence(identity: string): RunSupervisorSnapshot | null;
	artifact(path: string, sha256: string): RunSupervisorSnapshot | null;
	verification(value: { callId: string; subject: string; artifactSha256: string | null; errorDigest: string | null; passed: boolean; full: boolean }): RunSupervisorSnapshot | null;
	failure(value: { kind: ToolErrorKind; code: string; signature?: string }): RunSupervisorSnapshot | null;
	stop(state: Exclude<RunSupervisorState, "RUNNING">, reasonCode: string): RunSupervisorSnapshot | null;
	finish(value: { stopReason: string; hasText: boolean; checkpointReady: boolean; pendingOperations: boolean; completionVerified: boolean }): RunSupervisorSnapshot | null;
}

/** Small Pi lifecycle adapter; dependency-free so it can be embedded in the managed extension. */
export function createSupervisorRuntime(options: {
	createSupervisor: () => RunSupervisor;
	append: (snapshot: RunSupervisorSnapshot) => void;
}): SupervisorRuntime {
	if (!options || typeof options.createSupervisor !== "function" || typeof options.append !== "function") throw new TypeError("supervisor runtime dependencies are required");
	let supervisor = options.createSupervisor();
	let scope: RunScope | null = null;
	let explicitInput = false;
	let lastPersisted = "";
	let poisoned = false;
	const sameBase = (left: any, right: any): boolean => !!left && !!right && left.projectId === right.projectId && left.sessionId === right.sessionId && left.role === right.role;
	const persist = (snapshot: RunSupervisorSnapshot | null): RunSupervisorSnapshot | null => {
		if (!snapshot) return null;
		const serialized = JSON.stringify(snapshot);
		if (serialized !== lastPersisted) {
			try { options.append(snapshot); lastPersisted = serialized; }
			catch {
				poisoned = true;
				if (scope) supervisor.stop(scope, "FAILED", "SUPERVISOR_PERSISTENCE");
				throw new Error("Run status persistence failed; further supervised tools are blocked");
			}
		}
		return snapshot;
	};
	const active = (): RunSupervisorSnapshot | null => scope ? supervisor.snapshot(scope) : null;
	const apply = (operation: (value: RunScope) => RunSupervisorSnapshot | null): RunSupervisorSnapshot | null => scope ? persist(operation(scope)) : null;
	return {
		disable() { supervisor = options.createSupervisor(); scope = null; explicitInput = false; lastPersisted = ""; poisoned = false; },
		markExplicitInput(source) { if (source === "interactive" || source === "rpc") explicitInput = true; },
		restore(branch, expected, generation) {
			supervisor = options.createSupervisor(); scope = null; explicitInput = false; lastPersisted = ""; poisoned = false;
			if (!Array.isArray(branch)) return null;
			let candidate: unknown = null; let corrupt = false;
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry: any = branch[index];
				if (entry?.type !== "custom" || entry.customType !== "pi-desktop-run-status/v1") continue;
				const rawScope = entry.data?.scope;
				if (rawScope && rawScope.projectId === expected.projectId && rawScope.sessionId === expected.sessionId && rawScope.role !== expected.role) continue;
				if (rawScope && sameBase(rawScope, expected)) { candidate = entry.data; break; }
				if (!rawScope || (rawScope.projectId === expected.projectId && rawScope.sessionId === expected.sessionId)) { corrupt = true; break; }
			}
			if (candidate) {
				let parsed: RunSupervisorSnapshot | null = null;
				try {
					parsed = supervisor.restore(candidate);
					if (!sameBase(parsed.scope, expected)) throw new Error("run status scope mismatch");
				} catch { corrupt = true; }
				if (parsed && !corrupt) {
					scope = parsed.scope; lastPersisted = JSON.stringify(parsed);
					// Persistence is deliberately outside the parse/replay catch. If appending
					// the interruption fence fails, persist() poisons this same scoped runtime
					// and the error must reach the caller rather than being reclassified.
					if (parsed.state === "RUNNING") return persist(supervisor.stop(scope, "BLOCKED_PREREQUISITE", "INTERRUPTED_RUN"));
					return parsed;
				}
			}
			if (corrupt) {
				scope = { ...expected, runId: "corrupt-" + String(generation), generation };
				supervisor.begin(scope);
				return persist(supervisor.stop(scope, "FAILED", "CORRUPT_RUN_STATUS"));
			}
			return null;
		},
		start(nextScope) {
			const existing = active();
			if (poisoned) return existing;
			if (existing && !explicitInput) return existing;
			explicitInput = false; supervisor = options.createSupervisor(); scope = nextScope; lastPersisted = "";
			return persist(supervisor.begin(nextScope));
		},
		snapshot: active,
		tool(callId, name) { if (!scope) return { allowed: true, snapshot: null }; if (poisoned) return { allowed: false, snapshot: supervisor.snapshot(scope) }; const result = supervisor.tool(scope, callId, name); persist(result.snapshot); return result; },
		turn() { return apply((value) => supervisor.turn(value)); },
		evidence(identity) { return apply((value) => supervisor.evidence(value, identity)); },
		artifact(path, sha256) { return apply((value) => supervisor.artifact(value, path, sha256)); },
		verification(value) { return apply((current) => supervisor.verification(current, value)); },
		failure(value) { return apply((current) => supervisor.failure(current, value)); },
		stop(state, reasonCode) { return apply((current) => supervisor.stop(current, state, reasonCode)); },
		finish(value) { return apply((current) => supervisor.finish(current, value)); },
	};
}
