import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sha256, treeManifest, withProject, type RunCase } from "./testkit.js";

const execute = promisify(execFile);
const verifier = path.resolve("scripts/verify-novel-chapter.ts");
const chapter = "002";
const candidate = "drafts/candidates/chapters/002.md";
const card = "planning/chapter-cards/002.md";
const acceptance = ".novel/acceptances/002-manuscript.json";
const report = "planning/verifications/002-verification.md";

type VerificationResult = { code: number; stdout: string; stderr: string };

async function verify(root: string, noWrite = true): Promise<VerificationResult> {
	const args = ["--experimental-strip-types", verifier, "--project", root, "--chapter", chapter];
	if (noWrite) args.push("--no-write");
	try {
		const result = await execute(process.execPath, args, { encoding: "utf8" });
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
		return { code: typeof failure.code === "number" ? failure.code : -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
	}
}

function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((name) => before[name] !== after[name])
		.sort();
}

export async function runVerifierCases(runCase: RunCase): Promise<void> {
	await runCase("VFY-01", (recordEvent) => withProject(async (root) => {
		const initial = await treeManifest(root);
		const acceptanceBefore = initial[acceptance];
		const sourceSha = initial[candidate];
		assert.ok(acceptanceBefore && sourceSha, "Fixture must include accepted candidate and record");

		const dryRun = await verify(root, true);
		assert.equal(dryRun.code, 0, dryRun.stderr || dryRun.stdout);
		assert.match(dryRun.stdout, /^chapter: 002$/m);
		assert.match(dryRun.stdout, /^source_text: drafts\/candidates\/chapters\/002\.md$/m);
		assert.match(dryRun.stdout, /^verification_status: PASS$/m);
		assert.deepEqual(await treeManifest(root), initial, "--no-write verifier must not mutate the project");

		const written = await verify(root, false);
		assert.equal(written.code, 0, written.stderr || written.stdout);
		const after = await treeManifest(root);
		assert.deepEqual(changedPaths(initial, after), [report], "Verifier may add only its report");
		assert.match(await readFile(path.join(root, report), "utf8"), /^verification_status: PASS$/m);
		assert.equal(after[acceptance], acceptanceBefore, "PASS must not create or change acceptance");
		assert.equal(after[candidate], sourceSha, "PASS must not modify candidate prose");
		await assert.rejects(access(path.join(root, "manuscript/chapters/002.md")), "PASS must not promote prose to Canon");
		recordEvent("verifier.pass", { chapter: 2, exitCode: written.code, sourceSha, reportWritten: true, nonReportChanges: 0, acceptanceChanged: false, promoted: false });
	}));

	await runCase("VFY-02", async (recordEvent) => {
		let contractCode = 0;
		await withProject(async (root) => {
			const filename = path.join(root, card);
			await writeFile(filename, (await readFile(filename, "utf8")).replace("target_chars: 700", "target_chars: 701"), "utf8");
			const before = await treeManifest(root);
			const result = await verify(root, true);
			contractCode = result.code;
			assert.notEqual(result.code, 0);
			assert.match(result.stdout, /\[CONTRACT\].*Architecture\/card mismatch for target_chars/);
			assert.deepEqual(await treeManifest(root), before);
		});

		let bodyCode = 0;
		let bodySha = "";
		await withProject(async (root) => {
			const filename = path.join(root, candidate);
			await writeFile(filename, (await readFile(filename, "utf8")) + "\n- 这不是小说正文\n", "utf8");
			const before = await treeManifest(root);
			bodySha = before[candidate];
			const result = await verify(root, true);
			bodyCode = result.code;
			assert.notEqual(result.code, 0);
			assert.match(result.stdout, /\[MARKDOWN_LIST\]/);
			assert.doesNotMatch(result.stdout, /\[CONTRACT\]/);
			assert.deepEqual(await treeManifest(root), before);
		});
		recordEvent("verifier.failures", { contractExitCode: contractCode, bodyExitCode: bodyCode, contractCode: "CONTRACT", bodyCode: "MARKDOWN_LIST", bodySha, projectWrites: 0 });
	});

	await runCase("FI-04", (recordEvent) => withProject(async (root) => {
		const filename = path.join(root, candidate);
		await writeFile(filename, (await readFile(filename, "utf8")) + "\n绿色记录册已经启用\n", "utf8");
		const before = await treeManifest(root);
		const result = await verify(root, true);
		assert.notEqual(result.code, 0);
		assert.match(result.stdout, /\[FORBIDDEN_REVEAL\]/);
		assert.deepEqual(await treeManifest(root), before, "Injected verifier failure must not add a report or acceptance");
		assert.equal(before[acceptance], (await treeManifest(root))[acceptance]);
		await assert.rejects(access(path.join(root, "manuscript/chapters/002.md")));
		recordEvent("verifier.injected_failure", { exitCode: result.code, code: "FORBIDDEN_REVEAL", sourceSha: before[candidate], reportWritten: false, acceptanceChanged: false, promoted: false });
	}));
}
