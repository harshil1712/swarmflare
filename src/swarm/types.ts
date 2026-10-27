export type SwarmStatus =
  | "idle"
  | "planning"
  | "running"
  | "synthesizing"
  | "complete"
  | "failed"
  | "cancelled";

export type WorkUnitStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

export type SwarmWorkUnitState = {
  id: string;
  title: string;
  role: string;
  employeeName?: string;
  objective?: string;
  expectedOutput?: string;
  status: WorkUnitStatus;
  summary?: string;
  output?: WorkerOutput;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

export type SwarmWorkUnitInput = {
  title: string;
  role: string;
  employeeName?: string;
  objective: string;
  prompt: string;
  expectedOutput: string;
};

export type RepositorySource =
  | { kind: "new" }
  | {
      kind: "import";
      url: string;
      branch?: string;
      depth?: number;
    };

export type WorkerOutput = {
  answer: string;
  keyFindings: string[];
  deliverables?: string[];
  decisions?: string[];
  openQuestions?: string[];
  risks?: string[];
  fileChanges?: Array<{
    path: string;
    content: string;
    summary?: string;
  }>;
  commit?: {
    sha: string;
    files: string[];
  };
  confidence: "low" | "medium" | "high";
};

export type SwarmProgress = {
  total: number;
  queued: number;
  running: number;
  complete: number;
  failed: number;
};

export type SwarmRunState = {
  runId: string;
  status: SwarmStatus;
  goal?: string;
  model: string;
  repository?: {
    name: string;
    remote: string;
    defaultBranch?: string;
    status: "creating" | "ready" | "failed";
    source: RepositorySource;
    error?: string;
  };
  progress: SwarmProgress;
  workUnits: SwarmWorkUnitState[];
  synthesis?: {
    headline: string;
    answer: string;
    markdown: string;
  };
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

export type SwarmState = {
  runs: Record<string, SwarmRunState>;
  selectedRunId?: string;
};

export type SwarmRecoverySnapshot = {
  runId: string;
  goal: string;
  phase: "planned" | "running" | "synthesizing" | "complete";
  status: SwarmStatus;
  workUnits: SwarmWorkUnitState[];
  synthesis?: SwarmRunState["synthesis"];
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export type WorkerRecoverySnapshot = {
  runId: string;
  workUnitId: string;
  status: WorkUnitStatus;
  output?: WorkerOutput;
  summary?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export const initialSwarmState: SwarmState = {
  runs: {}
};
