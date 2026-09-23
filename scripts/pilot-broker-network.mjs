/** Trusted-code containment, not an OS sandbox. Only the broker's pinned HTTPS
 * or loopback-only HTTP adapter can enter the network scope. No redirects,
 * proxy auto-discovery or destination fallback. */
import { AsyncLocalStorage } from "node:async_hooks";
import https from "node:https";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import { PassThrough, Readable } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

const scope = new AsyncLocalStorage();
const requestHttps = https.request.bind(https);
const requestHttp = http.request.bind(http);
const deny = () => { throw new Error("PILOT_DIRECT_NETWORK_DENIED"); };
for (const [object, names] of [[net, ["connect", "createConnection"]], [net.Socket.prototype, ["connect"]], [tls, ["connect"]],
	[dns, ["lookup", "resolve", "resolve4", "resolve6", "reverse"]], [dns.promises, ["lookup", "resolve", "resolve4", "resolve6", "reverse"]]]) {
	for (const name of names) { const original = object[name]; object[name] = function (...args) { if (scope.getStore() !== true) return deny(); return original.apply(this, args); }; }
}
http.request = http.get = https.request = https.get = http2.connect = dgram.createSocket = deny;
net.Server.prototype.listen = deny;
globalThis.fetch = deny;
globalThis.WebSocket = deny;
syncBuiltinESMExports();

export function createPinnedFetch(endpoint, credential) {
	let target;
	try { target = new URL(endpoint); } catch { throw new Error("PILOT_HTTPS_CONFIG"); }
	// Keep this raw-host contract aligned with evals/pilot/model.ts. A parsed
	// hostname alone accepts alternate numeric spellings such as 127.1.
	const localHttp = typeof endpoint === "string" && target.protocol === "http:"
		&& /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(endpoint)
		&& !/[\u0000-\u0020\u007f\\]/.test(endpoint)
		&& ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
	if ((!localHttp && target.protocol !== "https:") || target.username || target.password || target.search || target.hash
		|| typeof credential !== "string" || !credential || credential.length > 8192 || /[\r\n\0]/.test(credential)) throw new Error("PILOT_HTTPS_CONFIG");
	const requestPinned = localHttp ? requestHttp : requestHttps;
	// Do not trust hosts/DNS to keep a localhost HTTP credential on this machine.
	// IPv6-only local services must use the explicit [::1] endpoint; no fallback.
	const lookup = localHttp && target.hostname === "localhost" ? (_hostname, options, callback) => {
		if (typeof options === "function") { callback = options; options = {}; }
		if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
		else callback(null, "127.0.0.1", 4);
	} : undefined;
	return async (input, init) => {
		if (String(input) !== target.href || init?.method !== "POST" || init.redirect !== "error" || typeof init.body !== "string") throw new Error("PILOT_HTTPS_REQUEST");
		return scope.run(true, () => new Promise((resolve, reject) => {
			const request = requestPinned(target, { method: "POST", agent: false, signal: init.signal, ...(lookup ? { lookup } : {}), headers: {
				"content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${credential}`,
				"content-length": Buffer.byteLength(init.body),
			} }, (response) => {
				const status = response.statusCode ?? 502;
				// A streaming chat response must be 200; 204/205 cannot carry a Response body.
				if (status !== 200) {
					response.destroy(); request.destroy(); reject(new Error("PILOT_HTTPS_STATUS")); return;
				}
				const relay = new PassThrough();
				response.once("aborted", () => relay.destroy(new Error("PILOT_HTTPS_STREAM_FAILED")));
				response.once("error", () => relay.destroy(new Error("PILOT_HTTPS_STREAM_FAILED")));
				relay.once("close", () => { if (!response.complete) { response.destroy(); request.destroy(); } });
				response.pipe(relay);
				resolve(new Response(Readable.toWeb(relay), { status, headers: { "content-type": String(response.headers["content-type"] ?? "") } }));
			});
			request.on("error", () => reject(new Error("PILOT_HTTPS_FAILED")));
			request.end(init.body);
		}));
	};
}
