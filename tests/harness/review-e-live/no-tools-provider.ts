import assert from "node:assert/strict";
import { digest } from "./journal.js";

/** Test-worker-local decoration of the existing pinned provider, before the
 * production meter wraps it. Keeps the native stream, response parser, summary
 * algorithm, registry identity and sourceId; never installs a replacement SDK.
 * Native summaries skip before_provider_request, but share this onPayload path.
 * Adding the field here precedes BOTH ordinary audits and final-body metering. */
export function installNoToolsPayloadPolicy(provider: any, phase: () => string, record: (value: any) => void) {
	assert.equal(provider?.api, "openai-completions", "E8_NO_TOOLS_API_UNSUPPORTED");
	const wrap = (delegate: (...args: any[]) => any) => {
		assert.equal(typeof delegate, "function");
		return function (this: any, model: any, context: any, options: any) {
			assert.equal(model.api, provider.api);
			assert.ok(context.tools === undefined || Array.isArray(context.tools) && context.tools.length === 0, "E8_NO_TOOLS_CONTEXT_REQUIRED");
			assert.equal(options?.toolChoice, undefined, "E8_NO_TOOLS_CHOICE_ALREADY_SET");
			const requestPhase = phase();
			const onPayload = async (payload: any, payloadModel: any) => {
				assert.ok(payload.tools === undefined || Array.isArray(payload.tools) && payload.tools.length === 0, "E8_NO_TOOLS_PAYLOAD_REQUIRED");
				assert.equal(payload.tool_choice, undefined, "E8_NO_TOOLS_CHOICE_ALREADY_SET");
				const before = JSON.stringify(payload), adjusted = { ...payload, tool_choice: "none" };
				const after = JSON.stringify(adjusted);
				const final = await options?.onPayload?.(adjusted, payloadModel) ?? adjusted;
				// This test profile permits only this single field change. An ordinary
				// hook changing anything else must fail before the SDK can dispatch.
				assert.equal(JSON.stringify(final), after, "E8_NO_TOOLS_PAYLOAD_DRIFT");
				record({ phase: requestPhase, boundary: "native-provider-onPayload", beforeSha256: digest(before), afterSha256: digest(after), onlyAdded: "tool_choice:none" });
				return final;
			};
			return delegate.call(this, model, context, { ...options, onPayload });
		};
	};
	provider.stream = wrap(provider.stream);
	provider.streamSimple = wrap(provider.streamSimple);
}
