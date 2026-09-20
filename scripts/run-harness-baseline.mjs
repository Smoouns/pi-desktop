import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const outputDirectory = path.resolve("artifacts/harness");
await mkdir(outputDirectory, { recursive: true });

for (const [name, args] of [["b0-raw", []], ["b0-fixed", ["--current"]]]) {
	const { stdout } = await exec(process.execPath, ["--experimental-strip-types", "tests/harness/contracts-b0-probe.ts", ...args], { cwd: path.resolve(".") });
	const result = JSON.parse(stdout);
	assert.equal(result.parserRejectedRealManifest, name === "b0-raw");
	assert.equal(result.malformedMetadataAllowedWrite, name === "b0-raw");
	if (result.symlinkSupported) assert.equal(result.symlinkReadOutsideSentinel, name === "b0-raw");
	await writeFile(path.join(outputDirectory, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
	console.log(`${name}: ${JSON.stringify(result)}`);
}
