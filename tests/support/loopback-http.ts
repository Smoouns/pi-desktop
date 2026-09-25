import type { AddressInfo } from "node:net";

// Fetch's bad-port policy still applies to loopback. On Windows, listen(0)
// may allocate from a low dynamic range (for example 1024-15000). Keep the
// Node 24 / Undici policy here instead of changing the host range or bypassing
// fetch security. SDK upgrades must retain the actual loopback smoke tests.
const fetchBlockedPorts = new Set([
	1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
	87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
	139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
	540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
	2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
	6679, 6697, 10080,
]);

export const MAX_LOOPBACK_BIND_ATTEMPTS = 32;
export const isFetchCompatiblePort = (port: number): boolean =>
	Number.isInteger(port) && port >= 1 && port <= 65535 && !fetchBlockedPorts.has(port);

// A structural interface lets deterministic tests supply allocator outcomes;
// the actual SDK tests pass the real node:http Server, unchanged.
export interface LoopbackTestServer {
	once(event: "error", listener: (error: Error) => void): unknown;
	off(event: "error", listener: (error: Error) => void): unknown;
	listen(port: number, host: string, listener: () => void): unknown;
	address(): AddressInfo | string | null;
	close(callback: (error?: Error) => void): unknown;
}

export const closeLoopbackServer = (server: LoopbackTestServer): Promise<void> =>
	new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

/** Select a fetch-compatible address before invoking any provider. This only
 * retries empty server bindings; it never retries or forgives a failed request.
 */
export async function listenForFetch(server: LoopbackTestServer): Promise<{ origin: string; port: number; skippedPorts: number[] }> {
	const skippedPorts: number[] = [];
	for (let attempt = 0; attempt < MAX_LOOPBACK_BIND_ATTEMPTS; attempt++) {
		await new Promise<void>((resolve, reject) => {
			const fail = (error: Error) => { server.off("error", fail); reject(error); };
			server.once("error", fail);
			try { server.listen(0, "127.0.0.1", () => { server.off("error", fail); resolve(); }); }
			catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
		});
		const address = server.address();
		if (!address || typeof address !== "object" || address.address !== "127.0.0.1") {
			await closeLoopbackServer(server);
			throw new Error("LOOPBACK_ADDRESS_INVALID");
		}
		if (isFetchCompatiblePort(address.port)) return { port: address.port, origin: `http://127.0.0.1:${address.port}`, skippedPorts };
		skippedPorts.push(address.port);
		await closeLoopbackServer(server);
	}
	throw new Error(`LOOPBACK_FETCH_PORT_UNAVAILABLE after ${MAX_LOOPBACK_BIND_ATTEMPTS} empty bindings: ${skippedPorts.join(",")}`);
}
