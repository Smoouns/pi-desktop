// Defense in depth for trusted offline eval code, not an OS security sandbox.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";
import dns from "node:dns";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const state = { attempts: 0, active: true };
globalThis[Symbol.for("pi.eval.networkGuard")] = state;
const denied = () => { state.attempts++; throw new Error("OFFLINE_NETWORK_DENIED"); };
globalThis.fetch = denied;
globalThis.WebSocket = denied;
net.connect = net.createConnection = net.Socket.prototype.connect = denied;
net.Server.prototype.listen = denied;
tls.connect = denied;
http.request = http.get = https.request = https.get = denied;
http2.connect = denied;
dgram.createSocket = denied;
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "reverse"]) {
	dns[name] = denied;
	dns.promises[name] = denied;
}
if (process.env.PI_EVAL_WORKER === "1") {
	const noChild = () => { state.attempts++; throw new Error("OFFLINE_SUBPROCESS_DENIED"); };
	for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = noChild;
}
syncBuiltinESMExports();
