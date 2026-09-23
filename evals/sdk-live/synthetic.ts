import assert from "node:assert/strict";
import { SDK_CONTENT, SDK_TARGET } from "../sdk-ablation/policy.js";
import { LIVE_MODEL, LIVE_PROMPTS, LIVE_RUNS } from "./policy.js";
import type { Simulation } from "./manifest.js";

/** Only the dry-run runner selects this SSE fixture. Never used for live execution. */
export function syntheticFetch(simulation: Exclude<Simulation,"none">): typeof fetch {
	let runIndex=0, turn=0;
	return async (_input,init) => {
		const run=LIVE_RUNS[runIndex]; assert.ok(run); const request=JSON.parse(init!.body as string);
		assert.equal(request.model,LIVE_MODEL.id); assert.equal(request.stream,true); assert.equal(request.stream_options?.include_usage,true);
		assert.ok(JSON.stringify(request.messages).includes(LIVE_PROMPTS[run.taskId].split(" ")[0]));
		turn++;
		if(simulation==="network") throw new Error("private-canary-must-not-be-recorded");
		let call: {name:string;arguments:Record<string,unknown>} | undefined;
		if(run.taskId==="P5A-READ-001") { if(turn===1 || simulation==="request-limit") call={name:"read_story_document",arguments:{path:"canon/world.md"}}; }
		else { const readTurn=simulation==="replay"?3:2;
			if(turn<readTurn)call={name:"write",arguments:{path:SDK_TARGET,content:SDK_CONTENT}};
			else if(turn===readTurn)call={name:"read",arguments:{path:SDK_TARGET}};
		}
		if(simulation==="forbidden-path")call={name:"write",arguments:{path:"canon/world.md",content:SDK_CONTENT}};
		if(simulation==="forbidden-tool")call={name:"bash",arguments:{command:"never-executed"}};
		const answer=run.taskId==="P5A-READ-001"?'{"canPredictStorm":false,"signers":["记录员","设备技师"]}':"ready";
		const delta=call?{role:"assistant",tool_calls:[{index:0,id:`call_${turn}`,type:"function",function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}
			:{role:"assistant",content:simulation==="answer-format" && runIndex===0 ? `\x60\x60\x60json\n${answer}\n\x60\x60\x60` : answer};
		const chunk=(choices:unknown[],usage?:unknown)=>({id:`synthetic-${runIndex}-${turn}`,object:"chat.completion.chunk",created:0,model:LIVE_MODEL.id,choices,...(usage?{usage}:{})});
		const chunks=[chunk([{index:0,delta,finish_reason:null}]),chunk([{index:0,delta:{},finish_reason:call?"tool_calls":"stop"}])];
		if(simulation!=="missing-usage")chunks.push(chunk([],{prompt_tokens:100,completion_tokens:10,total_tokens:110}));
		if(!call){runIndex++;turn=0;}
		return new Response(chunks.map(value=>`data: ${JSON.stringify(value)}\n\n`).join("")+"data: [DONE]\n\n",{status:200,headers:{"content-type":"text/event-stream"}});
	};
}
