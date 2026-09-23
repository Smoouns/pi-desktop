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
	pathKey?: (path: string) => string;
	task?: (ctx: any, run: any) => { taskId: string; revision: number; id: string; objective: string; latestUserInstruction: string } | null;
}) {
	type Receipt = { ref: SourceVersionRef; sequence: number };
	type State = { owner: string; checkpoint: TaskCheckpoint | null; error: string | null; sequence: number; receipts: Map<string, Receipt>; legacy: Map<string, SourceVersionRef>; deliveryEpoch: number; observationIds: Set<string>; artifacts: Map<string, SourceVersionRef>; operations: Map<string, PendingCheckpointOperation>; stale: Set<string> };
	let state: State | null = null;
	let epoch = 0;
	const owner = (scope: RunScope) => JSON.stringify([scope.projectId, scope.sessionId, scope.role]);
	const sourceKey = (ref: SourceVersionRef) => JSON.stringify([ref.path, ref.startLine ?? null, ref.endLine ?? null, ref.authority ?? null, ref.temporal ?? null, Boolean(ref.memoryId)]);
	const normalize = (raw: SourceVersionRef) => deps.versions.normalize({ ...raw, path: deps.pathKey?.(raw.path) ?? raw.path });
	const text = (message: any): string => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
	const cloneOperation = (operation: PendingCheckpointOperation): PendingCheckpointOperation => ({ operationId: operation.operationId, toolName: operation.toolName, target: operation.target, preHash: operation.preHash, expectedPostHash: operation.expectedPostHash, argsDigest: operation.argsDigest, state: operation.state, dispatched: operation.dispatched });
	const currentEvidence = (current: State): SourceVersionRef[] => {
		const evidence = new Map((current.checkpoint?.evidence ?? []).map((ref) => [sourceKey(ref), ref]));
		for (const [key, ref] of current.legacy) if (!evidence.has(key)) evidence.set(key, ref);
		for (const [key, receipt] of current.receipts) if (!evidence.has(key)) evidence.set(key, receipt.ref);
		return [...evidence.values()];
	};
	const sameIntent = (a: PendingCheckpointOperation, b: PendingCheckpointOperation): boolean => a.operationId === b.operationId && a.toolName === b.toolName && a.target === b.target && a.preHash === b.preHash && (a.expectedPostHash === b.expectedPostHash || (a.expectedPostHash === null && b.state === "completed")) && a.argsDigest === b.argsDigest;
	const ensure = (ctx: any, run: any): State => {
		deps.assertRun(run);
		if (state?.owner === owner(run.scope)) return state;
		state = { owner: owner(run.scope), checkpoint: null, error: null, sequence: 0, receipts: new Map(), legacy: new Map(), deliveryEpoch: ++epoch, observationIds: new Set(), artifacts: new Map(), operations: new Map(), stale: new Set() };
		try {
			const branch = ctx.sessionManager?.getBranch?.() ?? [];
			state.checkpoint = deps.store.latest(branch, run.scope);
			for (const operation of state.checkpoint?.pendingOperations ?? []) state.operations.set(operation.operationId, cloneOperation(operation));
			for (const ref of state.checkpoint?.artifacts ?? []) state.artifacts.set(sourceKey(ref), { ...ref });
			for (const id of state.checkpoint?.observationIds ?? []) state.observationIds.add(id);
			for (const issue of state.checkpoint?.unresolvedIssues ?? []) if (issue.code === "STALE_SOURCE") state.stale.add(issue.message);
			if (state.checkpoint && state.checkpoint.evidenceFormat !== "delivered-v1") for (const ref of state.checkpoint.evidence) state.stale.add(ref.path);
			// Only tool results after the restored checkpoint can be new dependencies.
			// A durable stale latch still requires an in-process read after restoration.
			const checkpointIndex = state.checkpoint ? branch.findLastIndex((entry: any) => entry?.type === "custom" && entry?.customType === "pi-desktop-task-checkpoint" && entry?.data?.id === state!.checkpoint!.id) : -1;
			for (const entry of branch.slice(checkpointIndex + 1)) {
				const details = entry?.type === "message" && entry.message?.role === "toolResult" ? entry.message?.details : entry?.details;
				const observed = details?.observedRun;
				if (!observed || owner(observed) !== state.owner || entry.message?.isError) continue;
				const delivered = details.readDelivery?.schemaVersion === 1;
				const refs = delivered ? details.readDelivery.sourceRefs : details?.observation?.sourceRefs;
				if (!Array.isArray(refs)) continue;
				for (const raw of refs) {
					const neutral = raw?.authority === "unclassified" && !raw?.memoryId ? { ...raw, authority: "reference", temporal: "unspecified" } : raw;
					const ref = normalize(neutral);
					if (!delivered) { state.legacy.set(sourceKey(ref), ref); state.stale.add(ref.path); }
					else if (!state.stale.has(ref.path)) state.receipts.set(sourceKey(ref), { ref, sequence: ++state.sequence });
					if (state.receipts.size > 128 || state.legacy.size > 128) throw new Error("Checkpoint restored receipt capacity exceeded");
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
		const task = deps.task?.(ctx, run);
		const objective = task?.objective ?? previous?.objective ?? branchConstraints[0] ?? "";
		return deps.store.build({ scope: { ...run.scope }, evidenceFormat: "delivered-v1", objective,
			...(task ? { latestUserInstruction: task.latestUserInstruction, taskRef: { taskId: task.taskId, revision: task.revision, contractId: task.id } } : {}),
			hardConstraints: constraints, evidence: currentEvidence(current), observationIds: [...current.observationIds].slice(-128), artifacts: [...current.artifacts.values()], unresolvedIssues: [...(previous?.unresolvedIssues ?? []).filter((issue) => issue.code !== "STALE_SOURCE"), ...[...current.stale].map((path) => ({ code: "STALE_SOURCE", message: path }))], allowedNextActions: ["核验来源；失效时重新读取并 refresh_task_checkpoint；只在现有角色权限内继续；人工验收与 Canon 晋升仍由用户决定"], pendingOperations: [...current.operations.values()].map(cloneOperation), budget: { ...deps.budget(run.scope), requestEstimate: null }, cause, ...supplied });
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
		const checkpoint = current.checkpoint;
		const pinned = new Map((checkpoint?.evidence ?? []).map((ref) => [sourceKey(ref), ref]));
		for (const [key, ref] of current.legacy) if (!pinned.has(key)) pinned.set(key, ref);
		const evidence = [...pinned.values()];
		const receiptRefs = [...current.receipts.values()].map((x) => x.ref).filter((ref) => !evidence.some((old) => sourceKey(old) === sourceKey(ref) && old.sha256 === ref.sha256));
		const cache = new Map<string, any>(); const check = (refs: SourceVersionRef[]) => deps.versions.revalidate(refs, (ref) => deps.resolve(ref, ctx, run, cache), run.controller.signal);
		const sources = await check([...evidence, ...receiptRefs]); assertOwned(current, run);
		const artifacts = await check([...current.artifacts.values()]); assertOwned(current, run);
		const pinnedEvidence = currentEvidence(current);
		let newlyStale = false;
		for (const item of [...sources.checks, ...artifacts.checks]) if (item.status !== "valid" && !current.stale.has(item.ref.path)) { newlyStale = true; current.stale.add(item.ref.path); for (const [key, receipt] of current.receipts) if (receipt.ref.path === item.ref.path) current.receipts.delete(key); }
		if (newlyStale) try { current.deliveryEpoch = ++epoch; persist(ctx, run, "refresh", { evidence: pinnedEvidence }); } catch { return { checkpoint: current.checkpoint, status: "blocked", invalidPaths: [...current.stale], blockedOperationIds: [...current.operations.values()].filter((x) => !["completed", "cancelled", "failed"].includes(x.state)).map((x) => x.operationId), writeAuthority: false, error: current.error }; }
		const evaluation = deps.invalidation.evaluate({ scopeMatches: true, sources: sources.checks, artifactChecks: artifacts.checks, pendingOperations: [...current.operations.values()] });
		const status = evaluation.status === "ready" && current.stale.size ? "needs_revalidation" : (!checkpoint && evaluation.status === "ready" ? "empty" : evaluation.status);
		return { checkpoint: current.checkpoint, status, invalidPaths: [...new Set([...current.stale, ...evaluation.invalidPaths])], blockedOperationIds: evaluation.blockedOperationIds, writeAuthority: false };
	};
	const reconcile = async (ctx: any, run: any): Promise<void> => {
		const current = ensure(ctx, run); if (current.error) return;
		const operations = new Map([...current.operations].map(([id, op]) => [id, cloneOperation(op)])); const artifacts = new Map(current.artifacts); let changed = false; const cache = new Map<string, any>();
		for (const operation of operations.values()) {
			if (["completed", "cancelled", "failed"].includes(operation.state) || !operation.dispatched || !operation.expectedPostHash) continue;
			const value = await deps.resolve({ path: operation.target, sha256: operation.expectedPostHash }, ctx, run, cache); assertOwned(current, run);
			if (value.sha256 !== operation.expectedPostHash) continue;
			operation.state = "completed"; const ref = { path: operation.target, sha256: operation.expectedPostHash, authority: "reference", temporal: "unspecified" }; artifacts.set(sourceKey(ref), ref); changed = true;
		}
		if (!changed) return;
		persist(ctx, run, "write_result", { pendingOperations: [...operations.values()], artifacts: [...artifacts.values()] }); current.operations = operations; current.artifacts = artifacts;
	};
	return {
		reset() { state = null; }, restore(ctx: any, run: any) { state = null; ensure(ctx, run); },
		deliveryEpoch(ctx: any, run: any) { return ensure(ctx, run).deliveryEpoch; },
		observe(ctx: any, run: any, refs: SourceVersionRef[], observationId?: string) {
			const current = ensure(ctx, run), receipts = new Map(current.receipts); let sequence = current.sequence;
			for (const raw of refs) { const ref = normalize(raw); receipts.set(sourceKey(ref), { ref, sequence: ++sequence }); }
			if (receipts.size > 128) throw new Error("Checkpoint evidence receipt capacity exceeded");
			current.receipts = receipts; current.sequence = sequence;
			if (observationId) { current.observationIds.delete(observationId); current.observationIds.add(observationId); while (current.observationIds.size > 128) current.observationIds.delete(current.observationIds.values().next().value as string); }
		},
		capture(ctx: any, run: any, cause: TaskCheckpoint["cause"] = "manual") { return persist(ctx, run, cause); }, inspect,
		async refresh(ctx: any, run: any) {
			const current = ensure(ctx, run); if (current.error) return inspect(ctx, run); const checkpoint = current.checkpoint ?? persist(ctx, run, "refresh");
			const evidence: SourceVersionRef[] = [], artifacts: SourceVersionRef[] = [], cache = new Map<string, any>(), unresolved = new Set<string>();
			for (const [refs, output, artifact] of [[currentEvidence(current), evidence, false], [[...current.artifacts.values()], artifacts, true]] as const) for (const old of refs) {
				let version: SourceVersionResolverResult;
				try { version = await deps.resolve(old, ctx, run, cache); } catch { version = { sha256: null }; }
				assertOwned(current, run);
				const recorded = current.receipts.get(sourceKey(old));
				const exact = recorded?.ref.sha256 === version.sha256 ? recorded : undefined;
				const rawReceipts = [...current.receipts.values()].filter((item) => item.ref.path === old.path && !item.ref.memoryId && item.ref.sha256 === version.sha256).sort((a, b) => b.sequence - a.sequence);
				const covering = !artifact && !old.memoryId ? rawReceipts.find((item) => item.ref.authority === old.authority && item.ref.temporal === old.temporal && old.startLine !== undefined && item.ref.startLine !== undefined && item.ref.startLine <= old.startLine && item.ref.endLine! >= old.endLine!) : undefined;
				let combined: SourceVersionRef | undefined;
				if (!exact && !covering && !artifact && !old.memoryId) {
					const start = old.startLine ?? 1, end = old.endLine ?? version.totalLines;
					const compatible = rawReceipts.map((item) => item.ref).filter((ref) => ref.sha256 === version.sha256 && ref.authority === old.authority && ref.temporal === old.temporal && ref.startLine !== undefined).sort((a, b) => a.startLine! - b.startLine!);
					let next = start;
					for (const ref of compatible) { if (ref.startLine! > next) break; next = Math.max(next, ref.endLine! + 1); }
					if (end !== undefined && next > end && version.sha256) combined = { ...old, sha256: version.sha256, startLine: start, endLine: end };
				}
				const artifactProof = artifact && !old.memoryId ? rawReceipts[0] : undefined;
				const receipt = exact ?? covering ?? combined ?? artifactProof;
				const candidate = exact?.ref ?? covering?.ref ?? combined ?? (artifactProof ? { ...old, sha256: artifactProof.ref.sha256 } : old);
				const check = await deps.versions.revalidate([candidate], (ref) => deps.resolve(ref, ctx, run, cache), run.controller.signal); assertOwned(current, run);
				if (!check.valid || (current.stale.has(old.path) && !receipt)) { unresolved.add(old.path); output.push(old); } else output.push(candidate);
			}
			await reconcile(ctx, run); assertOwned(current, run);
			for (const ref of current.artifacts.values()) if (!artifacts.some((old) => sourceKey(old) === sourceKey(ref))) artifacts.push(ref);
			persist(ctx, run, "refresh", { evidence, artifacts, unresolvedIssues: [...checkpoint.unresolvedIssues.filter((x) => x.code !== "STALE_SOURCE"), ...[...unresolved].map((path) => ({ code: "STALE_SOURCE", message: path }))] });
			// Every old dependency on these paths was covered above. Retire only its
			// obsolete version, so a stale exact receipt cannot shadow fresh pages.
			for (const [key, receipt] of current.receipts) if (!unresolved.has(receipt.ref.path) && evidence.some((ref) => ref.path === receipt.ref.path && ref.sha256 !== receipt.ref.sha256)) current.receipts.delete(key);
			current.legacy.clear(); current.stale = unresolved; current.artifacts = new Map(artifacts.map((ref) => [sourceKey(ref), ref])); return inspect(ctx, run);
		},
		async writeGate(ctx: any, run: any, intent?: { target: string; argsDigest: string; toolName: string; operationId: string }) {
			const current = ensure(ctx, run); if (current.error) return "[checkpoint_persistence] 检查点持久化失败，禁止写入。"; try { await reconcile(ctx, run); } catch { return "[checkpoint_persistence] 检查点持久化失败，禁止写入。"; }
			const status = await inspect(ctx, run); if (status.status === "blocked" || status.status === "needs_revalidation") { if (current.stale.size && !current.error) try { persist(ctx, run, "refresh"); } catch { return "[checkpoint_persistence] 检查点持久化失败，禁止写入。"; } return "[" + (status.blockedOperationIds.length ? "unknown_outcome" : "stale_source") + "] 检查点需要核验，禁止写入；重读来源并 refresh_task_checkpoint。"; }
			if (intent) {
				const matches = (operation: PendingCheckpointOperation) => operation.target === intent.target && operation.argsDigest === intent.argsDigest && operation.toolName === intent.toolName;
				const existing = current.operations.get(intent.operationId);
				if (existing && !matches(existing)) return "[operation_id_collision] 调用 ID 已绑定其他写入意图，禁止复用。";
				if (existing?.state === "cancelled") return "[operation_cancelled] 该调用已取消，旧操作不能再次派发。";
				const related = existing ? [existing] : [...current.operations.values()].filter(matches);
				if (related.some((operation) => operation.state === "failed")) return "[operation_failed] 该写入意图已明确失败；请修正参数并使用新调用，不要重复原输入。";
				const completed = related.filter((operation) => operation.state === "completed");
				if (completed.length) {
					// Artifact refresh may have accepted B after this operation wrote A.
					// History stays completed; current satisfaction needs the operation's
					// own post-image, not today's artifact ref or a matching tool-call ID.
					const postImages = completed.filter((operation) => operation.expectedPostHash !== null).map((operation) => ({ path: operation.target, sha256: operation.expectedPostHash! }));
					if (!postImages.length) return "[post_state_unverifiable] 历史操作已完成，但缺少可核验的后置指纹；不能确认当前内容，禁止自动重放。";
					const cache = new Map<string, any>();
					const check = await deps.versions.revalidate(postImages, (ref) => deps.resolve(ref, ctx, run, cache), run.controller.signal); assertOwned(current, run);
					if (check.checks.some((item) => item.status === "valid")) return "[reconciled] 当前文件已核验满足该意图 (currently_satisfied)，未重复执行写入。";
					if (check.checks.some((item) => item.status === "unavailable" || item.status === "ineligible")) return "[post_state_unverifiable] 无法核验历史操作的当前后置状态，禁止自动重放。";
					return "[post_state_conflict] 该意图曾执行完成，但当前文件已不匹配原后置内容；历史记录保留，禁止自动重放。请核对差异后建立新的明确写入意图，不能仅更换调用 ID 重试。";
				}
			}
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
