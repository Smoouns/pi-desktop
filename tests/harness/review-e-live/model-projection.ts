import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { streamSimple } from "@mariozechner/pi-ai";
import { projectPilotModel } from "../../../evals/pilot/model.js";
import { digest } from "./journal.js";

export const SENTINEL = "http://127.0.0.1:14299/v1";
export function projectConfig(config: any) {
	// Reuse the frozen pure projection, not its live runner or old allowance.
	// Its fixed model/output/window match E8. Unsupported config fails closed.
	try {
		const { publicModel, runtimeModel } = projectPilotModel(config);
		const provider = config.providers[publicModel.provider];
		const model = provider.models.find((m: any) => m.id === publicModel.id);
		const reference = provider.apiKey;
		assert.ok(typeof reference === "string" && /^[A-Z][A-Z0-9_]*$/.test(reference));
		assert.ok(!/^(NODE_|PI_|GIT_|NPM_|PATH$|SYSTEMROOT$|COMSPEC$|PATHEXT$|TEMP$|TMP$|WINDIR$)/.test(reference));
		const endpoint = runtimeModel.baseUrl!.replace(/\/$/, "") + "/chat/completions";
		const endpointSha256 = digest(endpoint), credentialReferenceSha256 = digest(reference);
		const publicProjection = { ...publicModel, configuredMaxTokens: model.maxTokens, thinkingLevel: "off", credentialKind: "environment-reference",
			endpointSha256, credentialReferenceSha256, compat: runtimeModel.compat };
		return { publicProjection, configSha256: digest(JSON.stringify(publicProjection)), endpoint, reference,
			workerModel: { ...runtimeModel, baseUrl: SENTINEL },
			// Probe the original private URL/defaults without ever sending to it.
			nativeModel: { ...runtimeModel, compat: model.compat ?? undefined } };
	} catch { throw Error("E8_MODEL_CONFIG_REJECTED"); }
}
export function loadConfig(file: string) {
	try { const bytes = readFileSync(file); assert.ok(bytes.length <= 1024 * 1024); return projectConfig(JSON.parse(bytes.toString("utf8"))); }
	catch { throw Error("E8_MODEL_CONFIG_REJECTED"); }
}
export function resolveCredential(projection: ReturnType<typeof projectConfig>, environment: Record<string, string | undefined>) {
	const key = environment[projection.reference];
	if (!key || key.length > 8192 || /[\r\n\0]/.test(key)) throw Error("E8_CREDENTIAL_UNAVAILABLE");
	return key;
}
export async function probeCompatibility(projection: ReturnType<typeof projectConfig>) {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const contexts: any[] = [
		{ systemPrompt: "Public serialisation probe.", messages: [{ role: "user", content: "Read only.", timestamp: 1 }] },
		{ systemPrompt: "Public tool probe.", messages: [
			{ role: "user", content: "Read the public source.", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "probe_call", name: "read", arguments: { path: "notes/e8-source.md" } }], api: "openai-completions", provider: projection.workerModel.provider, model: projection.workerModel.id, usage, stopReason: "toolUse", timestamp: 1 },
			{ role: "toolResult", toolCallId: "probe_call", toolName: "read", content: [{ type: "text", text: "public v1" }], isError: false, timestamp: 1 },
		], tools: [{ name: "read", description: "Public read-only probe", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] },
	];
	const capture = async (model: any, context: any, toolChoice?: "none") => {
		let captured: any;
		// toolChoice is read at runtime by this pinned provider's simple wrapper,
		// but is not exposed by the SDK's generic SimpleStreamOptions interface.
		const options = { apiKey: "E8_SYNTHETIC_NOT_A_CREDENTIAL", maxTokens: 2048, ...(toolChoice ? { toolChoice } : {}),
			onPayload: (payload: unknown) => { captured = structuredClone(payload); throw Error("E8_CAPTURE_BEFORE_NETWORK"); } };
		const result = await streamSimple(model, context, options).result();
		assert.ok(captured && result.stopReason === "error", "E8_SERIALIZER_PROBE_FAILED"); return captured;
	};
	const samples = [];
	for (const context of contexts) {
		const native = await capture(projection.nativeModel, context), mapped = await capture(projection.workerModel, context);
		assert.deepEqual(native, mapped, "E8_ENDPOINT_MAPPING_CHANGED_PAYLOAD");
		assert.equal(mapped[projection.publicProjection.outputField], 2048);
		samples.push({ payloadSha256: digest(JSON.stringify(mapped)), bytes: Buffer.byteLength(JSON.stringify(mapped)), outputField: projection.publicProjection.outputField });
	}
	const toolPolicyProbes = [];
	for (const variant of [
		{ id: "empty-tools", context: { ...contexts[0], tools: [] }, choice: undefined, toolsExpected: true },
		{ id: "omitted-tools", context: contexts[0], choice: undefined, toolsExpected: false },
		{ id: "omitted-with-tool-history", context: { ...contexts[1], tools: undefined }, choice: undefined, toolsExpected: true },
		{ id: "explicit-none", context: { ...contexts[0], tools: [] }, choice: "none" as const, toolsExpected: true },
	]) {
		const native = await capture(projection.nativeModel, variant.context, variant.choice), mapped = await capture(projection.workerModel, variant.context, variant.choice);
		assert.deepEqual(native, mapped, "E8_TOOL_POLICY_MAPPING_CHANGED_PAYLOAD");
		assert.equal(Object.hasOwn(mapped, "tools"), variant.toolsExpected);
		if (variant.toolsExpected) assert.deepEqual(mapped.tools, []);
		assert.equal(mapped.tool_choice, variant.choice);
		toolPolicyProbes.push({ id: variant.id, toolsFieldPresent: Object.hasOwn(mapped, "tools"), tools: mapped.tools ?? null,
			toolChoice: mapped.tool_choice ?? null, payloadSha256: digest(JSON.stringify(mapped)), bytes: Buffer.byteLength(JSON.stringify(mapped)) });
	}
	return { samples, toolPolicyProbes, endpointMappingEquivalent: true, networkRequests: 0, credentialResolved: false, providerAvailabilityVerified: false,
		toolPolicyAppliedToWorker: false, explicitNoneRemoteSupportVerified: false };
}
