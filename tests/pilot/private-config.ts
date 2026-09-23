import assert from "node:assert/strict";
import { resolvePilotPrivateConfig } from "../../evals/pilot/private-config.js";
import { PILOT_MODEL } from "../../evals/pilot/policy.js";

export function runPrivateConfigTests(): number {
	let count = 0;
	const config = (key: unknown, baseUrl = "https://pilot.invalid/v1") => ({ providers: { [PILOT_MODEL.provider]: { api: PILOT_MODEL.api, baseUrl, apiKey: key,
		models: [{ id: PILOT_MODEL.id, contextWindow: PILOT_MODEL.contextWindow, maxTokens: 16_384 }] } } });
	assert.equal(resolvePilotPrivateConfig(config("PILOT_TEST_KEY"), {}, false).credential, null);
	count += 1;
	assert.throws(() => resolvePilotPrivateConfig(config("!echo forbidden"), {}, false), /PILOT_CREDENTIAL_UNSUPPORTED/);
	count += 1;
	assert.throws(() => resolvePilotPrivateConfig(config("PILOT_TEST_KEY"), {}, true), /PILOT_CREDENTIAL_UNAVAILABLE/);
	count += 1;
	const resolved = resolvePilotPrivateConfig(config("PILOT_TEST_KEY"), { PILOT_TEST_KEY: "private-canary" }, true);
	assert.equal(resolved.credential, "private-canary");
	count += 1;
	assert.doesNotMatch(JSON.stringify(resolved.publicModel), /private-canary|PILOT_TEST_KEY|baseUrl/);
	count += 1;
	const literal = resolvePilotPrivateConfig(config("literal-canary"), {}, true);
	assert.equal(literal.credential, "literal-canary");
	assert.doesNotMatch(JSON.stringify({ publicModel: literal.publicModel, configSha256: literal.configSha256, endpointSha256: literal.endpointSha256 }), /literal-canary|apiKey|credential/);
	count += 2;
	const otherLiteral = resolvePilotPrivateConfig(config("different-literal"), {}, true);
	assert.equal(literal.configSha256, otherLiteral.configSha256);
	count += 1;
	assert.throws(() => resolvePilotPrivateConfig(config("PILOT_TEST_KEY"), { PILOT_TEST_KEY: "bad\r\nheader" }, true), /PILOT_CREDENTIAL_UNAVAILABLE/);
	assert.throws(() => resolvePilotPrivateConfig(config("literal\nheader"), {}, true), /PILOT_CREDENTIAL_UNAVAILABLE/);
	count += 2;
	const loopbacks = ["http://localhost:8080/v1", "http://127.0.0.1:8081/proxy/v1", "http://[::1]:8082/v1"];
	for (const baseUrl of loopbacks) {
		const loopback = resolvePilotPrivateConfig(config("literal", baseUrl), {}, false);
		assert.equal(loopback.credential, null);
		assert.match(loopback.endpoint, /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\//);
	}
	assert.notEqual(resolvePilotPrivateConfig(config("literal", loopbacks[0]), {}, false).endpointSha256,
		resolvePilotPrivateConfig(config("literal", "http://localhost:8081/v1"), {}, false).endpointSha256);
	assert.notEqual(resolvePilotPrivateConfig(config("literal", loopbacks[0]), {}, false).configSha256,
		resolvePilotPrivateConfig(config("literal", "http://localhost:8080/other"), {}, false).configSha256);
	count += 5;
	for (const rejected of [
		"http://example.com/v1", "http://192.168.1.10/v1", "http://0.0.0.0:8080/v1", "http://localhost.example.com/v1",
		"http://localhost@evil.example/v1", "http://user:pass@localhost:8080/v1", "http://localhost:8080/v1?key=value",
		"http://localhost:8080/v1#fragment", "ftp://localhost:8080/v1", "ws://localhost:8080/v1",
	]) assert.throws(() => resolvePilotPrivateConfig(config("literal", rejected), {}, false), /PILOT_(?:ENDPOINT_PROTOCOL|MODEL_INVALID)/);
	count += 10;
	for (const rawAuthorityBypass of [
		"http://127.1:8080/v1", "http://2130706433:8080/v1", "http://0177.0.0.1:8080/v1", "http://0x7f000001:8080/v1",
		"http://%6cocalhost:8080/v1", String.raw`http://localhost\@evil.example/v1`, String.raw`http://localhost:8080\evil/v1`,
	]) assert.throws(() => resolvePilotPrivateConfig(config("literal", rawAuthorityBypass), {}, false), /PILOT_MODEL_INVALID/);
	count += 7;
	assert.throws(() => resolvePilotPrivateConfig(config(undefined), {}, false), /PILOT_CREDENTIAL_UNSUPPORTED/);
	assert.throws(() => resolvePilotPrivateConfig(config(""), {}, false), /PILOT_CREDENTIAL_UNSUPPORTED/);
	count += 2;
	const headerBase = config("literal");
	const withHeaders = { providers: { ...headerBase.providers, [PILOT_MODEL.provider]: { ...headerBase.providers[PILOT_MODEL.provider], headers: { authorization: "private-canary" } } } };
	assert.throws(() => resolvePilotPrivateConfig(withHeaders, {}, false), /PILOT_MODEL_INVALID/);
	count += 1;
	return count;
}
