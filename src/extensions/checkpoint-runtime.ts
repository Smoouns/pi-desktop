import type { CheckpointStore, TaskCheckpoint, PendingCheckpointOperation } from "../harness/checkpoint-store.js";
import type { SourceVersionRef, SourceVersioning, SourceVersionResolverResult } from "../harness/source-version.js";
import type { CheckpointInvalidation } from "../harness/invalidation.js";
import type { RunScope } from "../harness/types.js";

/** Injected host boundary: this factory is embedded in the managed Pi extension. */
export function createCheckpointRuntime(deps: {
	store: CheckpointStore; versions: SourceVersioning; invalidation: CheckpointInvalidation;
	append: (checkpoint: TaskCheckpoint) => void;
	resolve: (ref: SourceVersionRef, ctx: any, run: any, cache: Map<string, any>) => Promise<SourceVersionResolverResult>;
	assertRun: (run: any) => void; budget: (scope: RunScope) => { readUsed: number; outputUsed: number };
}) {
	type Receipt = { ref: SourceVersionRef; sequence: number };
	type State = { owner: string; checkpoint: TaskCheckpoint | null; error: string | null; sequence: number; receipts: Map<string, Receipt>; observationIds: Set<string>; artifacts: Map<string, SourceVersionRef>; operations: Map<string, PendingCheckpointOperation>; stale: Set<string> };
	let state: State | null = null;
	const owner = (scope: RunScope) => JSON.stringify([scope.projectId, scope.sessionId, scope.role]);
	const sourceKey = (ref: SourceVersionRef) => JSON.stringify([ref.path, ref.startLine ?? null, ref.endLine ?? null, ref.authority ?? null, ref.temporal ?? null, Boolean(ref.memoryId)]);
	const text = (message: any): string => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
	const cloneOperation = (operation: PendingCheckpointOperation): PendingCheckpointOperation => ({ operationId: operation.operationId, toolName: operation.toolName, target: operation.target, preHash: operation.preHash, expectedPostHash: operation.expectedPostHash, argsDigest: operation.argsDigest, state: operation.state, dispatched: operation.dispatched });
	const currentEvidence = (current: State): SourceVersionRef[] => {
		const evidence = new Map((current.checkpoint?.evidence ?? []).map((ref) => [sourceKey(ref), ref]));
		for (const [key, receipt] of current.receipts) if (!evidence.has(key)) evidence.set(key, receipt.ref);
		return [...evidence.values()];
	};
	const sameIntent = (a: PendingCheckpointOperation, b: PendingCheckpointOperation): boolean => a.operationId === b.operationId && a.toolName === b.toolName && a.target === b.target && a.preHash === b.preHash && (a.expectedPostHash === b.expectedPostHash || (a.expectedPostHash === null && b.state === "completed")) && a.argsDigest === b.argsDigest;
	const ensure = (ctx: any, run: any): State => {
		deps.assertRun(run);
		if (state?.owner === owner(run.scope)) return state;
		state = { owner: owner(run.scope), checkpoint: null, error: null, sequence: 0, receipts: new Map(), observationIds: new Set(), artifacts: new Map(), operations: new Map(), stale: new Set() };
		try {
			const branch = ctx.sessionManager?.getBranch?.() ?? [];
			state.checkpoint = deps.store.latest(branch, run.scope);
			for (const operation of state.checkpoint?.pendingOperations ?? []) state.operations.set(operation.operationId, cloneOperation(operation));
			for (const ref of state.checkpoint?.artifacts ?? []) state.artifacts.set(sourceKey(ref), { ...ref });
			for (const id of state.checkpoint?.observationIds ?? []) state.observationIds.add(id);
			for (const issue of state.checkpoint?.unresolvedIssues ?? []) if (issue.code === "STALE_SOURCE") state.stale.add(issue.message);
			// Only tool results after the restored checkpoint can be new dependencies.
			// A durable stale latch still requires an in-process read after restoration.
			const checkpointIndex = state.checkpoint ? branch.findLastIndex((entry: any) => entry?.type === "custom" && entry?.customType === "pi-desktop-task-checkpoint" && entry?.data?.id === state!.checkpoint!.id) : -1;
			for (const entry of branch.slice(checkpointIndex + 1)) {
				const details = entry?.type === "message" && entry.message?.role === "toolResult" ? entry.message?.details : entry?.details;
				const observed = details?.observedRun;
				if (!observed || owner(observed) !== state.owner || !Array.isArray(details?.observation?.sourceRefs)) continue;
				for (const raw of details.observation.sourceRefs) {
					const neutral = raw?.authority === "unclassified" && !raw?.memoryId ? { ...raw, authority: "reference", temporal: "unspecified" } : raw;
					const ref = deps.versions.normalize(neutral); if (!state.stale.has(ref.path)) state.receipts.set(sourceKey(ref), { ref, sequence: ++state.sequence });
				}
			}
		} catch { state.error = "检查点格式或完整性无效；请检查会话记录，不能回退使用旧检查点。"; }
		return state;
	};
	const assertOwned = (current: State, run: any): void => { deps.assertRun(run); if (state !== current || current.owner !== owner(run.scope)) throw new Error("Checkpoint run is no longer active"); };
	const snapshot = (ctx: any, run: any, cause: TaskCheckpoint["cause"], supplied?: Partial<TaskCheckpoint>): TaskCheckpoint => {
		const current = ensure(ctx, run); if (current.error) throw new Error(current.error);
		const previous = current.checkpoint; const branchConstraints: string[] = [];
		for (const entry of ctx.sessionManager?.getBranch?.() ?? []) if (entry.type === "message" && entry.message?.role === "user") { const value = text(entry.message); if (value) branchConstraints.push(value); }
		const constraints = branchConstraints.length ? branchConstraints : [...(previous?.hardConstraints ?? [])];
		const objective = branchConstraints.at(-1) ?? previous?.objective ?? "";
		const evidence = new Map((previous?.evidence ?? []).map((ref) => [sourceKey(ref), ref]));
		for (const [key, receipt] of current.receipts) if (!evidence.has(key)) evidence.set(key, receipt.ref);
		return deps.store.build({ scope: { ...run.scope }, objective, hardConstraints: constraints, evidence: [...evidence.values()], observationIds: [...current.observationIds].slice(-128), artifacts: [...current.artifacts.values()], unresolvedIssues: [...(previous?.unresolvedIssues ?? []).filter((issue) => issue.code !== "STALE_SOURCE"), ...[...current.stale].map((path) => ({ code: "STALE_SOURCE", message: path }))], allowedNextActions: ["核验来源；失效时重新读取并 refresh_task_checkpoint；只在现有角色权限内继续；人工验收与 Canon 晋升仍由用户决定"], pendingOperations: [...current.operations.values()].map(cloneOperation), budget: { ...deps.budget(run.scope), requestEstimate: null }, cause, ...supplied });
	};
	const poison = (current: State): void => { current.error = "检查点持久化失败；为避免重放或越权，本任务已禁止继续写入。"; };
	const persist = (ctx: any, run: any, cause: TaskCheckpoint["cause"], supplied?: Partial<TaskCheckpoint>): TaskCheckpoint => {
		const current = ensure(ctx, run); let checkpoint: TaskCheckpoint;
		try { checkpoint = snapshot(ctx, run, cause, supplied); assertOwned(current, run); if (checkpoint.id !== current.checkpoint?.id) deps.append(checkpoint); }
		catch (error) { poison(current); throw error; }
		current.checkpoint = checkpoint; return checkpoint;
	};
	const inspect = async (ctx: any, run: any) => {
		const current = ensure(ctx, run);
		if (current.error) return { checkpoint: current.checkpoint, status: "blocked", invalidPaths: [...current.stale], blockedOperationIds: [...current.operations.values()].filter((x) => !["completed", "cancelled", "failed"].includes(x.state)).map((x) => x.operationId), writeAuthority: false, error: current.error };
		const checkpoint = current.checkpoint; const evidence = checkpoint?.evidence ?? [];
		const receiptRefs = [...current.receipts.values()].map((x) => x.ref).filter((ref) => !evidence.some((old) => sourceKey(old) === sourceKey(ref) && old.sha256 === ref.sha256));
		const cache = new Map<string, any>(); const check = (refs: SourceVersionRef[]) => deps.versions.revalidate(refs, (ref) => deps.resolve(ref, ctx, run, cache), run.controller.signal);
		const sources = await check([...evidence, ...receiptRefs]); assertOwned(current, run);
		const artifacts = await check([...current.artifacts.values()]); assertOwned(current, run);
		const pinnedEvidence = currentEvidence(current);
		let newlyStale = false;
		for (const item of [...sources.checks, ...artifacts.checks]) if (item.status !== "valid" && !current.stale.has(item.ref.path)) { newlyStale = true; current.stale.add(item.ref.path); for (const [key, receipt] of current.receipts) if (receipt.ref.path === item.ref.path) current.receipts.delete(key); }
		if (newlyStale) try { persist(ctx, run, "refresh", { evidence: pinnedEvidence }); } catch { return { checkpoint: current.checkpoint, status: "blocked", invalidPaths: [...current.stale], blockedOperationIds: [...current.operations.values()].filter((x) => !["completed", "cancelled", "failed"].includes(x.state)).map((x) => x.operationId), writeAuthority: false, error: current.error }; }
		const evaluation = deps.invalidation.evaluate({ scopeMatches: true, sources: sources.checks, artifactChecks: artifacts.checks, pendingOperations: [...current.operations.values()] });
		const status = evaluation.status === "ready" && current.stale.size ? "needs_revalidation" : (!checkpoint && evaluation.status === "ready" ? "empty" : evaluation.status);
		return { checkpoint: current.checkpoint, status, invalidPaths: [...new Set([...current.stale, ...evaluation.invalidPaths])], blockedOperationIds: evaluation.blockedOperationIds, writeAuthority: false };
	};
	const reconcile = async (ctx: any, run: any): Promise<void> => {
		const current = ensure(ctx, run); if (current.error) return;
		const operations = new Map([...current.operations].map(([id, op]) => [id, cloneOperation(op)])); const artifacts = new Map(current.artifacts); let changed = false; const cache = new Map<string, any>();
		for (const operation of operations.values()) {
			if (["completed", "cancelled", "failed"].includes(operation.state) || !operation.expectedPostHash) continue;
			const value = await deps.resolve({ path: operation.target, sha256: operation.expectedPostHash }, ctx, run, cache); assertOwned(current, run);
			if (value.sha256 !== operation.expectedPostHash) continue;
			operation.state = "completed"; const ref = { path: operation.target, sha256: operation.expectedPostHash, authority: "reference", temporal: "unspecified" }; artifacts.set(sourceKey(ref), ref); changed = true;
		}
		if (!changed) return;
		persist(ctx, run, "write_result", { pendingOperations: [...operations.values()], artifacts: [...artifacts.values()] }); current.operations = operations; current.artifacts = artifacts;
	};
	return {
		reset() { state = null; }, restore(ctx: any, run: any) { state = null; ensure(ctx, run); },
		observe(ctx: any, run: any, refs: SourceVersionRef[], observationId?: string) {
			const current = ensure(ctx, run); for (const raw of refs) { const ref = deps.versions.normalize(raw); const key = sourceKey(ref); if (!current.receipts.has(key) && current.receipts.size >= 128) throw new Error("Checkpoint evidence receipt capacity exceeded"); current.receipts.set(key, { ref, sequence: ++current.sequence }); }
			if (observationId) { current.observationIds.delete(observationId); current.observationIds.add(observationId); while (current.observationIds.size > 128) current.observationIds.delete(current.observationIds.values().next().value as string); }
		},
		capture(ctx: any, run: any, cause: TaskCheckpoint["cause"] = "manual") { return persist(ctx, run, cause); }, inspect,
		async refresh(ctx: any, run: any) {
			const current = ensure(ctx, run); if (current.error) return inspect(ctx, run); const checkpoint = current.checkpoint;
			if (!checkpoint) { persist(ctx, run, "refresh"); return inspect(ctx, run); }
			const evidence: SourceVersionRef[] = [], artifacts: SourceVersionRef[] = [], cache = new Map<string, any>(), unresolved = new Set<string>();
			for (const [refs, output, artifact] of [[checkpoint.evidence, evidence, false], [[...current.artifacts.values()], artifacts, true]] as const) for (const old of refs) {
				const exact = current.receipts.get(sourceKey(old));
				const rawReceipts = [...current.receipts.values()].filter((item) => item.ref.path === old.path && !item.ref.memoryId).sort((a, b) => b.sequence - a.sequence);
				const covering = !artifact && !old.memoryId ? rawReceipts.find((item) => item.ref.authority === old.authority && item.ref.temporal === old.temporal && old.startLine !== undefined && item.ref.startLine !== undefined && item.ref.startLine <= old.startLine && item.ref.endLine! >= old.endLine!) : undefined;
				const artifactProof = artifact && !old.memoryId ? rawReceipts[0] : undefined;
				const receipt = exact ?? covering ?? artifactProof;
				const candidate = exact?.ref ?? covering?.ref ?? (artifactProof ? { ...old, sha256: artifactProof.ref.sha256 } : old);
				const check = await deps.versions.revalidate([candidate], (ref) => deps.resolve(ref, ctx, run, cache), run.controller.signal); assertOwned(current, run);
				if (!check.valid || (current.stale.has(old.path) && !receipt)) { unresolved.add(old.path); output.push(old); } else output.push(candidate);
			}
			await reconcile(ctx, run); assertOwned(current, run);
			for (const ref of current.artifacts.values()) if (!artifacts.some((old) => sourceKey(old) === sourceKey(ref))) artifacts.push(ref);
			persist(ctx, run, "refresh", { evidence, artifacts, unresolvedIssues: [...checkpoint.unresolvedIssues.filter((x) => x.code !== "STALE_SOURCE"), ...[...unresolved].map((path) => ({ code: "STALE_SOURCE", message: path }))] }); current.stale = unresolved; current.artifacts = new Map(artifacts.map((ref) => [sourceKey(ref), ref])); return inspect(ctx, run);
		},
		async writeGate(ctx: any, run: any, intent?: { target: string; argsDigest: string; toolName: string; operationId: string }) {
			const current = ensure(ctx, run); if (current.error) return "[checkpoint_persistence] 检查点持久化失败，禁止写入。"; try { await reconcile(ctx, run); } catch { return "[checkpoint_persistence] 检查点持久化失败，禁止写入。"; }
			const status = await inspect(ctx, run); if (status.status === "blocked" || status.status === "needs_revalidation") { if (current.stale.size && !current.error) try { persist(ctx, run, "refresh"); } catch { return "[checkpoint_persistence] 检查点持久化失败，禁止写入。"; } return "[" + (status.blockedOperationIds.length ? "unknown_outcome" : "stale_source") + "] 检查点需要核验，禁止写入；重读来源并 refresh_task_checkpoint。"; }
			if (intent) for (const operation of current.operations.values()) if (operation.operationId === intent.operationId || (operation.state === "completed" && operation.target === intent.target && operation.argsDigest === intent.argsDigest && operation.toolName === intent.toolName)) return "[reconciled] 已记录该写入意图 (satisfied)，禁止重复执行。";
			return null;
		},
		operation(ctx: any, run: any, raw: PendingCheckpointOperation, postHash?: string | null) {
			const current = ensure(ctx, run); if (current.error) throw new Error(current.error); const operation = cloneOperation(raw), existing = current.operations.get(operation.operationId);
			if (existing && !sameIntent(existing, operation)) throw new Error("Checkpoint operation ID collision"); if (!existing && current.operations.size >= 64) throw new Error("Checkpoint operation capacity exceeded; start a new scoped task");
			if (!existing && (operation.dispatched || operation.state !== "issued")) throw new Error("Checkpoint operation must be registered before dispatch");
			if (existing) { if (existing.dispatched && !operation.dispatched) throw new Error("Checkpoint operation cannot return to an undispatched state"); if (["completed", "cancelled", "failed"].includes(existing.state) && operation.state !== existing.state) throw new Error("Checkpoint operation terminal state is immutable"); if (existing.state === "unknown" && !["unknown", "completed"].includes(operation.state)) throw new Error("Unknown checkpoint operation cannot be replayed"); }
			const operations = new Map(current.operations); operations.set(operation.operationId, operation); const artifacts = new Map(current.artifacts); let evidence = currentEvidence(current); const stale = new Set(current.stale);
			if (postHash && raw.state === "completed") { const ref = { path: raw.target, sha256: postHash, authority: "reference", temporal: "unspecified" }; artifacts.set(sourceKey(ref), ref); evidence = evidence.filter((old) => old.path !== raw.target || Boolean(old.memoryId)); if (evidence.some((old) => old.path === raw.target && Boolean(old.memoryId))) stale.add(raw.target); }
			persist(ctx, run, raw.state === "issued" ? "write_intent" : "write_result", { pendingOperations: [...operations.values()], artifacts: [...artifacts.values()], evidence, unresolvedIssues: [...(current.checkpoint?.unresolvedIssues ?? []).filter((x) => x.code !== "STALE_SOURCE"), ...[...stale].map((path) => ({ code: "STALE_SOURCE", message: path }))] }); current.operations = operations; current.artifacts = artifacts; current.stale = stale; for (const [key, receipt] of current.receipts) if (receipt.ref.path === raw.target) current.receipts.delete(key);
		},
	};
}
