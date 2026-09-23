import { projectPilotModel } from "./model.js";
import { PILOT_MODEL } from "./policy.js";
import { digest, sha256 } from "../core/io.js";

/** Pure, in-memory projection. Never execute Pi's !command credential resolver. */
export function resolvePilotPrivateConfig(config: unknown, environment: Record<string, string | undefined>, requireCredential: boolean) {
	const projection = projectPilotModel(config);
	const provider = (config as { providers: Record<string, { apiKey?: unknown }> }).providers[PILOT_MODEL.provider];
	const raw = provider.apiKey;
	if (typeof raw !== "string" || !raw.trim() || raw.length > 8192 || raw.startsWith("!")) throw new Error("PILOT_CREDENTIAL_UNSUPPORTED");
	let credential: string | null = null;
	if (requireCredential) {
		// Bare uppercase references must resolve; never send the variable name as a key.
		credential = environment[raw] ?? (/^[A-Z][A-Z0-9_]*$/.test(raw) ? null : raw);
		if (!credential || credential.length > 8192 || /[\r\n\0]/.test(credential)) throw new Error("PILOT_CREDENTIAL_UNAVAILABLE");
	}
	const endpoint = `${projection.runtimeModel.baseUrl.replace(/\/$/, "")}/chat/completions`;
	const target = new URL(endpoint);
	const localHttp = target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
	if (target.protocol !== "https:" && !localHttp) throw new Error("PILOT_ENDPOINT_PROTOCOL");
	return { ...projection, endpoint, credential,
		endpointSha256: sha256(endpoint),
		configSha256: digest({ model: projection.publicModel, endpointSha256: sha256(endpoint), credentialKind: /^[A-Z][A-Z0-9_]*$/.test(raw) ? "environment" : "literal" }),
	};
}
