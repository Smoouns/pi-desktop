import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { PassThrough } from "node:stream";

const HTTPS_ENDPOINT = "https://pilot.invalid/v1/chat/completions";
const CREDENTIAL = "synthetic-broker-key";

export async function runPilotBrokerNetworkTests() {
	let count = 0;
	let scenario = { kind: "ok", status: 200, chunks: ["data: one\n\n", "data: [DONE]\n\n"] };
	let latest;
	const routes = { http: 0, https: 0 };
	const fakeRequest = (protocol) => (target, options, callback) => {
		routes[protocol] += 1;
		const request = new EventEmitter();
		const response = new PassThrough();
		response.statusCode = scenario.status;
		response.headers = { "content-type": "text/event-stream", "x-private": "must-not-forward" };
		response.complete = false;
		const originalResponseDestroy = response.destroy.bind(response);
		const record = latest = { protocol, target: String(target), options, body: null, requestDestroyed: false, responseDestroyed: false, response };
		request.destroy = () => { record.requestDestroyed = true; };
		response.destroy = (...args) => { record.responseDestroyed = true; return originalResponseDestroy(...args); };
		request.end = (body) => {
			record.body = body;
			callback(response);
			queueMicrotask(() => {
				if (scenario.kind === "ok") {
					for (const chunk of scenario.chunks) response.write(chunk);
					response.complete = true; response.end();
				} else if (scenario.kind === "stream-error") response.emit("error", new Error("private upstream error"));
				else if (scenario.kind === "aborted") response.emit("aborted");
				else if (scenario.kind === "cancel") response.write("data: partial\n\n");
			});
		};
		return request;
	};
	http.request = fakeRequest("http");
	https.request = fakeRequest("https");
	const { createPinnedFetch } = await import(`../../scripts/pilot-broker-network.mjs?test=${Date.now()}`);
	const pinnedFetch = createPinnedFetch(HTTPS_ENDPOINT, CREDENTIAL);

	const response = await pinnedFetch(HTTPS_ENDPOINT, { method: "POST", redirect: "error", body: "{}" });
	assert.equal(await response.text(), "data: one\n\ndata: [DONE]\n\n");
	assert.equal(latest.protocol, "https"); assert.equal(latest.target, HTTPS_ENDPOINT);
	assert.deepEqual({ method: latest.options.method, agent: latest.options.agent }, { method: "POST", agent: false });
	assert.deepEqual(Object.keys(latest.options.headers).sort(), ["accept", "authorization", "content-length", "content-type"]);
	assert.equal(latest.options.headers.authorization, `Bearer ${CREDENTIAL}`);
	assert.equal(latest.options.headers["content-length"], 2);
	count += 7;

	for (const endpoint of ["http://localhost:8123/v1/chat/completions", "http://127.0.0.1:8123/v1/chat/completions", "http://[::1]:8123/v1/chat/completions"]) {
		const before = { ...routes }, localFetch = createPinnedFetch(endpoint, CREDENTIAL);
		const localResponse = await localFetch(endpoint, { method: "POST", redirect: "error", body: "{}" }); await localResponse.text();
		assert.equal(routes.http, before.http + 1); assert.equal(routes.https, before.https); assert.equal(latest.protocol, "http");
		if (new URL(endpoint).hostname === "localhost") {
			assert.equal(typeof latest.options.lookup, "function");
			const resolved = await new Promise((resolve, reject) => latest.options.lookup("localhost", {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
			assert.deepEqual(resolved, { address: "127.0.0.1", family: 4 });
			count += 2;
		}
		count += 3;
	}

	const localFetch = createPinnedFetch("http://localhost:8123/v1/chat/completions", CREDENTIAL);
	for (const drift of ["http://localhost:8124/v1/chat/completions", "http://127.0.0.1:8123/v1/chat/completions", "http://localhost:8123/v1/other", "https://localhost:8123/v1/chat/completions"]) {
		const before = { ...routes };
		await assert.rejects(() => localFetch(drift, { method: "POST", redirect: "error", body: "{}" }), /PILOT_HTTPS_REQUEST/);
		assert.deepEqual(routes, before);
		count += 2;
	}
	for (const endpoint of ["http://example.com/v1", "http://10.0.0.1/v1", "http://192.168.1.8/v1", "http://127.0.0.2/v1", "http://localhost.evil/v1",
		"http://evil-localhost/v1", "http://127.1:8123/v1", "http://2130706433:8123/v1", "http://0177.0.0.1:8123/v1", "http://0x7f000001:8123/v1",
		"http://%6cocalhost:8123/v1", "http:\\localhost:8123/v1", "http://localhost:8123\\@evil.invalid/v1", "http://evil.invalid\\@localhost:8123/v1",
		"http://user:pass@localhost:8123/v1", "http://localhost:8123/v1?q=1", "http://localhost:8123/v1#fragment", "ftp://localhost:8123/v1"]) {
		assert.throws(() => createPinnedFetch(endpoint, CREDENTIAL), /PILOT_HTTPS_CONFIG/); count += 1;
	}
	assert.throws(() => createPinnedFetch("http://localhost:8123/v1", "bad\r\ncredential"), /PILOT_HTTPS_CONFIG/);
	assert.throws(() => createPinnedFetch("http://localhost:8123/v1", ""), /PILOT_HTTPS_CONFIG/);
	count += 2;

	await assert.rejects(() => pinnedFetch("https://other.invalid/v1/chat/completions", { method: "POST", redirect: "error", body: "{}" }), /PILOT_HTTPS_REQUEST/);
	await assert.rejects(() => pinnedFetch(HTTPS_ENDPOINT, { method: "GET", redirect: "error", body: "{}" }), /PILOT_HTTPS_REQUEST/);
	await assert.rejects(() => pinnedFetch(HTTPS_ENDPOINT, { method: "POST", redirect: "follow", body: "{}" }), /PILOT_HTTPS_REQUEST/);
	count += 3;

	scenario = { kind: "status", status: 302, chunks: [] };
	await assert.rejects(() => pinnedFetch(HTTPS_ENDPOINT, { method: "POST", redirect: "error", body: "{}" }), /PILOT_HTTPS_STATUS/);
	assert.equal(latest.responseDestroyed, true); assert.equal(latest.requestDestroyed, true);
	count += 3;
	scenario = { kind: "status", status: 204, chunks: [] };
	await assert.rejects(() => pinnedFetch(HTTPS_ENDPOINT, { method: "POST", redirect: "error", body: "{}" }), /PILOT_HTTPS_STATUS/);
	count += 1;

	for (const kind of ["stream-error", "aborted"]) {
		scenario = { kind, status: 200, chunks: [] };
		const failed = await pinnedFetch(HTTPS_ENDPOINT, { method: "POST", redirect: "error", body: "{}" });
		await assert.rejects(() => failed.text(), (error) => !(String(error) + String(error?.cause ?? "")).includes("private upstream error"));
		count += 1;
	}
	scenario = { kind: "cancel", status: 200, chunks: [] };
	const cancellable = await pinnedFetch(HTTPS_ENDPOINT, { method: "POST", redirect: "error", body: "{}" });
	const reader = cancellable.body.getReader(); await reader.read(); await reader.cancel(); await new Promise((resolve) => setImmediate(resolve));
	assert.equal(latest.responseDestroyed, true); assert.equal(latest.requestDestroyed, true);
	count += 2;

	assert.throws(() => globalThis.fetch(HTTPS_ENDPOINT), /PILOT_DIRECT_NETWORK_DENIED/);
	assert.throws(() => net.connect({ host: "127.0.0.1", port: 9 }), /PILOT_DIRECT_NETWORK_DENIED/);
	assert.throws(() => http.get("http://localhost:8123"), /PILOT_DIRECT_NETWORK_DENIED/);
	assert.throws(() => https.get(HTTPS_ENDPOINT), /PILOT_DIRECT_NETWORK_DENIED/);
	count += 4;
	return count;
}
