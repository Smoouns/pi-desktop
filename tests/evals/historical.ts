import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createContextBudget as createCurrentContextBudget } from "../../src/harness/context-budget.js";
import { createHistoricalAdapter, historicalProfiles, historicalProvenance, validateHistoricalSnapshots } from "../../evals/adapters/historical.js";

type Source = { path: string; gitBlob: string; sha256: string; localPath: string };
type Profile = { phaseCommit: string; capabilities: string[]; sources: Source[] };

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function gitSource(commit: string, source: Source): { object: string; bytes: Buffer } | null {
	if (process.env.PI_EVAL_WORKER === "1") return null;
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
		const object = execFileSync("git", ["rev-parse", `${commit}:${source.path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const bytes = execFileSync("git", ["show", `${commit}:${source.path}`], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
		return { object, bytes };
	} catch {
		return null;
	}
}

export async function runHistoricalTests(): Promise<number> {
	let count = 0;
	let gitChecks = 0;
	await validateHistoricalSnapshots(); count += 1;
	const profiles = historicalProvenance.profiles as Record<string, Profile>;
	assert.deepEqual(Object.keys(profiles).sort(), Object.keys(historicalProfiles).sort()); count += 1;
	for (const [id, profile] of Object.entries(profiles)) {
		assert.deepEqual(profile.capabilities, [...historicalProfiles[id as keyof typeof historicalProfiles]]); count += 1;
		const adapter = createHistoricalAdapter(id as keyof typeof historicalProfiles);
		assert.deepEqual(adapter.capabilities, profile.capabilities); count += 1;
		for (const source of profile.sources) {
			const bytes = await readFile(path.resolve(source.localPath));
			assert.equal(sha256(bytes), source.sha256, `snapshot SHA mismatch: ${source.localPath}`); count += 1;
			const git = gitSource(profile.phaseCommit, source);
			if (git !== null) {
				assert.equal(git.object, source.gitBlob, `phase commit blob mismatch: ${profile.phaseCommit}:${source.path}`); count += 1;
				assert.equal(sha256(git.bytes), source.sha256, `phase commit byte mismatch: ${profile.phaseCommit}:${source.path}`); count += 1;
				gitChecks += 1;
			}
		}
	}
	const historical = createHistoricalAdapter("historical-b2").contextBudget!({ defaultContextWindow: 512, defaultOutputReserve: 32, defaultSafetyMargin: 16 });
	const current = createCurrentContextBudget({ defaultContextWindow: 512, defaultOutputReserve: 32, defaultSafetyMargin: 16 });
	assert.equal(historical.estimator.kind, "utf8_bytes_upper_bound"); count += 1;
	assert.notEqual(historical.estimator.kind, current.estimator.kind); count += 1;
	assert.equal(createHistoricalAdapter("historical-b1").contextBudget, undefined); count += 1;
	assert.equal(createHistoricalAdapter("historical-b2").checkpointStore, undefined); count += 1;
	assert.equal(typeof createHistoricalAdapter("historical-b3").checkpointStore, "function"); count += 1;
	console.log(gitChecks > 0 ? `Historical provenance: ${gitChecks} live Git objects verified.` : "Historical provenance: metadata-hash-only (historical Git objects unavailable)." );
	return count;
}
