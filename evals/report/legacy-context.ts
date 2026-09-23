import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { assertInside } from "../core/io.js";
import type { recover } from "../sdk-context-live/records.js";
import type { recover as recoverSupervision } from "../sdk-supervision-live/records.js";

/** Read-only legacy CLI in its original bundle. Never accept a caller-supplied
 * mode, code string, auth config, environment or worker entry point. */
async function recoverBundle(directory: string, family: "sdk-context-live" | "sdk-supervision-live"): Promise<unknown> {
  const work = process.env.PI_REPORT_WORK;
  assert.ok(work && process.env.PI_EVAL_WORKER === "1");
  const bundle = path.join(work, family + ".mjs");
  await assertInside(work, bundle);
  return new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(bundle), {
      argv: ["recover", directory],
      execArgv: ["--import", pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href],
      stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let stdout = "", stderrBytes = 0, stopped = false;
    const fail = () => {
      if (stopped) return; stopped = true; clearTimeout(timer);
      void worker.terminate(); reject(new Error("REPORT_LEGACY_RECOVERY_FAILED"));
    };
    const timer = setTimeout(fail, 30_000);
    worker.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); if (Buffer.byteLength(stdout) > 1024 * 1024) fail(); });
    // Raw assertion errors are deliberately not copied into reports or logs.
    worker.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) fail(); });
    worker.once("error", fail);
    worker.once("exit", code => {
      if (stopped) return;
      if (code !== 0 || stderrBytes) { fail(); return; }
      stopped = true; clearTimeout(timer);
      try {
        const value = JSON.parse(stdout);
        assert.equal(value.kind, family + "-aggregate");
        resolve(value);
      } catch { reject(new Error("REPORT_LEGACY_RECOVERY_FAILED")); }
    });
  });
}

export const recoverLegacyContext = (directory: string) => recoverBundle(directory, "sdk-context-live") as Promise<Awaited<ReturnType<typeof recover>>>;
export const recoverLegacySupervision = (directory: string) => recoverBundle(directory, "sdk-supervision-live") as Promise<Awaited<ReturnType<typeof recoverSupervision>>>;
