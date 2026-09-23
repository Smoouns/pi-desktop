/** SDK adapter over the frozen Phase 1 factories; not a reproduction of Rust/RPC session restore. */
export function installSdkReliability(pi: any, dependencies: any, metrics: Record<string, number>) {
	const { createOperationLedger, createToolRuntime, readFile, createHash, path, safety } = dependencies;
	const operations = createOperationLedger();
	const runtime = createToolRuntime({ maxTransientRetries: 2, maxRepairs: 0, maxRefreshes: 0 });
	const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
	let generation = 0;
	let active: { scope: any; controller: AbortController } | null = null;
	const identity = (ctx: any) => {
		const projectRoot = path.resolve(ctx.cwd);
		const role = [...(ctx.sessionManager.getBranch?.() ?? [])].reverse().find((entry: any) => entry.type === "custom" && entry.customType === "pi-desktop-novel-role")?.data?.role ?? null;
		return { projectId: sha(process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot), sessionId: ctx.sessionManager.getSessionId(), role };
	};
	const matches = (scope: any, ctx: any) => { const current = identity(ctx); return current.projectId === scope.projectId && current.sessionId === scope.sessionId && current.role === scope.role; };
	const stop = () => {
		active?.controller.abort();
		for (const entry of operations.snapshot()) if (entry.state === "issued") operations.cancel(entry.operationId);
		active = null;
	};
	const start = (ctx: any) => {
		stop(); generation++;
		active = { controller: new AbortController(), scope: { ...identity(ctx), runId: `sdk-${generation}`, generation } };
	};
	pi.on("agent_start", (_event: unknown, ctx: any) => { start(ctx); metrics.agentStarts++; });
	for (const event of ["agent_end", "session_switch", "session_shutdown"]) pi.on(event, () => { stop(); metrics.runStops++; });
	const version = async (ctx: any, target: string) => {
		const full = await safety.checkedPath(ctx.cwd, target, true);
		try { return sha(await readFile(full)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	};
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (event.toolName !== "write") return;
		if (!active || !matches(active.scope, ctx)) return { block: true, reason: "[cancelled] SDK run is inactive or its scope changed." };
		const run = active;
		const before = await version(ctx, event.input.path);
		if (run !== active || run.controller.signal.aborted) return { block: true, reason: "[cancelled] SDK run ended." };
		const decision = operations.prepare({ scope: run.scope, toolCallId: event.toolCallId, toolName: "write", target: event.input.path,
			preHash: before, expectedPostHash: sha(event.input.content), argsDigest: sha(JSON.stringify([event.input.content])) }, before);
		if (decision.action !== "dispatch") {
			if (decision.action === "satisfied") metrics.reconciledWrites++;
			else metrics.unknownWritesBlocked++;
			return { block: true, reason: decision.action === "satisfied" ? "[reconciled] Expected content already exists; write was not repeated." : "[unknown_outcome] Write unresolved; do not repeat." };
		}
		operations.markDispatched(decision.operationId);
	});
	pi.on("tool_result", async (event: any, ctx: any) => {
		if (event.toolName !== "write") return;
		const entry = operations.snapshot().find((item: any) => item.operationId === event.toolCallId);
		if (!entry) return;
		const run = active;
		if (!run || entry.scope.generation !== run.scope.generation || !matches(entry.scope, ctx)) {
			operations.cancel(entry.operationId); metrics.staleResults++; return;
		}
		try {
			const observed = await version(ctx, entry.target);
			if (active !== run || run.controller.signal.aborted) { operations.cancel(entry.operationId); metrics.staleResults++; return; }
			if (event.isError) operations.completeFailed(entry.operationId, observed);
			else operations.complete(entry.operationId, observed);
		} catch { operations.cancel(entry.operationId); }
		// SDK preserves built-in errors: never pretend a result patch converted a lost acknowledgement into success.
	});
	return {
		async read(execute: () => Promise<any>, signal?: AbortSignal) {
			const run = active;
			if (!run) throw new Error("SDK_RUN_INACTIVE");
			const result = await runtime.execute({ params: {}, signal: AbortSignal.any([run.controller.signal, ...(signal ? [signal] : [])]),
				operation: async () => {
					try {
						const value = await execute();
						if (value?.content?.some((part: any) => part.type === "text" && part.text.startsWith("Error:"))) return { ok: false, error: { kind: "precondition", code: "BASELINE_READ_ERROR", message: "Baseline read failed." } };
						return { ok: true, value };
					} catch (error) { return { ok: false, error: { kind: (error as any)?.code === "EAGAIN" ? "transient" : "fatal", code: "SDK_READ_ERROR", message: "SDK read failed." } }; }
				} });
			metrics.readRetries += result.actions.filter((action: string) => action === "retry").length;
			if (!result.result.ok) throw new Error("SDK_READ_FAILED");
			return result.result.value;
		},
	};
}
