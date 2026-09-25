// Trusted offline harness defense in depth, not a hostile-code OS sandbox.
// This is imported before any SDK/module code in a credential-free worker.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";
import dns from "node:dns";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const origin = new URL(process.env.PI_E8_ORIGIN);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port) throw Error("E8_NOT_LOOPBACK");
const state = { denied: 0, fetches: 0, active: true };
globalThis[Symbol.for("pi.e8.networkGuard")] = state;
const deny = () => { state.denied++; throw Error("E8_EXTERNAL_OR_SUBPROCESS_DENIED"); };
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.origin !== origin.origin || !/^\/worker-[a-z0-9-]+\/v1\/chat\/completions$/.test(url.pathname)) return deny();
	state.fetches++;
	return fetch(input, { ...init, redirect: "error" });
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const values = Array.isArray(args[0]) ? args[0] : args;
	const options = typeof values[0] === "object" ? values[0] : { port: values[0], host: values[1] };
	if (options.path || options.host !== "127.0.0.1" || Number(options.port) !== Number(origin.port)) return deny();
	return connect.apply(this, args);
};
net.Server.prototype.listen = tls.connect = http.request = http.get = https.request = https.get = http2.connect = dgram.createSocket = deny;
globalThis.WebSocket = deny;
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "reverse"]) { dns[name] = deny; dns.promises[name] = deny; }
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = deny;
syncBuiltinESMExports();
