# E8 offline driver

```powershell
npm run test:review-e8
npm run test:review-e8:recover -- artifacts/harness/review-e8/offline-<id>/broker.jsonl
```

Recovery takes a **particular** offline journal; for a normal batch use
`offline-<id>/ucr/broker.jsonl`. It validates the hash chain in a fresh process,
does not reopen Pi, mutate the journal or send requests. An unsettled reservation
stays `unknown_outcome` and is never replayed.

This is an **offline-only test profile**, not a live evaluation adapter. There is
no upstream URL, credential resolver or `live` mode. The model is a synthetic
OpenAI-compatible fixture with a 262,144 context window and 2,048 output ceiling;
its usage and answers are deliberately synthetic, not measured model quality.
The proposed real model's endpoint, capabilities and compat are not verified here.

## Real components / test seams

- Pinned Pi 0.63.1 AgentSession, native tool dispatch, provider serializer/parser,
  assistant stream and manual compaction run without a replacement provider or
  a separate agent loop.
- The complete current generated v24 novel extension is materialized **once**
  in the parent, hashed, and copied byte-for-byte into each isolated worker.
  Separate bundling can rename functions used by the extension generator;
  independently generating it in each bundle would not produce identical bytes.
- A second, test-only extension restricts tool names and the one source path.
  U/C have no active tools; R exposes the six read-only tools in the proposal.
  Inactive tool attempts are also observed at SDK `tool_execution_start`, because
  Pi rejects those before the ordinary extension `tool_call` event.
- A credential-free worker can connect only to its parent's owned loopback
  address. The parent has no remote HTTP implementation. The JS guard is defense
  in depth for trusted tests, **not** an OS sandbox for hostile code.
- The local synthetic broker checks the production transport sidecar and then
  fsyncs an independent, one-use request reservation before permitting local HTTP.
  Its append-only journal refuses replacement, truncation and in-place edits.
  This is test bookkeeping, not a production billing ledger.
- SDK entries, worker fetch attempts, reservations, loopback receipts, synthetic
  dispatch and terminal responses are separate evidence. SDK internal retries
  after a fatal result may reach the outer admission gate, but may not send another
  HTTP request. No failed reservation is refunded.

## U / C / R

| Case | Loopback requests in positive fixture | Evidence |
| --- | ---: | --- |
| U | 2 | Raw usage presence, SDK-normalized terminal usage and production estimates paired by invocation |
| C | 4 | Independent control (1), treatment native dual summary (2) and answer (1); common seed, no answer leakage |
| R | 8 | Native read, planned budget inspection, new-context revalidation, same-size v1-to-v2 change and explicit checkpoint refresh |

The C oracle is outside all worker projects. Correct scripted JSON only checks
scoring/plumbing. Native summary content, TaskContract/checkpoint/progress, recent
messages and final model projection are retained separately. A deliberately bad
summary can coexist with a correct scripted recovery answer; the report must not
upgrade it to “summary quality passed.” Normal summary review is `pending_review`.

R budget calls are part of the fixed eight-request trajectory, not free observer
calls added later. Capturing their results performs no additional source read or
model request. `metrics.reads` counts budgeted extension `readFile` calls, not
native-tool IO, disk operations, total process IO or money saved. No subtraction
from E1's different 87-byte trajectory is meaningful.

Every run gets a new `artifacts/harness/review-e8/offline-*` directory. It includes
the generated extension, compiled worker/recovery programs, source hashes, oracle,
public requests/responses, isolated sessions, metrics and score/provenance reports.
Failed runs are retained. Canon/approval sentinels and source/fixture/frozen-eval
trees are checked for changes. Global Pi settings and real novels are not loaded.

## Separate preparation and gated execution

The offline command is not authorization, preparation or a paid-model result.
The separate `scripts/run-review-e8.mjs` entry point now provides:

```powershell
npm run test:review-e8:prepare
npm run eval:review-e8:prepare -- C:\Users\Silence\.pi\agent\models.json
npm run eval:review-e8:verify -- <absolute-manifest-path> C:\Users\Silence\.pi\agent\models.json
npm run eval:review-e8:recover -- <absolute-broker-journal-path>
```

`prepare` projects only the selected model. It never resolves the environment
credential or contacts its endpoint. Native versus mapped endpoint serialization
is compared at the actual SDK payload hook. Then full production U/C/R runs over
an IPC pull stream with synthetic SSE; both parent and workers deny all network.
The frozen assets, inputs, scope extension, code, selected installed dependencies,
compiler, Node executable, model/endpoint/reference fingerprints and policy bind a
fresh `prepared-*` manifest. Re-run prepare after drift or 24-hour expiry; never
edit a frozen manifest to extend its allowance. Doc prose is not executable input.

There is a **separate paid `live` mode**, never invoked by test/prepare/verify.
It requires `--approve <exact-manifest-SHA256> --accept-unknown-cost`. A
credential-free subprocess atomically consumes that manifest before the selected
environment value can be forwarded to the broker. Execution has a second one-use
claim. Worker credentials remain synthetic; the actual credential/endpoint stay
with the broker and never enter its journal. Copied manifests and repeat runs fail.
The broker revalidates the frozen inputs before admission/dispatch, pins the
destination without redirect or retry, and serializes native summary requests.
Backpressured SSE bytes are parsed by the actual SDK, not a replacement provider.

All task/request allowances include summaries and failed/unknown reservations.
The two C sessions share their 8-minute task deadline. Raw absent cache remains
null and cost unknown. Missing input/output usage, cancellation, drift, transport
or permission faults stop the whole batch; late headers/chunks cannot revive it.
`recover` is read-only, even for unfinished or consumed batches. Synthetic fault
injection is labeled unapproved and does not establish remote availability.

See `docs/REVIEW_E_PREPARATION.md` and `docs/REVIEW_E_LIVE_VALIDATION_PLAN.md`.
Only explicit approval of the newly frozen manifest allows a real run; historical
live profiles/allowances must not be reused or relabeled. JS guards are trusted
test containment, not an OS security boundary or protection from manual host edits.

## Failure-path evidence and tool-policy diagnostics

Workers now harvest messages, notices, the session path and native transport
entries during best-effort teardown, even when a later `can-continue` fails.
Each capture/cleanup failure is recorded separately without replacing the primary
failure. Shutdown is bracketed by captures; no extra model prompt is sent. A hard
process kill still cannot guarantee in-memory evidence export.

Prepared execution returns nonzero for stopped, incomplete or failed automated
U/C/R checks. Unrun evidence stays `not_run`/null. Exit zero is not acceptance of
summary quality: that remains a separate human review.

The prepared broker checks the pinned SDK's `completion + reasoning` output
normalization against the reservation. Raw fields and their presence are retained;
malformed present reasoning or unsafe sums stop the batch. Positive reasoning has
unverified billing semantics, so its reference price stays unknown even if cache
is known. Actual cost always remains unknown.

Zero-network serializer probes cover empty tools, omitted tools, omitted tools
with tool history, and explicit `toolChoice: "none"`. These standalone probes
do not change joint-profile workers or production; the separate diagnostic below
explicitly opts in for one test request. Provider support and the
cause of the first undeclared-tool response remain unverified. Simulated upstream
faults use injected SSE, no host credential and no paid approval. See
`docs/REVIEW_E_FAILURE_RECOVERY.md`; old consumed batches must not be rerun.

## Separate one-request tool protocol profile

```powershell
npm run test:review-e8:tool-none
npm run eval:review-e8:prepare-tool-none -- C:\Users\Silence\.pi\agent\models.json
```

This creates a new `tool-none-*` manifest, not another U/C/R allowance. The test
scope extension adds only `tool_choice: "none"` before the full production audit;
the ordinary joint profile is unchanged. A new isolated session receives the
original first U prompt once. No tools, summaries, retries or follow-ups are
permitted. Hard bounds: 1 request, 8,192 input bytes, 2,048 output reservation,
90-second request / 120-second task / 180-second batch deadlines. The shared
positive numeric tool counter ceiling is not permission: active tools and the
permission gate both allow zero executions.

Raw SSE tool-call deltas (including legacy `function_call`) prevent a false
text-only observation even if the SDK ignores them. HTTP status codes are
retained without arbitrary response-error bodies or sensitive headers. A text
response is a single protocol observation, not a root-cause or upstream identity
proof. U/C/R remains unrun. The original exact-hash single-use approval workflow
applies; preparation is zero-network and never resolves the host key. See
`docs/REVIEW_E_TOOL_PROTOCOL_DIAGNOSTIC.md` for the new profile and evidence.

## Versioned joint profile with explicit U/C no-tools policy

```powershell
npm run test:review-e8:joint-tool-none
npm run eval:review-e8:prepare-joint-tool-none -- C:\Users\Silence\.pi\agent\models.json
```

`joint-tool-none` creates a fresh `joint-tool-none-*` manifest with its own kind
and JSON plan. The original `joint` and single-request `tool-none` profiles,
consumed batches and design JSON are not rewritten. This is preparation, not
permission to send real requests. Exact-hash, unknown-cost and one-use gates still
apply; the 24 batch / 8 per task limits are unchanged.

Only U/C workers decorate the existing pinned provider's `onPayload`, adding
`tool_choice: "none"` before ordinary production audits and serialized-body
metering. This also covers the two native summary calls, which bypass ordinary
extension hooks. Empty ordinary tools and omitted summary tools keep their
native shapes. The original stream object, parser, compaction algorithm and
production extension remain in use. R and production Agent tools are unchanged.

The final-body broker requires that policy for U/C and forbids it for R. Raw
tool deltas in any U/C response stop the batch, including legacy `function_call`
inside summaries. Reports match adjustment hashes to actual reserved bodies;
missing proof cannot become a successful automated result. The positive offline
fixture has four ordinary no-tools requests, two no-tools summaries and eight
unmodified R requests. Scripted recovery answers still do not prove real summary
quality or explain the earlier real undeclared-tool response. See
`docs/REVIEW_E_JOINT_TOOL_NONE.md` for regression and the newly prepared manifest.

## Offline budget tracing and response contract v2

```powershell
npm run test:review-e8:budget-contracts
```

This test captures the pinned Agent/provider payload before network dispatch for
reasoning metadata, off/low/high, and both output-limit fields. It proves client
serialization only, not proxy enforcement. A read-only audit of three historical
requests found client `max_completion_tokens: 2048` missing from the installed
proxy's normalized request log; its saved upstream request instead had output
65,536 and thinking 16,384. No global configuration was changed. See
`docs/REVIEW_E_PROXY_BUDGET_AND_CONTRACT.md` for evidence and limitations.

The independent `joint-enum-v2` profile provides all state vocabulary alternatives
in the question, requires an exact typed JSON schema and rejects duplicate keys.
The original oracle is host-only; old prompts, scores and consumed batches are
not regraded. Both C arms receive the same question, after native compaction in
treatment, while production TaskContract/checkpoint projections remain intact.
Synthetic correct answers verify plumbing, not real summary quality.

This profile has **liveAllowed: false**. Authorization, activation and live broker
construction fail before credential resolution or approval consumption. Only the
offline test prepares it, using a public fake model configuration; there is no
new real-model allowance or public live-prepare command. Resolve proxy budget
semantics and obtain a new exact-manifest approval before future real testing.

## User-accepted upstream budget

The later `joint-upstream` profile retains contract v2 while explicitly accepting
the gateway's existing 65,536 output / 16,384 thinking configuration. It reserves
their conservative sum (81,920) locally instead of treating the ignored client
parameter as an enforced cap. Payloads, the SDK, production and global settings
are unchanged. Each receipt records both the actual client field and the larger
reservation; all former profiles keep their former limits.

Run `npm run test:review-e8:upstream` for isolated synthetic checks, or
`npm run eval:review-e8:prepare-upstream -- <models.json>` for a new manifest.
Exact-manifest single-use execution, 24 batch / 8 per-task requests, timeouts,
tool permissions and unknown-usage stops remain. The full no-cache reservation
reference is $8.552448, not a verified bill or money cap; unknown cost stays null.
See `docs/REVIEW_E_UPSTREAM_RESULT.md` for the user's decision and execution record.

## R-only retest after output-accounting repair

`read-upstream` runs only the existing R prompts, tools and source transition in
a fresh isolated project/session. It cannot register U/C workers or summarize.
Use `npm run test:review-e8:read-upstream` and
`npm run eval:review-e8:prepare-read-upstream -- <models.json>`; the existing
verify / exact-manifest single-use live commands apply unchanged.

The previous real R used eight requests and needed another final answer, so this
separate profile permits at most twelve requests, with the accepted 81,920 output
reservation per request. Its full no-cache reservation reference is $4.276224,
not a bill or money cap. Historical profiles and consumed allowances are unchanged.

Production v25 records bounded, run-local host receipts for charged tool content.
Context reprojection of that exact result does not charge its output bytes again;
new results and old/foreign content still consume the unchanged 64 KiB allowance.
Source revalidation and final model-input accounting are not bypassed. Regress
this separately with `npm run test:tool-output-accounting`; R-only success requires
all five read-evidence checks and complete input/output usage pairing, not merely
HTTP 200. See `docs/REVIEW_E_READ_RETEST_RESULT.md` for the actual outcome.
