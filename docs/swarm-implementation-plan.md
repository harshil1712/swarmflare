# Swarmflare Implementation Plan

## Goal

Build Swarmflare as a Cloudflare-native agentic swarm, not a line-oriented batch processor. A user should give one broad goal to a Main Agent. The Main Agent should plan the work, create bounded parallel work units, spin up swarm workers, stream progress live to the browser, recover from interruption, and synthesize a final answer with inspectable worker traces.

This plan is based on the current `swarmflare` repo and current Cloudflare documentation retrieved during planning.

## Current Repo Baseline

The repo is currently the Cloudflare Agents starter:

- `src/server.ts` exports `ChatAgent extends AIChatAgent<Env>`.
- `src/app.tsx` connects with `useAgent<ChatAgent>({ agent: "ChatAgent" })` and `useAgentChat({ agent })`.
- `ChatAgent` already uses Workers AI through `workers-ai-provider` and `@cf/moonshotai/kimi-k2.6`.
- The UI already has a WebSocket connection, custom `onMessage` handling, typed callable methods, MCP server support, and Kumo chat components.
- `wrangler.jsonc` already defines a SQLite-backed Durable Object binding for `ChatAgent`.
- `package.json` already includes `agents`, `@cloudflare/ai-chat`, `ai`, `workers-ai-provider`, `zod`, Vite, and Wrangler.

The repo therefore needs an architectural conversion, not a platform setup from scratch.

## Research Summary

Cloudflare Agents SDK supports the primitives needed for this design:

- Agents are Durable Object-backed and provide persistent SQLite state, WebSockets, schedules, RPC, and hibernation.
- `this.setState()` persists JSON state and broadcasts it to connected WebSocket clients immediately.
- `@callable()` exposes typed browser-to-agent RPC over the existing WebSocket connection.
- `startFiber()` durably accepts background work, returns quickly, dedupes with an idempotency key, and supports inspection/cancellation.
- `runFiber()` and `ctx.stash()` provide durable checkpoints and `onFiberRecovered()` recovery after Durable Object eviction, code update, or restart.
- Sub-agents provide isolated SQLite storage and typed RPC for child agents without separate production Durable Object bindings.
- Agent tools can run chat-capable child agents as retained, streaming tools with replayable timelines, but they are best when the parent model itself decides when to call a child tool.
- Workers AI text generation default limit is documented as 300 requests per minute by task type, with possible per-model differences.
- Agents platform limits document 1 GB state per unique Agent and 30 seconds compute per Agent, refreshed per HTTP request, WebSocket message, or schedule. Wall-clock waiting on I/O can be longer.
- Durable Object design guidance says the object should model the atom of coordination; for Swarmflare, that atom is one user conversation or run, not one global singleton.

Primary references:

- Cloudflare Agents patterns: `https://developers.cloudflare.com/agents/patterns/`
- Durable execution and Fibers: `https://developers.cloudflare.com/agents/api-reference/durable-execution/`
- Store and sync state: `https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/`
- WebSockets: `https://developers.cloudflare.com/agents/api-reference/websockets/`
- Callable methods: `https://developers.cloudflare.com/agents/api-reference/callable-methods/`
- Sub-agents: `https://developers.cloudflare.com/agents/api-reference/sub-agents/`
- Agent tools: `https://developers.cloudflare.com/agents/api-reference/agent-tools/`
- Agents limits: `https://developers.cloudflare.com/agents/platform/limits/`
- Workers AI limits: `https://developers.cloudflare.com/workers-ai/platform/limits/`
- Durable Object rules: `https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/`

## Product Model

The old Swarm concept is:

```text
one instruction + many user-supplied items -> run same instruction over each item -> synthesize
```

Swarmflare should be:

```text
one user goal -> Main Agent plans work units -> swarm workers execute -> Main Agent synthesizes
```

Use these terms:

- **Run**: One full swarm execution for a user goal.
- **Work unit**: One planned subtask created by the Main Agent. This replaces the batch-processor term `item`.
- **Worker**: A child execution role that completes one work unit.
- **Finding**: Structured worker output from one work unit.
- **Synthesis**: Final Main Agent answer across all findings.

An `item` in `acoyfellow/swarm` means one independent input row supplied by the user. Swarmflare should not expose that as the core mental model unless a future "batch mode" is added.

## Architecture Decision

Use the existing `ChatAgent` as the Main Agent in phase 1. Do not add a second top-level Durable Object unless we need per-run isolation later.

For the demo milestone, intentionally keep a single `ChatAgent` instance. The current client does not pass an explicit agent `name`, so all demo activity uses the default instance. This is acceptable for local and single-user demo work, but it means all demo users share the same swarm state, fiber ledger, and chat history. Per-user or per-conversation agent identity should be added before public or multi-user deployment.

Rationale:

- The app already routes all browser traffic to `ChatAgent`.
- `AIChatAgent` already gives message persistence and streaming chat behavior.
- The Main Agent can keep swarm run state in `this.state` for live UI and rely on managed fiber records plus `ctx.stash()` snapshots for run inspection/recovery.
- Sub-agents can be introduced under `ChatAgent` without additional production Durable Object bindings.

Target shape:

```text
Browser React app
  -> useAgent/useAgentChat WebSocket
  -> ChatAgent as Main Agent
      -> startFiber("swarm-run", ...)
      -> main model assigns work units in startSwarm tool call
      -> coordinator starts startFiber("swarm-worker", ...) per work unit
      -> coordinator and workers checkpoint with ctx.stash()
      -> setState()/broadcast progress
      -> synthesize final answer
```

## Polling Decision

Do not use polling for progress or results.

Use the existing WebSocket channel:

- `this.setState()` for durable, replayable run state that the UI can render after refresh.
- `this.broadcast()` for ephemeral event frames such as "worker started", "token chunk", or "toast".
- `@callable()` for explicit user actions like cancelling, retrying, exporting, and debug-starting a run.
- Optional `@callable({ streaming: true })` for explicit progress streams if state updates are too coarse.

Keep REST only for deployment/static asset routing and optional export downloads. The normal product path should be WebSocket-first.

## State Design

Keep `this.state` small because every state update broadcasts to connected clients.

Recommended state:

```ts
type SwarmStatus =
  | "idle"
  | "planning"
  | "running"
  | "synthesizing"
  | "complete"
  | "failed"
  | "cancelled";

type WorkUnitStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

type SwarmState = {
  activeRunId?: string;
  status: SwarmStatus;
  goal?: string;
  model: string;
  progress: {
    total: number;
    queued: number;
    running: number;
    complete: number;
    failed: number;
  };
  workUnits: Array<{
    id: string;
    title: string;
    role: string;
    status: WorkUnitStatus;
    summary?: string;
    error?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
  synthesis?: {
    headline: string;
    answer: string;
    markdown: string;
  };
  error?: string;
  startedAt?: string;
  completedAt?: string;
};
```

Use managed fiber records and snapshots for run details during the first durable phases:

```ts
type SwarmRecoverySnapshot = {
  runId: string;
  goal: string;
  phase: "planning" | "planned" | "running" | "synthesizing" | "complete";
  status: SwarmStatus;
  startedAt: string;
  completedAt?: string;
  workUnits: SwarmState["workUnits"];
  synthesis?: SwarmState["synthesis"];
  error?: string;
};
```

The latest snapshot should be inspectable through `inspectFiberByKey()` and sufficient for phase 2/3 recovery decisions. Add custom SQL later only for large/queryable artifacts that should not live in state or fiber snapshots.

## Agent Classes

### `ChatAgent` / Main Agent

Keep the exported class name initially to avoid changing the Durable Object binding and generated env types in the first implementation phase.

Responsibilities:

- Accept user goals.
- Decide whether a normal chat response or swarm run is needed.
- Plan work units.
- Start durable swarm fibers.
- Coordinate bounded parallel execution.
- Stream progress through state/broadcast events.
- Synthesize the final response.
- Provide control RPCs: start, cancel, retry, list, inspect, export.

Later, rename `ChatAgent` to `MainAgent` only if we are ready to update `wrangler.jsonc`, migrations, client types, and deployment state intentionally.

### Worker fibers

Start one `swarm-worker` fiber per work unit from the coordinator fiber. Do not add sub-agents in the first real implementation.

Responsibilities:

- Execute one work unit with a role-specific system prompt.
- Produce structured JSON output.
- Stash a worker snapshot containing status, output, error, and timestamps.
- Let the coordinator inspect worker fiber snapshots and project progress into `this.state`.

Sub-agents can be introduced later only if workers need isolated long-lived state, chat transcripts, or MCP/client-tool behavior.

## Planning Flow

The Main Agent model should create bounded work units directly in the `startSwarm` tool call. Avoid a separate planner model call unless we later need a more controlled planning loop.

The `startSwarm` tool input should use a Zod schema like:

```ts
const StartSwarmSchema = z.object({
  goal: z.string(),
  reason: z.string(),
  workUnits: z
    .array(
      z.object({
        title: z.string(),
        role: z.string(),
        objective: z.string(),
        prompt: z.string(),
        expectedOutput: z.string()
      })
    )
    .min(1)
    .max(MAX_WORK_UNITS)
});
```

Planning guardrails:

- Default `MAX_WORK_UNITS=6` for broad tasks.
- Hard cap `MAX_WORK_UNITS=12` until budget/rate limiting exists.
- Reject or ask for clarification when the goal is too broad, unsafe, or requires inaccessible data.
- Prefer independent work units so they can run in parallel.
- Do not support dependencies in the first real swarm implementation.

## Execution Flow

Use one coordinator fiber for the full run, then one worker fiber per work unit:

```ts
@callable()
async startSwarm(input: { goal: string; workUnits: WorkUnitInput[] }, clientRunId?: string) {
  const runId = clientRunId ?? crypto.randomUUID();
  const receipt = await this.startFiber(
    "swarm-run",
    (ctx) => this.executeSwarmRun(ctx, runId, input.goal, input.workUnits),
    {
      idempotencyKey: `swarm:${runId}`,
      metadata: { runId, goal: input.goal }
    }
  );

  return {
    runId,
    accepted: receipt.accepted,
    fiberId: receipt.fiberId,
    status: receipt.status
  };
}
```

Inside `executeSwarmRun()`:

1. Validate `goal` and `workUnits`.
2. Stash a complete planned coordinator snapshot.
3. Start one `swarm-worker` fiber per work unit with stable idempotency keys.
4. Poll/inspect worker fibers and project worker snapshots into `this.state`.
5. Stash a complete coordinator snapshot after every inspection/update.
6. Cancel known worker fibers if the coordinator receives `ctx.signal.aborted`.
7. Synthesize final answer from completed worker snapshots.
8. Stash final synthesis, update state, and display the final answer without accidentally triggering a second model turn.

Start all workers for the first demo. Add a `MAX_CONCURRENCY` gate later if Workers AI limits require it.

## Worker Execution Decision

Use `startFiber("swarm-worker", ...)` for each work unit in the first real swarm implementation.

Pros:

- Each worker has its own durable status and snapshot.
- Workers can run concurrently without custom SQL or sub-agent bindings.
- The coordinator can inspect worker fibers to build an inspectable swarm trace.
- Cancellation and interruption map directly to managed fiber status.

Deferred options:

- Sub-agents, if workers need isolated long-lived state or chat transcripts.
- Agent Tools, if we want retained child timeline UI and `useAgentToolEvents()` integration.

## Recovery Strategy

Implement `onFiberRecovered(ctx)` for `swarm-run` and `swarm-worker`.

Recovery snapshot should include:

```ts
type SwarmRecoverySnapshot = {
  runId: string;
  goal: string;
  phase: "planned" | "running" | "synthesizing" | "complete";
  status: SwarmStatus;
  startedAt: string;
  completedAt?: string;
  workUnits: SwarmState["workUnits"];
  synthesis?: SwarmState["synthesis"];
  error?: string;
};
```

Recovery policy:

- If interrupted before a snapshot exists, safely mark interrupted.
- If a snapshot exists, rebuild state from `ctx.snapshot`.
- Any `running` work unit without a completed output in the snapshot is treated as interrupted for now.
- Retry/resume can be added after inspection APIs are in place.
- If too many workers fail, mark run `failed` but preserve partial findings.
- Return a `FiberRecoveryResult` for managed `startFiber()` recovery when the run is resolved, or leave interrupted if manual inspection is required.

Important constraint: the original fiber closure cannot be replayed after eviction. Recovery must call a named method with enough data from `ctx.snapshot` and fiber metadata to resume.

## Cancellation

Add:

```ts
@callable()
async cancelSwarm(runId: string) {
  await this.cancelFiberByKey(`swarm:${runId}`, "User cancelled");
  await this.cancelKnownWorkerFibers(runId);
  this.setState(cancelledProjection);
}
```

Execution code must check `ctx.signal.aborted`:

- Before launching a worker.
- After a worker finishes but before visible side effects.
- Before synthesis.

Mark pending/running work units as `cancelled` and update state.

## UI Plan

Keep the existing chat UI initially, then add a swarm panel.

Client changes:

- Add `onStateUpdate` to `useAgent` and store `swarmState`.
- Add JSON `onMessage` handling for events like `swarm:event`.
- Render the swarm panel automatically when the model starts a swarm.
- Render progress above or beside the chat stream.
- Show work unit cards with status, role, and short summary.
- Show final synthesis in the chat stream and in an export/report panel.

State-driven UI is enough for refresh/reconnect. Broadcast events can add animation/detail but should not be the only source of truth.

Example event frame:

```ts
this.broadcast(
  JSON.stringify({
    type: "swarm:event",
    runId,
    event: "work-unit-complete",
    workUnitId,
    title,
    summary,
    timestamp: new Date().toISOString()
  })
);
```

## Chat Integration

The primary interaction mode should be model-routed orchestration.

### Model Tool Mode

Expose `startSwarm` as an AI SDK tool inside `onChatMessage()`. The user sends a normal chat message, and the Main Agent decides whether to answer directly, ask a clarifying question, or launch a swarm.

Pros:

- Natural UX: users describe goals instead of choosing execution mode.
- Keeps the Main Agent responsible for orchestration decisions.
- Allows normal chat and swarm execution to share one conversation surface.

Constraints:

- No approval gate for swarm starts.
- Enforce hard caps in code: work units, concurrency, goal length, prompt/output size, and no nested swarms.
- If another swarm is active, return the active run instead of starting a second one.
- The tool should use a deterministic idempotency key derived from the triggering chat turn where possible.

Recommendation: use this for phase 1.

### Debug Callable Mode

Keep `@callable() startSwarm({ goal, workUnits }, clientRunId?)` for testing, development, and future non-chat entry points. It should not be the primary product path.

## Prompting Contracts

Use separate prompting contracts for main-model work assignment, worker execution, and synthesis.

### Main Model Work Assignment

The main chat model supplies work units in the `startSwarm` tool call. It should be instructed to:

- Break the task into independent work units.
- Avoid work that requires data it cannot access.
- Make each work unit narrowly scoped.
- Prefer diversity of analysis roles.
- Cap work units to configured maximum.
- Avoid dependencies between work units.

### Worker Prompt

Worker should produce structured JSON:

```ts
const WorkerOutputSchema = z.object({
  title: z.string(),
  answer: z.string(),
  keyFindings: z.array(z.string()),
  evidence: z.array(
    z.object({
      claim: z.string(),
      source: z.string().optional()
    })
  ),
  confidence: z.enum(["low", "medium", "high"]),
  followUps: z.array(z.string()).default([])
});
```

### Synthesis Prompt

Synthesis should:

- Use only worker findings and the original user goal unless tools are explicitly available.
- Identify disagreements or uncertainty.
- Produce concise final answer plus Markdown report.
- Include a machine-readable summary for export.

## Configuration

Add vars to `wrangler.jsonc` after implementation:

```jsonc
"vars": {
  "SWARM_MODEL": "@cf/moonshotai/kimi-k2.6",
  "SWARM_PLANNER_MODEL": "@cf/moonshotai/kimi-k2.6",
  "SWARM_WORKER_MODEL": "@cf/moonshotai/kimi-k2.6",
  "SWARM_SYNTHESIS_MODEL": "@cf/moonshotai/kimi-k2.6",
  "MAX_WORK_UNITS": "6",
  "MAX_CONCURRENCY": "3",
  "MAX_WORK_UNIT_ATTEMPTS": "2"
}
```

After changing bindings or env types, run:

```bash
npm run types
```

## File-Level Implementation Plan

The implementation should be built in small working phases. The first demo should run a real multi-fiber swarm, while keeping storage and inspection simple.

### Phase 1: Model-routed swarm shell

- Keep `useAgent({ agent: "ChatAgent" })` as-is for the single-instance demo.
- Add `src/swarm/types.ts` for run, work unit, status, output, and lightweight state types.
- Add `initialState` to `ChatAgent` and type it as `AIChatAgent<Env, SwarmState>`.
- Add `@callable() startSwarm({ goal, workUnits }, clientRunId?)`.
- Add a server-side `startSwarm` AI SDK tool in `onChatMessage()` so the main model can launch swarms automatically and assign concrete work units.
- Add `onStateUpdate` to `useAgent` in `src/app.tsx`.
- Add a basic `SwarmPanel` component that renders active status, progress counts, work-unit cards, and errors.

Done when a broad normal chat message can cause the main model to call `startSwarm` with bounded work units and the UI can render the accepted run without polling.

### Phase 2: Multi-fiber real swarm run

- Use one coordinator fiber per swarm run: `startFiber("swarm-run", ...)`.
- Use one worker fiber per work unit: `startFiber("swarm-worker", ...)`.
- Use a stable idempotency key from the triggering chat turn when available, or from `clientRunId` for debug callable starts. Fall back to the generated `runId` only for direct/manual calls.
- Wrap the coordinator `startFiber()` receipt and return the API shape `{ runId, accepted, fiberId, status }`.
- Implement `executeSwarmRun(ctx, runId, goal, workUnits)` as the coordinator fiber.
- Coordinator starts all worker fibers with idempotency keys like `swarm:${runId}:worker:${workUnitId}`.
- Each worker fiber runs a real Workers AI model call for exactly one work unit.
- Each worker fiber stashes `WorkerRecoverySnapshot` with status, output, errors, and timestamps.
- Coordinator inspects worker fibers, projects their snapshots into `this.state`, and stashes a complete `SwarmRecoverySnapshot` after each poll/update.
- Coordinator synthesizes a final answer from completed worker snapshots.
- Add `@callable() cancelSwarm(runId: string)` using `cancelFiberByKey()` or `inspectFiberByKey()` plus `cancelFiber()`.
- Cancellation should cancel the coordinator fiber and best-effort cancel all known worker fibers.
- Implement minimal `onFiberRecovered()` for `swarm-run` and `swarm-worker` so interrupted fibers are safely marked for inspection.

Done when a real multi-worker swarm can be started by the model, observed live, cancelled, and safely marked after a `wrangler dev` restart.

### Phase 3: Fiber-backed run inspection

Cloudflare managed fibers already provide the durable run ledger for `startFiber()` executions. Do not add custom `swarm_runs` or `swarm_work_units` SQL tables in this phase.

Use the platform primitives this way:

- `startFiber()` retained managed fiber row: durable run ledger with `fiberId`, `name`, `idempotencyKey`, `status`, `metadata`, `snapshot`, timestamps, and errors.
- `ctx.stash()` snapshot: durable progress and recovery payload for the swarm domain state.
- `this.state`: small live UI projection broadcast to connected clients.

Implementation work:

- Expand `SwarmRecoverySnapshot` so the latest snapshot can inspect a run without custom SQL.
- Include `runId`, `goal`, `phase`, `status`, `startedAt`, `completedAt`, `workUnits`, `synthesis`, and `error` in the snapshot.
- Ensure every `ctx.stash()` call writes a complete snapshot, not a delta.
- Add a helper that projects a `SwarmRecoverySnapshot` into `SwarmState`.
- Use that projection helper during normal execution, cancellation, and recovery so state and snapshots do not drift.
- Add `@callable() getSwarmRun(runId: string)` using `inspectFiberByKey()` with the `swarm:${runId}` idempotency key.
- Return fiber status, metadata, latest snapshot, error, and timestamps from `getSwarmRun()`.
- Add `@callable() listSwarmRuns(limit?: number)` using `listFibers({ name: "swarm-run", limit })`.
- Build run summaries from fiber metadata plus the latest snapshot.
- Add a cleanup callable or internal cleanup helper using `deleteFibers()` for old settled fibers.
- Keep fiber status and domain status separate: fiber cancellation is `aborted`; swarm UI status is `cancelled`.
- Improve `onFiberRecovered()` to restore state from snapshot and return an explicit `FiberRecoveryResult`.
- For interrupted coordinator or worker fibers, safely leave or mark interrupted instead of adding a custom resume store.

Done when active, completed, cancelled, failed, and interrupted swarm runs and workers can be inspected through fiber APIs after refresh/reconnect, old settled fibers can be cleaned up, and no custom SQL tables are added.

### Phase 4: Bounded parallelism and recovery polish

- Enforce `MAX_WORK_UNITS`, goal length, prompt length, and output size limits.
- Add `MAX_CONCURRENCY` if we need to avoid starting all worker fibers at once.
- Treat worker `interrupted` or `running` without output as retryable in a later retry action.
- Add partial-failure synthesis policy.
- Improve recovery from coordinator snapshot where possible.

Done when worker failures do not fail the whole swarm if at least one useful worker succeeds, and interrupted runs are understandable from snapshots.

### Phase 5: Synthesis polish

- Add synthesis prompt/schema.
- Generate final answer from the original goal plus snapshot-backed worker findings.
- Stash synthesis to the fiber snapshot and state.
- Display final Markdown in the swarm panel.
- If adding the final answer to chat, persist it directly and avoid accidentally triggering an extra model turn.

Done when a completed swarm produces a final Markdown report from real worker findings.

### Phase 6: Artifact storage, if needed

Add custom SQL tables only after real planner/worker outputs exceed what should reasonably live in fiber snapshots or state.

- Add `src/swarm/sql.ts` only if we need queryable or large artifact storage.
- Store full prompts, model outputs, worker findings, traces/events, and exports outside `this.state`.
- Keep `this.state` as the live UI projection.
- Keep managed fibers as the execution ledger.
- Use SQL for artifacts and history that need richer querying than fiber metadata/snapshot provides.

Done when large real worker artifacts can be inspected/exported without bloating state or fiber snapshots.

### Phase 7: Demo polish and cleanup

- Add `exportSwarmRun(runId, "md" | "json")` if useful for the demo.
- Add trace/event artifact storage only if inspectable worker traces are needed in the demo.
- Add a reset/cleanup action for the single demo instance.
- Delete or expire retained coordinator and worker fibers according to a simple retention rule.
- Run `npm run check` and `npm run types` after config or Env changes.

Done when the single-instance demo is bounded, resettable, and presentable.

## Original Detailed Implementation Notes

### Types and storage

- Add `src/swarm/types.ts` for run, work unit, plan, output, and state types.
- Add `src/swarm/schemas.ts` for Zod schemas.
- Add custom SQL helpers only in the later artifact storage phase, if fiber snapshots are not enough.

### Main Agent callable controls

- Add `initialState` to `ChatAgent` with idle swarm state.
- Add `@callable() startSwarm({ goal, workUnits }, clientRunId?: string)`.
- Add `@callable() cancelSwarm(runId: string)`.
- Add `@callable() getSwarmRun(runId: string)`.
- Add `@callable() exportSwarmRun(runId: string, format: "md" | "json")`.

### Main model assignment and synthesis

- Add `src/swarm/models.ts` for Workers AI provider creation and model selection.
- Let the main model assign work units in the `startSwarm` tool call.
- Add `synthesizeRun(runId)` using snapshot-backed worker outputs.
- Keep all model calls server-side.

### Worker fibers

- Implement `executeWorkerFiber(ctx, runId, workUnitId, input)` with structured output.
- Use `startFiber("swarm-worker", ...)` from the coordinator fiber.
- Make worker execution idempotent by `runId + workUnitId`.
- Stash worker output or error before the worker fiber settles.

### Durable fiber orchestration

- Implement `executeSwarmRun(ctx, runId, goal, workUnits)`.
- Use `startFiber("swarm-run", ...)` in `startSwarm()`.
- Use `startFiber("swarm-worker", ...)` for each worker.
- Use `ctx.stash()` after coordinator state changes, worker snapshot inspection, and synthesis.
- Implement `onFiberRecovered()` for `swarm-run` and `swarm-worker`.
- Add cooperative cancellation checks.

### UI

- Add `onStateUpdate` to `useAgent` in `src/app.tsx`.
- Add `SwarmPanel` component.
- Render the swarm panel automatically from agent state; do not require an explicit Swarm submit action.
- Render work unit status cards and final synthesis.
- Keep normal chat unchanged for non-swarm messages.

### Tests and validation

- Add unit tests for schemas and bounded concurrency helper.
- Add worker-runtime tests for callable start/cancel if test setup is introduced.
- Add manual recovery test instructions to README.
- Run `npm run check`.
- Run `npm run types` after env/config changes.

## API Surface

Browser-to-agent callable methods:

```ts
startSwarm(input: { goal: string; workUnits: SwarmWorkUnitInput[] }, clientRunId?: string): Promise<{ runId: string; accepted: boolean; fiberId: string; status: string }>;
cancelSwarm(runId: string): Promise<{ cancelled: boolean }>;
retryFailedWorkUnits(runId: string): Promise<{ accepted: boolean }>;
getSwarmRun(runId: string): Promise<SwarmRunDetail>;
listSwarmRuns(limit?: number): Promise<SwarmRunSummary[]>;
exportSwarmRun(runId: string, format: "md" | "json"): Promise<string>;
```

Optional HTTP export routes later:

```text
GET /api/swarm/runs/:id/report.md
GET /api/swarm/runs/:id/results.json
```

These should be convenience routes, not the main progress mechanism.

## Budget and Abuse Controls

Add before public deployment:

- Hard cap work units.
- Hard cap goal length.
- Hard cap worker prompt/output sizes.
- Concurrency cap.
- Per-agent or per-user daily run cap.
- Hard budget enforcement for model-planned swarm execution.
- Optional Cloudflare Turnstile or Access for public instances.
- Optional AI Gateway for logging, caching, rate limiting, and provider/model routing.

## Error Handling

Worker errors should not automatically fail the entire run unless too many fail.

Recommended policy:

- Retry each work unit up to `MAX_WORK_UNIT_ATTEMPTS`.
- Preserve failed work units with error messages.
- Synthesize if at least one worker succeeds and failure count is below threshold.
- Final synthesis should disclose failed work units.
- Mark whole run `failed` only if planning fails, all workers fail, synthesis fails after retry, or user cancels.

## Open Questions

- Should automatic swarm starts have per-user budget controls before public deployment?
- Should worker agents be plain `Agent` sub-agents or `AIChatAgent` sub-agents with retained chat transcripts?
- Do we need long-term run history beyond one `ChatAgent` instance, or is per-conversation history enough?
- Should outputs include citations/evidence only when browsing or MCP tools are connected?
- What is the public deployment auth model?

## Recommended First Milestone

Build a minimal vertical slice:

1. User sends one broad goal in normal chat.
2. The Main Agent decides to call its `startSwarm` tool with 2-6 concrete work units.
3. `ChatAgent.startSwarm()` accepts a coordinator fiber.
4. Coordinator starts one worker fiber per work unit.
5. Worker fibers run real Workers AI calls.
6. UI renders live state updates without polling.
7. Coordinator synthesizes and displays final Markdown.
8. Killing and restarting `wrangler dev` during a run resumes or safely marks interrupted work for retry.

This proves the core architecture before adding richer worker timelines, MCP-enabled workers, exports, or public deployment controls.
