import { createWorkersAI } from "workers-ai-provider";
import {
  callable,
  routeAgentRequest,
  type FiberContext,
  type FiberRecoveryContext,
  type FiberRecoveryResult
} from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  generateText,
  Output,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import {
  initialSwarmState,
  type SwarmRecoverySnapshot,
  type SwarmRunState,
  type SwarmState,
  type SwarmWorkUnitInput,
  type SwarmWorkUnitState,
  type WorkerOutput,
  type WorkerRecoverySnapshot
} from "./swarm/types";

const SWARM_FIBER_NAME = "swarm-run";
const SWARM_WORKER_FIBER_NAME = "swarm-worker";
const SWARM_MODEL = "@cf/moonshotai/kimi-k2.6";
const MAX_GOAL_LENGTH = 4_000;
const MAX_WORK_UNITS = 6;
const MAX_ACTIVE_SWARMS = 3;
const WORKER_POLL_INTERVAL_MS = 500;
const SETTLED_FIBER_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const WorkUnitInputSchema = z.object({
  title: z.string().min(1).max(120),
  role: z.string().min(1).max(80),
  objective: z.string().min(1).max(600),
  prompt: z.string().min(1).max(2_000),
  expectedOutput: z.string().min(1).max(600)
});

const WorkerOutputSchema = z.object({
  answer: z.string(),
  keyFindings: z.array(z.string()).max(8),
  confidence: z.enum(["low", "medium", "high"])
});

const SynthesisSchema = z.object({
  headline: z.string(),
  answer: z.string(),
  markdown: z.string()
});

export class ChatAgent extends AIChatAgent<Env, SwarmState> {
  initialState: SwarmState = initialSwarmState;
  maxPersistedMessages = 100;

  onStart() {
    this.migrateLegacySwarmState();

    // Configure OAuth popup behavior for MCP servers that require authentication.
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async startSwarm(
    input: { goal: string; workUnits: SwarmWorkUnitInput[] },
    clientRunId?: string
  ) {
    const trimmedGoal = input.goal.trim();
    if (!trimmedGoal) throw new Error("Swarm goal is required");
    if (trimmedGoal.length > MAX_GOAL_LENGTH) {
      throw new Error(
        `Swarm goal must be ${MAX_GOAL_LENGTH} characters or fewer`
      );
    }

    const parsedWorkUnits = z
      .array(WorkUnitInputSchema)
      .min(1)
      .max(MAX_WORK_UNITS)
      .parse(input.workUnits);

    const runId = clientRunId ?? crypto.randomUUID();

    await this.cleanupSettledFibers();

    const existing = await this.inspectFiberByKey(`swarm:${runId}`);
    if (existing) {
      return {
        runId,
        accepted: false,
        fiberId: existing?.fiberId,
        status: existing?.status,
        message:
          "Swarm run was already accepted. Do not answer the original goal yet; the coordinator will post the final synthesis when complete."
      };
    }

    if (this.countActiveSwarms() >= MAX_ACTIVE_SWARMS) {
      return {
        runId,
        accepted: false,
        status: "rejected",
        message: `Too many swarms are already active. Wait for one to finish before starting another.`
      };
    }

    const startedAt = new Date().toISOString();
    const initialRun = this.createRunState(
      runId,
      trimmedGoal,
      parsedWorkUnits,
      startedAt
    );
    this.setRunState(initialRun, { select: true });

    let receipt;
    try {
      receipt = await this.startFiber(
        SWARM_FIBER_NAME,
        (ctx) =>
          this.executeSwarmRun(
            ctx,
            runId,
            trimmedGoal,
            parsedWorkUnits,
            startedAt
          ),
        {
          idempotencyKey: `swarm:${runId}`,
          metadata: { runId, goal: trimmedGoal, model: SWARM_MODEL }
        }
      );
    } catch (error) {
      this.setRunState({
        ...initialRun,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString()
      });
      throw error;
    }

    return {
      runId,
      accepted: receipt.accepted,
      fiberId: receipt.fiberId,
      status: receipt.status,
      message: receipt.accepted
        ? "Swarm run accepted. Do not answer the original goal yet; the coordinator will post the final synthesis when complete."
        : "Swarm run was already accepted. Do not answer the original goal yet; the coordinator will post the final synthesis when complete."
    };
  }

  @callable()
  async cancelSwarm(runId: string) {
    const cancelled = await this.cancelFiberByKey(
      `swarm:${runId}`,
      "User cancelled"
    );
    const run = this.state.runs[runId];
    if (run) {
      await this.cancelWorkerFibers(runId, run.workUnits);
      const workUnits = run.workUnits.map((unit) =>
        unit.status === "queued" || unit.status === "running"
          ? { ...unit, status: "cancelled" as const }
          : unit
      );
      this.setRunState({
        ...run,
        status: "cancelled",
        progress: this.countProgress(workUnits),
        workUnits,
        completedAt: new Date().toISOString()
      });
      await this.cleanupSettledFibers();
    }
    return { cancelled };
  }

  @callable()
  async inspectSwarm(runId: string) {
    const run = await this.inspectFiberByKey(`swarm:${runId}`);
    const snapshot = run?.snapshot as SwarmRecoverySnapshot | undefined;
    const workers = await Promise.all(
      snapshot?.workUnits.map(async (unit) => ({
        workUnitId: unit.id,
        fiber: await this.inspectFiberByKey(this.workerFiberKey(runId, unit.id))
      })) ?? []
    );

    return { run, workers };
  }

  @callable()
  async clearSwarms() {
    const runs = Object.values(this.state.runs ?? {});
    const retainedSwarmFibers = await Promise.all([
      this.listFibers({ name: SWARM_FIBER_NAME, limit: 500 }),
      this.listFibers({ name: SWARM_WORKER_FIBER_NAME, limit: 500 })
    ]);
    const retainedFiberIds = new Set(
      retainedSwarmFibers.flat().map((fiber) => fiber.fiberId)
    );

    await Promise.allSettled([
      ...runs.map(async (run) => {
        if (!["planning", "running", "synthesizing"].includes(run.status)) {
          return;
        }
        await this.cancelFiberByKey(
          `swarm:${run.runId}`,
          "User cleared swarms"
        );
        await this.cancelWorkerFibers(run.runId, run.workUnits);
      }),
      ...Array.from(retainedFiberIds).map((fiberId) =>
        this.cancelFiber(fiberId, "User cleared swarms")
      )
    ]);

    this.setState({
      ...this.state,
      runs: {},
      selectedRunId: undefined
    });

    this.sql`
      DELETE FROM cf_agents_fibers
      WHERE name IN (${SWARM_FIBER_NAME}, ${SWARM_WORKER_FIBER_NAME})
         OR idempotency_key LIKE 'swarm:%'
    `;

    return { cleared: runs.length, fibersDeleted: retainedFiberIds.size };
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = await this.getFiberAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a helpful assistant that can understand images. When users share images, describe what you see and answer questions about them.

When a user's request is broad enough to benefit from parallel specialist work, call startSwarm automatically instead of asking for permission or telling the user to click anything. Good swarm candidates include architecture decisions, implementation planning, multi-source research, substantial debugging, trade-off analysis, and critique from multiple perspectives. When calling startSwarm, assign 2-6 independent work units with concrete roles and prompts. Do not use startSwarm for simple factual questions, quick edits, or ordinary conversation.

When you call startSwarm, do not answer the original goal yourself. The swarm runs asynchronously and the coordinator will post the final synthesis as a separate assistant message when complete. After starting a swarm, only briefly acknowledge that the swarm has started.`,
      // Prune old tool calls to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        ...mcpTools,

        startSwarm: tool({
          description:
            "Start a bounded agent swarm for broad goals that benefit from parallel investigation, comparison, planning, critique, or multiple specialist perspectives. You must assign concrete work units for the swarm. Do not use for simple factual questions or short conversational replies.",
          inputSchema: z.object({
            goal: z
              .string()
              .describe("The user's goal to decompose into swarm work units."),
            reason: z
              .string()
              .describe(
                "Why this goal benefits from a swarm instead of a direct answer."
              ),
            workUnits: z
              .array(WorkUnitInputSchema)
              .min(1)
              .max(MAX_WORK_UNITS)
              .describe(
                "Independent work units to run in parallel. Each unit should be narrow, useful on its own, and not depend on another unit."
              )
          }),
          execute: async ({ goal, workUnits }) => {
            const lastUserMessage = [...this.messages]
              .reverse()
              .find((message) => message.role === "user");
            const clientRunId = lastUserMessage
              ? `chat-${lastUserMessage.id}`
              : undefined;

            return await this.startSwarm({ goal, workUnits }, clientRunId);
          }
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async onFiberRecovered(
    ctx: FiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    if (ctx.name === SWARM_WORKER_FIBER_NAME) {
      return {
        status: "interrupted",
        reason: "Worker fiber interrupted before completion.",
        snapshot: ctx.snapshot
      };
    }

    if (ctx.name !== SWARM_FIBER_NAME) return;

    const snapshot = ctx.snapshot as SwarmRecoverySnapshot | null;
    if (!snapshot) {
      this.setRunState({
        runId:
          typeof ctx.metadata?.runId === "string" ? ctx.metadata.runId : ctx.id,
        status: "failed",
        model: SWARM_MODEL,
        progress: this.countProgress([]),
        workUnits: [],
        error:
          "Swarm run was interrupted before it created a recovery snapshot.",
        completedAt: new Date().toISOString()
      });
      await this.cleanupSettledFibers();
      return {
        status: "interrupted",
        reason: "Swarm run interrupted before checkpoint."
      };
    }

    this.setRunState(
      this.snapshotToRunState({
        ...snapshot,
        status: "failed",
        error: "Swarm run was interrupted and safely marked for inspection.",
        completedAt: new Date().toISOString(),
        workUnits: snapshot.workUnits.map((unit) =>
          unit.status === "running" || unit.status === "queued"
            ? {
                ...unit,
                status: "failed" as const,
                error: "Interrupted before completion; inspect before retrying."
              }
            : unit
        )
      })
    );

    await this.cleanupSettledFibers();

    return {
      status: "interrupted",
      reason: "Coordinator fiber interrupted before completion.",
      snapshot
    };
  }

  private async executeSwarmRun(
    ctx: FiberContext,
    runId: string,
    goal: string,
    workUnitInputs: SwarmWorkUnitInput[],
    startedAt = new Date().toISOString()
  ) {
    const workUnits = this.createWorkUnits(runId, workUnitInputs);

    const commit = (
      phase: SwarmRecoverySnapshot["phase"],
      status: SwarmRecoverySnapshot["status"],
      extra: Partial<SwarmRecoverySnapshot> = {}
    ) => {
      const snapshot: SwarmRecoverySnapshot = {
        runId,
        goal,
        phase,
        status,
        workUnits: workUnits.map((unit) => ({ ...unit })),
        startedAt,
        ...extra
      };
      ctx.stash(snapshot);
      if (this.state.runs?.[runId]) {
        this.setRunState(this.snapshotToRunState(snapshot));
      }
      return snapshot;
    };

    try {
      commit("planned", "planning");

      for (const unit of workUnits) {
        unit.status = "running";
        unit.startedAt = new Date().toISOString();
        await this.startFiber(
          SWARM_WORKER_FIBER_NAME,
          (workerCtx) =>
            this.executeWorkerFiber(
              workerCtx,
              runId,
              goal,
              unit,
              workUnitInputs[Number(unit.id.split(":unit:")[1])]
            ),
          {
            idempotencyKey: this.workerFiberKey(runId, unit.id),
            metadata: { runId, workUnitId: unit.id, goal }
          }
        );
      }

      commit("running", "running");

      while (!this.allWorkUnitsSettled(workUnits)) {
        if (ctx.signal.aborted) {
          await this.cancelWorkerFibers(runId, workUnits);
          for (const unit of workUnits) {
            if (unit.status === "queued" || unit.status === "running") {
              unit.status = "cancelled";
              unit.completedAt = new Date().toISOString();
            }
          }
          commit("running", "cancelled", {
            completedAt: new Date().toISOString()
          });
          await this.cleanupSettledFibers();
          return;
        }

        const changed = await this.refreshWorkerStatuses(runId, workUnits);
        if (changed) commit("running", "running");
        await this.abortableDelay(WORKER_POLL_INTERVAL_MS, ctx.signal);
      }

      if (workUnits.every((unit) => unit.status !== "complete")) {
        commit("running", "failed", {
          error: "All swarm workers failed.",
          completedAt: new Date().toISOString()
        });
        await this.cleanupSettledFibers();
        return;
      }

      commit("synthesizing", "synthesizing");
      const synthesis = await this.synthesizeRun(goal, workUnits, ctx.signal);

      if (ctx.signal.aborted) {
        commit("synthesizing", "cancelled", {
          completedAt: new Date().toISOString()
        });
        await this.cleanupSettledFibers();
        return;
      }

      commit("complete", "complete", {
        completedAt: new Date().toISOString(),
        synthesis
      });
      if (!this.state.runs?.[runId]) return;
      await this.persistSwarmFollowupMessage(runId, synthesis);
      await this.cleanupSettledFibers();
    } catch (error) {
      if (ctx.signal.aborted) {
        await this.cancelWorkerFibers(runId, workUnits);
        commit("running", "cancelled", {
          completedAt: new Date().toISOString()
        });
        await this.cleanupSettledFibers();
        return;
      }

      commit("running", "failed", {
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString()
      });
      await this.cleanupSettledFibers();
      throw error;
    }
  }

  private async executeWorkerFiber(
    ctx: FiberContext,
    runId: string,
    goal: string,
    unit: SwarmWorkUnitState,
    input: SwarmWorkUnitInput
  ) {
    const startedAt = new Date().toISOString();
    const commit = (snapshot: WorkerRecoverySnapshot) => ctx.stash(snapshot);
    const tools = await this.getFiberAITools();

    try {
      commit({
        runId,
        workUnitId: unit.id,
        status: "running",
        startedAt
      });

      const result = await generateText({
        model: this.getSwarmModel(),
        system:
          "You are a focused swarm worker. Complete only your assigned work unit. Return concise, evidence-aware structured output.",
        prompt: `Goal:\n${goal}\n\nRole:\n${input.role}\n\nObjective:\n${input.objective}\n\nTask:\n${input.prompt}\n\nExpected output:\n${input.expectedOutput}`,
        tools,
        stopWhen: stepCountIs(5),
        output: Output.object({ schema: WorkerOutputSchema }),
        abortSignal: ctx.signal
      });

      const workerOutput = result.output as WorkerOutput;
      commit({
        runId,
        workUnitId: unit.id,
        status: "complete",
        output: workerOutput,
        summary: workerOutput.answer.slice(0, 300),
        startedAt,
        completedAt: new Date().toISOString()
      });
    } catch (error) {
      commit({
        runId,
        workUnitId: unit.id,
        status: ctx.signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: new Date().toISOString()
      });
      if (!ctx.signal.aborted) throw error;
    }
  }

  private async synthesizeRun(
    goal: string,
    workUnits: SwarmWorkUnitState[],
    signal: AbortSignal
  ) {
    const tools = await this.getFiberAITools();
    const result = await generateText({
      model: this.getSwarmModel(),
      system:
        "You are the coordinator synthesizing a swarm's worker outputs into one useful final answer. Mention disagreements, uncertainty, and failed workers when relevant.",
      prompt: `Goal:\n${goal}\n\nWorker results:\n${JSON.stringify(
        workUnits.map((unit) => ({
          title: unit.title,
          role: unit.role,
          status: unit.status,
          output: unit.output,
          error: unit.error
        })),
        null,
        2
      )}`,
      tools,
      stopWhen: stepCountIs(5),
      output: Output.object({ schema: SynthesisSchema }),
      abortSignal: signal
    });

    return result.output;
  }

  private async persistSwarmFollowupMessage(
    runId: string,
    synthesis: NonNullable<SwarmRunState["synthesis"]>
  ) {
    const messageId = `swarm-followup-${runId}`;
    await this.waitUntilStable({ timeout: 30_000 });

    if (!this.state.runs?.[runId]) return;

    if (this.messages.some((message) => message.id === messageId)) return;

    await this.persistMessages([
      ...this.messages,
      {
        id: messageId,
        role: "assistant",
        parts: [{ type: "text", text: synthesis.markdown }]
      }
    ]);
  }

  private getSwarmModel() {
    return createWorkersAI({ binding: this.env.AI })(SWARM_MODEL, {
      sessionAffinity: this.sessionAffinity
    });
  }

  private async getFiberAITools() {
    await this.mcp.waitForConnections({ timeout: 10_000 });
    return this.mcp.getAITools();
  }

  private createWorkUnits(
    runId: string,
    workUnitInputs: SwarmWorkUnitInput[]
  ): SwarmWorkUnitState[] {
    return workUnitInputs.map((unit, index) => ({
      id: `${runId}:unit:${index}`,
      title: unit.title,
      role: unit.role,
      objective: unit.objective,
      expectedOutput: unit.expectedOutput,
      status: "queued" as const
    }));
  }

  private createRunState(
    runId: string,
    goal: string,
    workUnitInputs: SwarmWorkUnitInput[],
    startedAt: string
  ): SwarmRunState {
    const workUnits = this.createWorkUnits(runId, workUnitInputs);
    return {
      runId,
      status: "planning",
      goal,
      model: SWARM_MODEL,
      progress: this.countProgress(workUnits),
      workUnits,
      startedAt
    };
  }

  private snapshotToRunState(snapshot: SwarmRecoverySnapshot): SwarmRunState {
    return {
      runId: snapshot.runId,
      status: snapshot.status,
      goal: snapshot.goal,
      model: SWARM_MODEL,
      progress: this.countProgress(snapshot.workUnits),
      workUnits: snapshot.workUnits,
      synthesis: snapshot.synthesis,
      error: snapshot.error,
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt
    };
  }

  private setRunState(run: SwarmRunState, options: { select?: boolean } = {}) {
    const runs = this.state.runs ?? {};
    this.setState({
      ...this.state,
      runs: {
        ...runs,
        [run.runId]: run
      },
      selectedRunId:
        options.select || !this.state.selectedRunId
          ? run.runId
          : this.state.selectedRunId
    });
  }

  private migrateLegacySwarmState() {
    const state = this.state as SwarmState &
      Partial<SwarmRunState> & { activeRunId?: string };
    if (state.runs) return;

    if (!state.status || state.status === "idle") {
      this.setState(initialSwarmState);
      return;
    }

    const runId = state.activeRunId ?? crypto.randomUUID();
    this.setState({
      runs: {
        [runId]: {
          runId,
          status: state.status,
          goal: state.goal,
          model: state.model ?? SWARM_MODEL,
          progress: state.progress ?? this.countProgress(state.workUnits ?? []),
          workUnits: state.workUnits ?? [],
          synthesis: state.synthesis,
          error: state.error,
          startedAt: state.startedAt,
          completedAt: state.completedAt
        }
      },
      selectedRunId: runId
    });
  }

  private workerFiberKey(runId: string, workUnitId: string) {
    return `swarm:${runId}:worker:${workUnitId}`;
  }

  private allWorkUnitsSettled(workUnits: SwarmWorkUnitState[]) {
    return workUnits.every((unit) =>
      ["complete", "failed", "cancelled"].includes(unit.status)
    );
  }

  private countActiveSwarms() {
    return Object.values(this.state.runs ?? {}).filter((run) =>
      ["planning", "running", "synthesizing"].includes(run.status)
    ).length;
  }

  private async refreshWorkerStatuses(
    runId: string,
    workUnits: SwarmWorkUnitState[]
  ) {
    let changed = false;

    for (const unit of workUnits) {
      if (["complete", "failed", "cancelled"].includes(unit.status)) continue;

      const fiber = await this.inspectFiberByKey(
        this.workerFiberKey(runId, unit.id)
      );
      const snapshot = fiber?.snapshot as WorkerRecoverySnapshot | undefined;

      if (snapshot?.status) {
        if (
          unit.status !== snapshot.status ||
          unit.summary !== snapshot.summary ||
          unit.error !== snapshot.error ||
          unit.completedAt !== snapshot.completedAt
        ) {
          changed = true;
        }
        unit.status = snapshot.status;
        unit.output = snapshot.output;
        unit.summary = snapshot.summary;
        unit.error = snapshot.error;
        unit.completedAt = snapshot.completedAt;
      } else if (fiber?.status === "error" || fiber?.status === "interrupted") {
        changed = true;
        unit.status = "failed";
        unit.error = fiber.error ?? `Worker fiber ${fiber.status}`;
        unit.completedAt = new Date().toISOString();
      } else if (fiber?.status === "aborted") {
        changed = true;
        unit.status = "cancelled";
        unit.completedAt = new Date().toISOString();
      }
    }

    return changed;
  }

  private async cleanupSettledFibers() {
    try {
      await this.deleteFibers({
        status: ["completed", "error", "aborted"],
        settledBefore: new Date(Date.now() - SETTLED_FIBER_RETENTION_MS),
        limit: 100
      });
    } catch (error) {
      console.warn("Failed to clean up settled swarm fibers", error);
    }
  }

  private async cancelWorkerFibers(
    runId: string,
    workUnits: SwarmWorkUnitState[]
  ) {
    await Promise.all(
      workUnits.map((unit) =>
        this.cancelFiberByKey(
          this.workerFiberKey(runId, unit.id),
          "Coordinator cancelled"
        )
      )
    );
  }

  private countProgress(workUnits: SwarmWorkUnitState[]) {
    return {
      total: workUnits.length,
      queued: workUnits.filter((unit) => unit.status === "queued").length,
      running: workUnits.filter((unit) => unit.status === "running").length,
      complete: workUnits.filter((unit) => unit.status === "complete").length,
      failed: workUnits.filter((unit) => unit.status === "failed").length
    };
  }

  private abortableDelay(ms: number, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(new Error("Swarm run cancelled"));

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Swarm run cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
