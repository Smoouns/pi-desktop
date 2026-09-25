import { rawUsage } from "./journal.js";

/** Matches pinned Pi 0.63.1's OpenAI-completions normalization, not verified
 * provider billing semantics. Keep raw field presence separate from SDK zeroes.
 * A present malformed reasoning count fails closed instead of becoming zero. */
export function outputAccounting(usage: any) {
	const raw = rawUsage(usage);
	const details = usage?.completion_tokens_details;
	const reasoningFieldPresent = details !== null && typeof details === "object" && Object.hasOwn(details, "reasoning_tokens");
	const reasoning = details?.reasoning_tokens;
	const reasoningTokens = Number.isSafeInteger(reasoning) && reasoning >= 0 ? reasoning : null;
	const sum = raw.output === null || reasoningFieldPresent && reasoningTokens === null ? null : raw.output + (reasoningTokens ?? 0);
	const sdkNormalizedOutput = sum !== null && Number.isSafeInteger(sum) ? sum : null;
	// Positive reasoning may already be included in completion by the upstream.
	// Without a verified billing convention, do not silently price either sum.
	const referenceOutput = !reasoningFieldPresent || reasoningTokens === 0 ? raw.output : null;
	const referenceCostUsd = raw.input !== null && referenceOutput !== null && raw.cacheRead !== null && raw.cacheRead <= raw.input
		? ((raw.input - raw.cacheRead) * 0.75 + raw.cacheRead * 0.075 + referenceOutput * 3.75) / 1_000_000 : null;
	return { reasoningFieldPresent, reasoningTokens, sdkNormalizedOutput, referenceCostUsd,
		outputAccountingBasis: "pi-0.63.1/openai-completions:completion+reasoning", providerBillingVerified: false as const };
}
