/** Only offline run/test/rebuild/probe. No live mode or user credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),mode=process.argv[2];
assert.ok(["run","test","rebuild","probe","lifecycle-run","lifecycle-rebuild","lifecycle-probe","lifecycle-test"].includes(mode),"S3_OFFLINE_ONLY");
assert.ok(mode.endsWith("probe")?[5,6].includes(process.argv.length):process.argv.length===(mode.endsWith("rebuild")?4:3),"S3_ARGUMENTS");
if(mode==="probe"){assert.ok(["sdk-b1-reliability","sdk-b2-context","sdk-b3-checkpoint"].includes(process.argv[3]));assert.ok(["large-result","request-budget","compact-resume"].includes(process.argv[4]));assert.ok([undefined,"normal","unchanged","missing-source","corrupt-checkpoint","summary-error","summary-cancel","summary-limit"].includes(process.argv[5]));}
if(mode==="lifecycle-probe"){assert.ok(["sdk-b1-reliability","sdk-b2-context","sdk-b3-checkpoint-ops-v2"].includes(process.argv[3]));assert.ok(["auto-threshold","auto-overflow","write-acklost","write-partial","write-missing","write-after-compact"].includes(process.argv[4]));assert.ok([undefined,"normal","summary-error","summary-cancel","summary-limit","overflow-repeat","intent-persistence","result-persistence"].includes(process.argv[5]));}
const parent=path.join(root,"artifacts/harness");await mkdir(parent,{recursive:true});const work=await mkdtemp(path.join(parent,".sdk-context-build-"));
try{
	const bundle=path.join(work,"sdk-context.mjs"),inputs={};
	await build({entryPoints:[path.join(root,"evals/sdk-context/cli.ts")],outfile:bundle,bundle:true,platform:"node",format:"esm",packages:"external",logLevel:"warning",plugins:[{name:"s3-frozen-inputs",setup(api){api.onLoad({filter:/\.(ts|json)$/},async({path:filename})=>{const name=path.relative(root,filename).replaceAll("\\","/");assert.ok(/^(evals|tests)\//.test(name)||name==="src/extensions/checkpoint-runtime.ts","S3_UNEXPECTED_IMPORT");const contents=await readFile(filename);inputs[name]=createHash("sha256").update(contents).digest("hex");return{contents,loader:filename.endsWith(".json")?"json":"ts"};});}}]});
	const inputFile=path.join(work,"inputs.json");await writeFile(inputFile,JSON.stringify(inputs),{flag:"wx"});const env={};
	for(const [key,value]of Object.entries(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key))env[key]=value;
	Object.assign(env,{PI_CODING_AGENT_DIR:path.join(work,"agent"),PI_CONTEXT_WORK_ROOT:work,PI_CONTEXT_BUNDLE:bundle,PI_CONTEXT_BUILD_INPUTS:inputFile,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:path.join(work,"empty-git-config")});
	process.exitCode=await new Promise(resolve=>{const child=spawn(process.execPath,["--import",pathToFileURL(path.join(root,"scripts/eval-network-guard.mjs")).href,bundle,...process.argv.slice(2)],{cwd:root,env,stdio:"inherit",windowsHide:true});let interrupted=false;const stop=()=>{interrupted=true;child.kill();};const timer=setTimeout(stop,480000);process.once("SIGINT",stop);process.once("SIGTERM",stop);const done=code=>{clearTimeout(timer);process.off("SIGINT",stop);process.off("SIGTERM",stop);resolve(interrupted?1:code??1);};child.once("error",()=>done(1));child.once("close",done);});
}finally{const relative=path.relative(await realpath(parent),await realpath(work));assert.ok(relative.startsWith(".sdk-context-build-")&&!relative.includes(path.sep));await rm(work,{recursive:true,force:true,maxRetries:3});}
