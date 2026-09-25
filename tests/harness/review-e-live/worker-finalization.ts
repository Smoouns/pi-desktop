/** Test-driver teardown only. Preserve the primary failure and whatever evidence
 * is available even if an individual capture or shutdown operation fails. Never
 * issue a prompt/model request here. The second capture retains shutdown entries. */
export async function finalizeWorkerEvidence(result: any, hooks: {
	settle: () => unknown;
	evidence: Record<string, () => unknown>;
	shutdown: () => unknown;
	dispose: () => unknown;
	flush: () => unknown;
}) {
	result.finalizationErrors = [];
	const step = async (stage: string, action: () => unknown) => {
		try { await action(); }
		catch {
			// Do not copy arbitrary extension/provider errors into the teardown log.
			result.finalizationErrors.push({ stage, code: "E8_WORKER_FINALIZATION_FAILED" });
			result.failure ??= "E8_WORKER_FINALIZATION_FAILED:" + stage;
		}
	};
	const capture = async (stage: string) => {
		for (const [key, read] of Object.entries(hooks.evidence)) await step(stage + ":" + key, () => { result[key] = read(); });
	};
	await step("settle-before", hooks.settle);
	await capture("before-shutdown");
	await step("shutdown", hooks.shutdown);
	await step("settle-after", hooks.settle);
	await capture("after-shutdown");
	await step("dispose", hooks.dispose);
	await step("settings-flush", hooks.flush);
}
