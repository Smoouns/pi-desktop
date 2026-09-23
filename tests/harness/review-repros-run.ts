import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReviewContractViolation, runReviewRepros } from "./review-repros.js";
import { fixtureRoot, sha256, treeManifest, type RunCase } from "./testkit.js";

async function main(): Promise<void> {
const original = await treeManifest(fixtureRoot);
const parent = path.resolve("artifacts/harness/review-repros");
await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "review-"));
const cases: Array<{ id: string; status: "contract_pass" | "confirmed" | "error"; events: unknown[]; reason: string | null }> = [];
const runCase: RunCase = async (id, body) => {
	const events: unknown[] = [];
	let status: (typeof cases)[number]["status"] = "contract_pass", reason: string | null = null;
	try {
		assert.deepEqual(await treeManifest(fixtureRoot), original);
		await body((event, data) => { events.push({ event, data }); });
	} catch (error) {
		status = error instanceof ReviewContractViolation ? "confirmed" : "error";
		reason = status === "confirmed" ? (error as Error).message : "REPRO_SETUP_OR_CONTROL_FAILED";
		if (status === "error") console.error(error); // synthetic fixtures only; never provider payloads
	} finally {
		assert.deepEqual(await treeManifest(fixtureRoot), original, "review repro modified committed fixture");
	}
	cases.push({ id, status, events, reason });
	console.log(`${status.toUpperCase()} ${id}${reason ? `: ${reason}` : ""}`);
};
await runReviewRepros(runCase);
const implementation: Record<string, string> = {};
for (const name of ["src/extensions/novel-tools-extension.ts", "src/extensions/checkpoint-runtime.ts", "src/harness/checkpoint-store.ts",
	"src/harness/operation-ledger.ts", "tests/harness/review-repros.ts", "tests/harness/review-repros-run.ts", "tests/harness/phase4-extension.ts", "package-lock.json"]) {
	implementation[name] = sha256(await readFile(name));
}
const summary = { schemaVersion: 1, reviewBase: "87b4ac8e009e36471a9530ce3918f2a2b360d1f1",
	head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
	implementation, node: process.version, platform: process.platform,
	piSdk: JSON.parse(await readFile("node_modules/@mariozechner/pi-coding-agent/package.json", "utf8")).version,
	modelCalls: 0, fixtureUnchanged: true,
	boundary: "Full production extension + pinned SDK native tools and ExtensionRunner; synthetic session manager; no model, Desktop or cold reopen.", cases };
await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
console.log(`Review repro evidence: ${path.relative(process.cwd(), output)}`);
console.log(`Review contracts: ${cases.filter((item) => item.status === "confirmed").length} confirmed violations (NOT fixed), ${cases.filter((item) => item.status === "error").length} infrastructure/control errors.`);
// A confirmed bug must remain RED. Do not make the normal regression suite green
// by relabelling known failures as passing; this target is deliberately opt-in.
process.exitCode = cases.some((item) => item.status === "error") ? 2 : cases.some((item) => item.status === "confirmed") ? 1 : 0;
}

try { await main(); }
catch {
	// Missing fixtures, output/provenance failures and integrity failures are not
	// evidence that one of the review contracts was reproduced.
	console.error("REVIEW_REPRO_INFRASTRUCTURE_FAILED");
	process.exitCode = 2;
}
