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
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./artifacts/memory-fs";
import {
  initialSwarmState,
  type SwarmRecoverySnapshot,
  type SwarmRunState,
  type SwarmState,
  type SwarmWorkUnitInput,
  type SwarmWorkUnitState,
  type RepositorySource,
  type WorkerOutput,
  type WorkerRecoverySnapshot
} from "./swarm/types";

const EMPLOYEE_TASK_FIBER_NAME = "employee-task";
const COMPANY_SYNTHESIS_FIBER_NAME = "company-synthesis";
const SWARM_MODEL = "@cf/moonshotai/kimi-k2.6";
const MAX_GOAL_LENGTH = 4_000;
const MAX_WORK_UNITS = 6;
const MAX_ACTIVE_SWARMS = 3;
const SETTLED_FIBER_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const ARTIFACT_REPO_NAME_MAX_LENGTH = 80;
const ARTIFACT_WORK_DIR = "/workspace";
const MAX_FILE_CHANGES = 6;
const MAX_FILE_CHANGE_BYTES = 30_000;

const WorkUnitInputSchema = z.object({
  title: z.string().min(1).max(120),
  role: z.string().min(1).max(80),
  employeeName: z.string().min(1).max(80).optional(),
  objective: z.string().min(1).max(600),
  prompt: z.string().min(1).max(2_000),
  expectedOutput: z.string().min(1).max(600)
});

const RepositorySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new") }),
  z.object({
    kind: z.literal("import"),
    url: z.string().url().max(2_000),
    branch: z.string().min(1).max(200).optional(),
    depth: z.number().int().positive().max(10_000).optional()
  })
]);

const WorkerOutputSchema = z.object({
  answer: z.string(),
  keyFindings: z.array(z.string()).max(8),
  deliverables: z.array(z.string()).max(8).optional(),
  decisions: z.array(z.string()).max(8).optional(),
  openQuestions: z.array(z.string()).max(8).optional(),
  risks: z.array(z.string()).max(8).optional(),
  fileChanges: z
    .array(
      z.object({
        path: z.string().min(1).max(240),
        content: z.string().max(MAX_FILE_CHANGE_BYTES),
        summary: z.string().max(300).optional()
      })
    )
    .max(MAX_FILE_CHANGES)
    .optional(),
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
  async startCompanyRun(
    input: {
      goal: string;
      workUnits: SwarmWorkUnitInput[];
      repositorySource?: RepositorySource;
    },
    clientRunId?: string
  ) {
    return await this.startSwarm(input, clientRunId);
  }

  @callable()
  async startSwarm(
    input: {
      goal: string;
      workUnits: SwarmWorkUnitInput[];
      repositorySource?: RepositorySource;
    },
    clientRunId?: string
  ) {
    const trimmedGoal = input.goal.trim();
    if (!trimmedGoal) throw new Error("Company goal is required");
    if (trimmedGoal.length > MAX_GOAL_LENGTH) {
      throw new Error(
        `Company goal must be ${MAX_GOAL_LENGTH} characters or fewer`
      );
    }

    const parsedWorkUnits = z
      .array(WorkUnitInputSchema)
      .min(1)
      .max(MAX_WORK_UNITS)
      .parse(input.workUnits);
    const repositorySource = input.repositorySource
      ? RepositorySourceSchema.parse(input.repositorySource)
      : ({ kind: "new" } as const);

    const runId = clientRunId ?? crypto.randomUUID();

    await this.cleanupSettledFibers();

    const existing = this.state.runs?.[runId];
    if (existing) {
      return {
        runId,
        accepted: false,
        status: existing.status,
        message:
          "Company run was already accepted. Do not answer the original goal yet; the agent company will post the final synthesis when complete."
      };
    }

    if (this.countActiveCompanyRuns() >= MAX_ACTIVE_SWARMS) {
      return {
        runId,
        accepted: false,
        status: "rejected",
        message: `Too many company runs are already active. Wait for one to finish before starting another.`
      };
    }

    const startedAt = new Date().toISOString();
    const initialRun = this.createRunState(
      runId,
      trimmedGoal,
      parsedWorkUnits,
      repositorySource,
      startedAt
    );
    this.setRunState(initialRun, { select: true });

    let receipt;
    try {
      await this.ensureRunRepository(runId, trimmedGoal, repositorySource);
      receipt = await this.startEmployeeTaskFibers(
        runId,
        trimmedGoal,
        parsedWorkUnits
      );
    } catch (error) {
      const current = this.state.runs?.[runId] ?? initialRun;
      this.setRunState({
        ...current,
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
      repository: this.state.runs[runId]?.repository,
      message: receipt.accepted
        ? "Company run accepted. Do not answer the original goal yet; the hired employees will complete their tasks and the company will post the final synthesis when complete."
        : "Company run was already accepted. Do not answer the original goal yet; the company will post the final synthesis when complete."
    };
  }

  @callable()
  async cancelSwarm(runId: string) {
    const synthesisCancelled = await this.cancelFiberByKey(
      this.synthesisFiberKey(runId),
      "User cancelled"
    );
    const run = this.state.runs[runId];
    let employeeTasksCancelled = false;
    if (run) {
      employeeTasksCancelled = await this.cancelWorkerFibers(
        runId,
        run.workUnits
      );
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
    return { cancelled: synthesisCancelled || employeeTasksCancelled };
  }

  @callable()
  async inspectSwarm(runId: string) {
    const synthesis = await this.inspectFiberByKey(
      this.synthesisFiberKey(runId)
    );
    const workers = await Promise.all(
      this.state.runs[runId]?.workUnits.map(async (unit) => ({
        workUnitId: unit.id,
        fiber: await this.inspectFiberByKey(this.workerFiberKey(runId, unit.id))
      })) ?? []
    );

    return { run: synthesis, synthesis, workers };
  }

  @callable()
  async clearSwarms() {
    const runs = Object.values(this.state.runs ?? {});
    const retainedSwarmFibers = await Promise.all([
      this.listFibers({ name: EMPLOYEE_TASK_FIBER_NAME, limit: 500 }),
      this.listFibers({ name: COMPANY_SYNTHESIS_FIBER_NAME, limit: 500 })
    ]);

    await Promise.allSettled([
      ...runs.map(async (run) => {
        await this.cancelFiberByKey(
          this.synthesisFiberKey(run.runId),
          "User cleared swarms"
        );
        await this.cancelWorkerFibers(run.runId, run.workUnits);
      }),
      ...retainedSwarmFibers
        .flat()
        .map((fiber) => this.cancelFiber(fiber.fiberId, "User cleared swarms"))
    ]);

    this.setState({
      ...this.state,
      runs: {},
      selectedRunId: undefined
    });

    const fibersDeleted = await this.deleteAllTerminalFibers();

    return { cleared: runs.length, fibersDeleted };
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const aiTools = await this.getFiberAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a helpful assistant that can understand images. When users share images, describe what you see and answer questions about them.

When a user's request is broad enough to benefit from an agent company, call startCompanyRun automatically instead of asking for permission or telling the user to click anything. Good company-run candidates include architecture decisions, implementation planning, multi-source research, substantial debugging, trade-off analysis, and critique from multiple perspectives. When calling startCompanyRun, hire 2-6 task-scoped employees with concrete roles, objectives, and prompts. Each employee exists for one task. Do not use startCompanyRun for simple factual questions, quick edits, or ordinary conversation.

If the user provides a public HTTPS Git repository URL, treat this as an existing product. Set repositorySource to { kind: "import", url } when starting the company run. Otherwise omit repositorySource or use { kind: "new" } for a new product.

When you call startCompanyRun, do not answer the original goal yourself. The company run executes asynchronously and the ChatAgent will post the final synthesis as a separate assistant message when complete. After starting a company run, only briefly acknowledge that the company has started work.`,
      // Prune old tool calls to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        ...aiTools,

        startCompanyRun: tool({
          description:
            "Start a bounded agent company run for broad goals that benefit from parallel investigation, comparison, planning, critique, or multiple specialist perspectives. You must hire concrete task-scoped employees. Do not use for simple factual questions or short conversational replies.",
          inputSchema: z.object({
            goal: z
              .string()
              .describe("The user's goal to decompose into employee tasks."),
            reason: z
              .string()
              .describe(
                "Why this goal benefits from an agent company instead of a direct answer."
              ),
            workUnits: z
              .array(WorkUnitInputSchema)
              .min(1)
              .max(MAX_WORK_UNITS)
              .describe(
                "Independent employee tasks to run in parallel. Each employee task should be narrow, useful on its own, and not depend on another task."
              ),
            repositorySource: RepositorySourceSchema.optional().describe(
              "Use { kind: 'import', url } when the user provides an existing public HTTPS Git repository. Use { kind: 'new' } or omit for a new product."
            )
          }),
          execute: async ({ goal, workUnits, repositorySource }) => {
            const lastUserMessage = [...this.messages]
              .reverse()
              .find((message) => message.role === "user");
            const clientRunId = lastUserMessage
              ? `chat-${lastUserMessage.id}`
              : undefined;

            return await this.startCompanyRun(
              { goal, workUnits, repositorySource },
              clientRunId
            );
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
    if (ctx.name === EMPLOYEE_TASK_FIBER_NAME) {
      const snapshot = ctx.snapshot as WorkerRecoverySnapshot | null;
      if (snapshot) {
        this.setWorkUnitStateFromSnapshot({
          ...snapshot,
          status:
            snapshot.status === "running" || snapshot.status === "queued"
              ? "failed"
              : snapshot.status,
          error:
            snapshot.error ??
            "Employee task was interrupted and safely marked for inspection.",
          completedAt: snapshot.completedAt ?? new Date().toISOString()
        });
        await this.maybeFinalizeCompanyRun(snapshot.runId);
      }
      return {
        status: "interrupted",
        reason: "Employee task fiber interrupted before completion.",
        snapshot: ctx.snapshot
      };
    }

    if (ctx.name !== COMPANY_SYNTHESIS_FIBER_NAME) return;

    const snapshot = ctx.snapshot as SwarmRecoverySnapshot | null;
    if (!snapshot) {
      const runId =
        typeof ctx.metadata?.runId === "string" ? ctx.metadata.runId : ctx.id;
      const current = this.state.runs?.[runId];
      this.setRunState({
        runId,
        status: "failed",
        model: SWARM_MODEL,
        progress: current?.progress ?? this.countProgress([]),
        workUnits: current?.workUnits ?? [],
        goal: current?.goal,
        error:
          "Company synthesis was interrupted before it created a recovery snapshot.",
        startedAt: current?.startedAt,
        completedAt: new Date().toISOString()
      });
      await this.cleanupSettledFibers();
      return {
        status: "interrupted",
        reason: "Company synthesis interrupted before checkpoint."
      };
    }

    this.setRunState(
      this.snapshotToRunState({
        ...snapshot,
        status: "failed",
        error:
          "Company synthesis was interrupted and safely marked for inspection.",
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
      reason: "Company synthesis fiber interrupted before completion.",
      snapshot
    };
  }

  private async startEmployeeTaskFibers(
    runId: string,
    goal: string,
    workUnitInputs: SwarmWorkUnitInput[]
  ) {
    const run = this.state.runs[runId];
    if (!run) throw new Error(`Company run ${runId} was not initialized`);

    let firstReceipt;
    const workUnits = run.workUnits.map((unit) => ({ ...unit }));

    for (const [index, unit] of workUnits.entries()) {
      unit.status = "running";
      unit.startedAt = new Date().toISOString();
      this.setWorkUnitState(runId, unit);

      const receipt = await this.startFiber(
        EMPLOYEE_TASK_FIBER_NAME,
        (workerCtx) =>
          this.executeWorkerFiber(
            workerCtx,
            runId,
            goal,
            unit.id,
            workUnitInputs[index]
          ),
        {
          idempotencyKey: this.workerFiberKey(runId, unit.id),
          metadata: { runId, workUnitId: unit.id, goal, role: unit.role }
        }
      );
      firstReceipt ??= receipt;
    }

    const current = this.state.runs[runId];
    if (current) {
      this.setRunState({
        ...current,
        status: "running",
        progress: this.countProgress(current.workUnits)
      });
    }

    return (
      firstReceipt ?? {
        accepted: false,
        fiberId: undefined,
        status: "completed"
      }
    );
  }

  private async executeWorkerFiber(
    ctx: FiberContext,
    runId: string,
    goal: string,
    workUnitId: string,
    input: SwarmWorkUnitInput
  ) {
    const startedAt = new Date().toISOString();
    const commit = (snapshot: WorkerRecoverySnapshot) => {
      ctx.stash(snapshot);
      this.setWorkUnitStateFromSnapshot(snapshot);
    };
    const tools = await this.getFiberAITools();
    let thrown: unknown;

    try {
      commit({
        runId,
        workUnitId,
        status: "running",
        startedAt
      });

      const result = await generateText({
        model: this.getSwarmModel(),
        system:
          "You are a task-scoped employee in an agent company. Complete only your assigned job. Be concise, evidence-aware, and explicit about decisions, risks, open questions, and deliverables. If you are an engineering employee and your task requires code changes, return complete file contents in fileChanges for a small number of files. Do not include fileChanges unless you are confident they should be committed.",
        prompt: `Company goal:\n${goal}\n\n${this.repositoryPromptContext(runId)}\n\nEmployee:${input.employeeName ? `\n${input.employeeName}` : ""}\n\nRole:\n${input.role}\n\nObjective:\n${input.objective}\n\nTask:\n${input.prompt}\n\nExpected output:\n${input.expectedOutput}`,
        tools,
        stopWhen: stepCountIs(5),
        output: Output.object({ schema: WorkerOutputSchema }),
        abortSignal: ctx.signal
      });

      const workerOutput = { ...(result.output as WorkerOutput) };
      const codeCommit = await this.commitEmployeeFileChanges(
        runId,
        input,
        workerOutput
      );
      if (codeCommit) workerOutput.commit = codeCommit;
      commit({
        runId,
        workUnitId,
        status: "complete",
        output: workerOutput,
        summary: workerOutput.answer.slice(0, 300),
        startedAt,
        completedAt: new Date().toISOString()
      });
    } catch (error) {
      thrown = error;
      commit({
        runId,
        workUnitId,
        status: ctx.signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: new Date().toISOString()
      });
    } finally {
      await this.maybeFinalizeCompanyRun(runId);
    }

    if (thrown && !ctx.signal.aborted) throw thrown;
  }

  private async executeSynthesisFiber(ctx: FiberContext, runId: string) {
    const run = this.state.runs[runId];
    if (!run) return;

    const commit = (
      phase: SwarmRecoverySnapshot["phase"],
      status: SwarmRecoverySnapshot["status"],
      extra: Partial<SwarmRecoverySnapshot> = {}
    ) => {
      const current = this.state.runs[runId] ?? run;
      const snapshot: SwarmRecoverySnapshot = {
        runId,
        goal: current.goal ?? "",
        phase,
        status,
        workUnits: current.workUnits.map((unit) => ({ ...unit })),
        startedAt: current.startedAt ?? new Date().toISOString(),
        ...extra
      };
      ctx.stash(snapshot);
      if (this.state.runs?.[runId]) {
        this.setRunState(this.snapshotToRunState(snapshot));
      }
      return snapshot;
    };

    try {
      commit("synthesizing", "synthesizing");
      const latest = this.state.runs[runId];
      if (!latest) return;

      const synthesis = await this.synthesizeRun(
        latest.goal ?? "",
        latest.workUnits,
        ctx.signal
      );

      if (ctx.signal.aborted) {
        commit("synthesizing", "cancelled", {
          completedAt: new Date().toISOString()
        });
        await this.cleanupSettledFibers();
        return;
      }
      if (this.state.runs[runId]?.status === "cancelled") return;

      commit("complete", "complete", {
        completedAt: new Date().toISOString(),
        synthesis
      });
      if (!this.state.runs?.[runId]) return;
      await this.persistSwarmFollowupMessage(runId, synthesis);
      await this.cleanupSettledFibers();
    } catch (error) {
      if (ctx.signal.aborted) {
        commit("synthesizing", "cancelled", {
          completedAt: new Date().toISOString()
        });
        await this.cleanupSettledFibers();
        return;
      }

      commit("synthesizing", "failed", {
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString()
      });
      await this.cleanupSettledFibers();
      throw error;
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
        "You are ChatAgent synthesizing an agent company's employee task outputs into one useful final answer for the user. Mention disagreements, uncertainty, failed employees, decisions, risks, and recommended next steps when relevant.",
      prompt: `Company goal:\n${goal}\n\nEmployee results:\n${JSON.stringify(
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
    return await this.mcp.getAITools();
  }

  private repositoryPromptContext(runId: string) {
    const repository = this.state.runs?.[runId]?.repository;
    if (!repository) return "Repository: none";

    const lines = [
      "Repository:",
      `- source: ${repository.source.kind}`,
      `- artifact repo: ${repository.name}`,
      `- status: ${repository.status}`
    ];

    if (repository.defaultBranch) {
      lines.push(`- default branch: ${repository.defaultBranch}`);
    }
    if (repository.source.kind === "import") {
      lines.push(`- source URL: ${repository.source.url}`);
    }
    return lines.join("\n");
  }

  private createWorkUnits(
    runId: string,
    workUnitInputs: SwarmWorkUnitInput[]
  ): SwarmWorkUnitState[] {
    return workUnitInputs.map((unit, index) => ({
      id: `${runId}:unit:${index}`,
      title: unit.title,
      role: unit.role,
      employeeName: unit.employeeName,
      objective: unit.objective,
      expectedOutput: unit.expectedOutput,
      status: "queued" as const
    }));
  }

  private createRunState(
    runId: string,
    goal: string,
    workUnitInputs: SwarmWorkUnitInput[],
    repositorySource: RepositorySource,
    startedAt: string
  ): SwarmRunState {
    const workUnits = this.createWorkUnits(runId, workUnitInputs);
    return {
      runId,
      status: "planning",
      goal,
      model: SWARM_MODEL,
      repository: {
        name: this.artifactRepoName(runId),
        remote: "",
        status: "creating",
        source: repositorySource
      },
      progress: this.countProgress(workUnits),
      workUnits,
      startedAt
    };
  }

  private async ensureRunRepository(
    runId: string,
    goal: string,
    repositorySource: RepositorySource
  ) {
    const run = this.state.runs?.[runId];
    if (!run) throw new Error(`Company run ${runId} was not initialized`);

    const repoName = run.repository?.name ?? this.artifactRepoName(runId);
    this.setRunState({
      ...run,
      repository: {
        name: repoName,
        remote: run.repository?.remote ?? "",
        defaultBranch: run.repository?.defaultBranch,
        status: "creating",
        source: repositorySource
      }
    });

    try {
      const created = await this.createOrImportArtifactRepo(
        repoName,
        goal,
        repositorySource
      );
      const current = this.state.runs?.[runId] ?? run;
      this.setRunState({
        ...current,
        repository: {
          name: created.name,
          remote: created.remote,
          defaultBranch: created.defaultBranch,
          status: "ready",
          source: repositorySource
        }
      });
    } catch (error) {
      const current = this.state.runs?.[runId] ?? run;
      this.setRunState({
        ...current,
        repository: {
          name: repoName,
          remote: current.repository?.remote ?? "",
          defaultBranch: current.repository?.defaultBranch,
          status: "failed",
          source: repositorySource,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    }
  }

  private async createOrImportArtifactRepo(
    repoName: string,
    goal: string,
    source: RepositorySource
  ) {
    try {
      if (source.kind === "import") {
        const imported = await this.env.ARTIFACTS.import({
          source: {
            url: source.url,
            branch: source.branch,
            depth: source.depth
          },
          target: {
            name: repoName,
            opts: {
              description: `Swarmflare imported company run: ${goal.slice(0, 180)}`,
              readOnly: false
            }
          }
        });
        return {
          name: imported.name,
          remote: imported.remote,
          defaultBranch: imported.defaultBranch,
          token: imported.token
        };
      }

      const created = await this.env.ARTIFACTS.create(repoName, {
        description: `Swarmflare company run: ${goal.slice(0, 180)}`,
        readOnly: false,
        setDefaultBranch: "main"
      });
      return this.artifactRepoMetadata(created);
    } catch (createError) {
      const existing = await this.env.ARTIFACTS.get(repoName).catch(() => {
        throw createError;
      });
      const token = await existing.createToken("write", 3600);
      return {
        ...this.artifactRepoMetadata(existing),
        token: token.plaintext
      };
    }
  }

  private artifactRepoMetadata(repo: {
    name: string;
    remote: string;
    defaultBranch?: string;
    token?: string;
  }) {
    return {
      name: repo.name,
      remote: repo.remote,
      defaultBranch: repo.defaultBranch,
      token: repo.token
    };
  }

  private async commitEmployeeFileChanges(
    runId: string,
    input: SwarmWorkUnitInput,
    output: WorkerOutput
  ) {
    if (!this.isEngineeringRole(input.role)) return undefined;
    if (!output.fileChanges?.length) return undefined;

    const run = this.state.runs?.[runId];
    const repository = run?.repository;
    if (!repository || repository.status !== "ready") return undefined;

    const changes = output.fileChanges.map((change) => ({
      ...change,
      path: this.normalizeRepoFilePath(change.path)
    }));

    const repo = await this.env.ARTIFACTS.get(repository.name);
    const token = await repo.createToken("write", 3600);
    const branch = repository.defaultBranch ?? "main";
    const fs = new MemoryFS();
    const auth = this.artifactGitAuth(token.plaintext);

    let cloned = false;
    try {
      await git.clone({
        fs,
        http,
        dir: ARTIFACT_WORK_DIR,
        url: repository.remote,
        ref: branch,
        singleBranch: true,
        depth: 1,
        onAuth: () => auth
      });
      cloned = true;
    } catch {
      await git.init({ fs, dir: ARTIFACT_WORK_DIR, defaultBranch: branch });
    }

    for (const change of changes) {
      await fs.promises.writeFile(
        `${ARTIFACT_WORK_DIR}/${change.path}`,
        change.content
      );
      await git.add({ fs, dir: ARTIFACT_WORK_DIR, filepath: change.path });
    }

    const sha = await git.commit({
      fs,
      dir: ARTIFACT_WORK_DIR,
      message: `${input.role}: ${input.title}`,
      author: {
        name: input.employeeName ?? input.role,
        email: "swarmflare@example.com"
      }
    });

    await git.push({
      fs,
      http,
      dir: ARTIFACT_WORK_DIR,
      url: repository.remote,
      ref: branch,
      remoteRef: branch,
      force: !cloned && repository.source.kind === "new",
      onAuth: () => auth
    });

    return { sha, files: changes.map((change) => change.path) };
  }

  private isEngineeringRole(role: string) {
    const normalized = role.toLowerCase();
    return (
      normalized.includes("engineer") ||
      normalized.includes("developer") ||
      normalized.includes("programmer")
    );
  }

  private normalizeRepoFilePath(path: string) {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") throw new Error("File changes cannot leave the repo");
      parts.push(part);
    }
    const normalized = parts.join("/");
    if (!normalized || normalized.startsWith(".git/")) {
      throw new Error("Invalid file change path");
    }
    return normalized;
  }

  private artifactGitAuth(token: string) {
    return {
      username: "x",
      password: token.split("?expires=")[0]
    };
  }

  private artifactRepoName(runId: string) {
    const safeRunId = this.sanitizeArtifactNamePart(runId);
    const base = safeRunId || crypto.randomUUID();
    const name = `company-${base}`.slice(0, ARTIFACT_REPO_NAME_MAX_LENGTH);

    return this.trimTrailingArtifactSeparators(name) || "company";
  }

  private sanitizeArtifactNamePart(value: string) {
    let result = "";
    let lastWasSeparator = false;

    for (const char of value.toLowerCase()) {
      const isLetter = char >= "a" && char <= "z";
      const isDigit = char >= "0" && char <= "9";
      const isSeparator = char === "." || char === "_" || char === "-";

      if (isLetter || isDigit) {
        result += char;
        lastWasSeparator = false;
      } else if (isSeparator && result && !lastWasSeparator) {
        result += char;
        lastWasSeparator = true;
      } else if (result && !lastWasSeparator) {
        result += "-";
        lastWasSeparator = true;
      }
    }

    return this.trimTrailingArtifactSeparators(result);
  }

  private trimTrailingArtifactSeparators(value: string) {
    let end = value.length;
    while (end > 0) {
      const char = value[end - 1];
      if (char !== "." && char !== "_" && char !== "-") break;
      end--;
    }
    return value.slice(0, end);
  }

  private snapshotToRunState(snapshot: SwarmRecoverySnapshot): SwarmRunState {
    return {
      runId: snapshot.runId,
      status: snapshot.status,
      goal: snapshot.goal,
      model: SWARM_MODEL,
      repository: this.state.runs?.[snapshot.runId]?.repository,
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

  private setWorkUnitState(runId: string, nextUnit: SwarmWorkUnitState) {
    const run = this.state.runs?.[runId];
    if (!run) return;

    const workUnits = run.workUnits.map((unit) =>
      unit.id === nextUnit.id ? nextUnit : unit
    );

    this.setRunState({
      ...run,
      progress: this.countProgress(workUnits),
      workUnits
    });
  }

  private setWorkUnitStateFromSnapshot(snapshot: WorkerRecoverySnapshot) {
    const run = this.state.runs?.[snapshot.runId];
    const unit = run?.workUnits.find(
      (candidate) => candidate.id === snapshot.workUnitId
    );
    if (!run || !unit) return;

    this.setWorkUnitState(snapshot.runId, {
      ...unit,
      status: snapshot.status,
      output: snapshot.output,
      summary: snapshot.summary,
      error: snapshot.error,
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt
    });
  }

  private async maybeFinalizeCompanyRun(runId: string) {
    const run = this.state.runs?.[runId];
    if (!run) return;
    if (
      ["complete", "failed", "cancelled", "synthesizing"].includes(run.status)
    ) {
      return;
    }
    if (!this.allWorkUnitsSettled(run.workUnits)) return;

    if (run.workUnits.every((unit) => unit.status !== "complete")) {
      this.setRunState({
        ...run,
        status: "failed",
        error: "All company employees failed or were cancelled.",
        completedAt: new Date().toISOString()
      });
      await this.cleanupSettledFibers();
      return;
    }

    this.setRunState({
      ...run,
      status: "synthesizing",
      progress: this.countProgress(run.workUnits)
    });

    try {
      await this.startFiber(
        COMPANY_SYNTHESIS_FIBER_NAME,
        (ctx) => this.executeSynthesisFiber(ctx, runId),
        {
          idempotencyKey: this.synthesisFiberKey(runId),
          metadata: { runId, goal: run.goal ?? "", model: SWARM_MODEL }
        }
      );
    } catch (error) {
      const current = this.state.runs?.[runId] ?? run;
      this.setRunState({
        ...current,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString()
      });
      throw error;
    }
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

  private synthesisFiberKey(runId: string) {
    return `swarm:${runId}:synthesis`;
  }

  private allWorkUnitsSettled(workUnits: SwarmWorkUnitState[]) {
    return workUnits.every((unit) =>
      ["complete", "failed", "cancelled"].includes(unit.status)
    );
  }

  private countActiveCompanyRuns() {
    return Object.values(this.state.runs ?? {}).filter((run) =>
      ["planning", "running", "synthesizing"].includes(run.status)
    ).length;
  }

  private async cleanupSettledFibers() {
    try {
      await this.deleteFibers({
        status: ["completed", "error", "aborted"],
        settledBefore: new Date(Date.now() - SETTLED_FIBER_RETENTION_MS),
        limit: 100
      });
    } catch (error) {
      console.warn("Failed to clean up settled company fibers", error);
    }
  }

  private async deleteAllTerminalFibers() {
    let deleted = 0;

    while (true) {
      const batchDeleted = await this.deleteFibers({
        status: ["completed", "aborted", "interrupted", "error"],
        limit: 500
      });

      deleted += batchDeleted;
      if (batchDeleted === 0) return deleted;
    }
  }

  private async cancelWorkerFibers(
    runId: string,
    workUnits: SwarmWorkUnitState[]
  ) {
    const results = await Promise.all(
      workUnits.map((unit) =>
        this.cancelFiberByKey(
          this.workerFiberKey(runId, unit.id),
          "Company run cancelled"
        )
      )
    );
    return results.some(Boolean);
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
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
