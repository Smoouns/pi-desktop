import { checkAuthorization, prepareSdkLive, runSdkDry, runSdkLive } from "./runner.js";
import { recoverResults } from "./records.js";
import { runSdkLiveWorker } from "./worker.js";
import { runSdkLiveTests } from "../../tests/sdk-live/tests.js";
try {
	const mode=process.argv[2];
	if(mode==="worker") await runSdkLiveWorker();
	else if(mode==="test") console.log(`SDK S2 tests passed: ${await runSdkLiveTests()}. Zero real model requests.`);
	else if(mode==="dry-run") console.log(JSON.stringify(await runSdkDry(),null,2));
	else if(mode==="prepare") { const result=await prepareSdkLive(process.argv[3]); console.log(JSON.stringify({directory:result.directory,manifestSha256:result.manifestSha256,model:result.manifest.model,limits:result.manifest.limits,expiresAt:result.manifest.expiresAt},null,2)); }
	else if(mode==="recover") console.log(JSON.stringify(await recoverResults(process.argv[3]),null,2));
	else if(mode==="authorize") await checkAuthorization(process.argv[3],process.argv[6],process.argv[7]==="--accept-unknown-cost");
	else if(mode==="live") console.log(JSON.stringify(await runSdkLive(process.argv[3],process.argv[4],process.argv[6],process.argv[7]==="--accept-unknown-cost"),null,2));
	else throw new Error("S2_MODE_REJECTED");
} catch { console.error("SDK_S2_REJECTED"); process.exitCode=1; }
