import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { closeLoopbackServer, isFetchCompatiblePort, listenForFetch, MAX_LOOPBACK_BIND_ATTEMPTS } from "../support/loopback-http.js";
import type { RunCase } from "./testkit.js";

class AllocatorServer extends EventEmitter {
	bindings: Array<{ port: number; host: string }> = [];
	closes = 0;
	constructor(private ports: number[], private failure?: Error) { super(); }
	listen(port: number, host: string, ready: () => void) {
		this.bindings.push({ port, host });
		queueMicrotask(() => this.failure ? this.emit("error", this.failure) : ready());
		return this;
	}
	address() { return { address: "127.0.0.1", family: "IPv4", port: this.ports[Math.min(this.bindings.length - 1, this.ports.length - 1)] }; }
	close(callback: (error?: Error) => void) { this.closes++; queueMicrotask(callback); return this; }
}

export async function runLoopbackHttpCases(runCase: RunCase): Promise<void> {
	await runCase("NET-LOOPBACK fetch-restricted ports are rejected before provider dispatch", record => {
		const blocked = [1, 22, 443.5, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080, 0, -1, 65536, NaN, Infinity];
		assert.ok(blocked.every(port => !isFetchCompatiblePort(port)));
		assert.ok([80, 443, 1024, 1420, 8080, 15000, 49152, 55137, 65535].every(isFetchCompatiblePort));
		record("loopback.port_policy", { restrictedAndInvalid: blocked.length, loopbackBypass: false });
	});
	await runCase("NET-LOOPBACK restricted allocations are released before selecting a safe address", async record => {
		const server = new AllocatorServer([6000, 6665, 6666, 6667, 6668, 6669, 55137]);
		const result = await listenForFetch(server);
		assert.equal(result.origin, "http://127.0.0.1:55137");
		assert.deepEqual(result.skippedPorts, [6000, 6665, 6666, 6667, 6668, 6669]);
		assert.equal(server.closes, 6);
		assert.deepEqual(server.bindings, Array.from({ length: 7 }, () => ({ port: 0, host: "127.0.0.1" })));
		assert.equal(server.listenerCount("error"), 0);
		await closeLoopbackServer(server); assert.equal(server.closes, 7);
		record("loopback.reselected", { released: 6, providerRetries: 0 });
	});
	await runCase("NET-LOOPBACK repeated restricted allocation is bounded and binding errors stay errors", async record => {
		const blocked = new AllocatorServer([6667]);
		await assert.rejects(listenForFetch(blocked), /LOOPBACK_FETCH_PORT_UNAVAILABLE/);
		assert.equal(blocked.bindings.length, MAX_LOOPBACK_BIND_ATTEMPTS);
		assert.equal(blocked.closes, MAX_LOOPBACK_BIND_ATTEMPTS);
		assert.equal(blocked.listenerCount("error"), 0);
		const failure = Object.assign(new Error("synthetic bind failure"), { code: "EADDRINUSE" });
		const broken = new AllocatorServer([], failure);
		await assert.rejects(listenForFetch(broken), error => error === failure);
		assert.equal(broken.bindings.length, 1); assert.equal(broken.closes, 0); assert.equal(broken.listenerCount("error"), 0);
		record("loopback.bounded", { maxBindings: MAX_LOOPBACK_BIND_ATTEMPTS, bindErrorRetried: false });
	});
	await runCase("NET-LOOPBACK actual fetch reaches the selected owned server exactly once", async record => {
		let requests = 0;
		const server = http.createServer((request, response) => { requests++; request.resume(); request.on("end", () => { response.writeHead(400); response.end("synthetic-loopback"); }); });
		const { origin, port } = await listenForFetch(server);
		try {
			assert.ok(isFetchCompatiblePort(port));
			const response = await fetch(origin, { method: "POST", body: "synthetic", redirect: "error", signal: AbortSignal.timeout(5_000) });
			assert.equal(response.status, 400); assert.equal(await response.text(), "synthetic-loopback");
			assert.equal(requests, 1);
			record("loopback.actual_fetch", { httpRequests: requests, realModelCalls: 0 });
		} finally { await closeLoopbackServer(server); }
	});
}
