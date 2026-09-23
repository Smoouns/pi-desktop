import assert from "node:assert/strict";
import { runReadDeliveryCases } from "./read-delivery.js";
import { runReadDeliveryExtensionCases } from "./read-delivery-extension.js";
import { runReviewRepros } from "./review-repros.js";
import { runCheckpointRuntimeCases } from "./checkpoint-runtime.js";
import { runCheckpointStoreCases } from "./checkpoint-store.js";
import { fixtureRoot, treeManifest, type RunCase } from "./testkit.js";

const before = await treeManifest(fixtureRoot);
let cases = 0, failures = 0;
const runCase: RunCase = async (id, body) => {
	try {
		await body(() => undefined);
		assert.deepEqual(await treeManifest(fixtureRoot), before);
		console.log(`PASS ${id}`);
	} catch (error) { failures++; console.error(`FAIL ${id}`, error); }
	cases++;
};
await runReadDeliveryCases(runCase);
await runCheckpointRuntimeCases(runCase);
await runCheckpointStoreCases(runCase);
await runReviewRepros(runCase);
await runReadDeliveryExtensionCases(runCase);
console.log(`Read delivery: ${cases} cases; failures=${failures}; modelCalls=0`);
assert.equal(failures, 0);
