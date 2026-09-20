import { strict as assert } from "node:assert";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(workspaceRoot, "fixtures", "harness-novel");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pi-desktop-novel-verifier-"));
const projectRoot = path.join(temporaryRoot, "project");
const verifier = path.join(workspaceRoot, "scripts", "verify-novel-chapter.ts");

async function verify(expectedStatus: number, extraArgs: string[] = []): Promise<void> {
	try {
		await run(process.execPath, ["--experimental-strip-types", verifier, "--project", projectRoot, "--chapter", "002", ...extraArgs]);
		assert.equal(expectedStatus, 0);
	} catch (error) {
		assert.equal((error as { code?: number }).code, expectedStatus);
	}
}

try {
	await cp(fixtureRoot, projectRoot, { recursive: true });
	await verify(0);
	let report = await readFile(path.join(projectRoot, "planning", "verifications", "002-verification.md"), "utf8");
	assert.match(report, /verification_status: PASS/);
	await verify(0, ["--scene", "paper-trace"]);
	await verify(1, ["--scene", "unknown-scene"]);
	report = await readFile(path.join(projectRoot, "planning", "verifications", "002-verification.md"), "utf8");
	assert.match(report, /SCENE_UNKNOWN/);

	const draftPath = path.join(projectRoot, "drafts", "candidates", "chapters", "002.md");
	const draft = await readFile(draftPath, "utf8");
	await writeFile(draftPath, draft + "\n顾行\n", "utf8");
	await verify(1);
	report = await readFile(path.join(projectRoot, "planning", "verifications", "002-verification.md"), "utf8");
	assert.match(report, /verification_status: FAIL/);
	assert.match(report, /PROHIBITED_CHARACTER/);
	assert.match(report, /顾行/);
	await writeFile(draftPath, draft, "utf8");
	await verify(0);
	report = await readFile(path.join(projectRoot, "planning", "verifications", "002-verification.md"), "utf8");
	assert.match(report, /verification_status: PASS/);

	await writeFile(draftPath, draft + "\n绿色记录册已经启用\n", "utf8");
	await verify(1);
	report = await readFile(path.join(projectRoot, "planning", "verifications", "002-verification.md"), "utf8");
	assert.match(report, /FORBIDDEN_REVEAL/);
	await writeFile(draftPath, draft, "utf8");

	const cardPath = path.join(projectRoot, "planning", "chapter-cards", "002.md");
	const card = await readFile(cardPath, "utf8");
	await writeFile(cardPath, card.replace("target_chars: 700", "target_chars: 701"), "utf8");
	await verify(1);
	report = await readFile(path.join(projectRoot, "planning", "verifications", "002-verification.md"), "utf8");
	assert.match(report, /Architecture\/card mismatch for target_chars/);
	await writeFile(cardPath, card, "utf8");

	const architecturePath = path.join(projectRoot, "planning", "chapter-architecture.md");
	const architecture = await readFile(architecturePath, "utf8");
	await writeFile(architecturePath, architecture.replace(/\n  - chapter: "002"[\s\S]*?(?=\n  - chapter:|\n```)/, ""), "utf8");
	await verify(1);
	report = await readFile(path.join(projectRoot, "planning", "verifications", "002-verification.md"), "utf8");
	assert.match(report, /not registered in chapter architecture/);
	await writeFile(architecturePath, architecture, "utf8");

	const configuredCandidatePath = "drafts/candidates/chapters/002.md";
	const staleCandidatePath = "drafts/chapters/002.md";
	await writeFile(cardPath, card.replace(configuredCandidatePath, staleCandidatePath), "utf8");
	await writeFile(architecturePath, architecture.replace(configuredCandidatePath, staleCandidatePath), "utf8");
	await verify(1);
	report = await readFile(path.join(projectRoot, "planning", "verifications", "002-verification.md"), "utf8");
	assert.match(report, /Chapter file path mismatch/);
	await writeFile(cardPath, card, "utf8");
	await writeFile(architecturePath, architecture, "utf8");

	await writeFile(draftPath, draft + "\n- 这不是正文\n", "utf8");
	await verify(1);
	report = await readFile(path.join(projectRoot, "planning", "verifications", "002-verification.md"), "utf8");
	assert.match(report, /MARKDOWN_LIST/);
	await writeFile(draftPath, draft, "utf8");

	await writeFile(cardPath, card.replace("min_substantial: 4", "min_substantial: 100"), "utf8");
	await verify(0);
	report = await readFile(path.join(projectRoot, "planning", "verifications", "002-verification.md"), "utf8");
	assert.match(report, /verification_status: PASS_WITH_WARNINGS/);
	await writeFile(cardPath, card, "utf8");
	console.log("Novel verifier smoke passed");
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
