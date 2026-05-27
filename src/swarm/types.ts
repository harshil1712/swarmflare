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
  objective: string;
  prompt: string;
  expectedOutput: string;
};

export type WorkerOutput = {
  answer: string;
  keyFindings: string[];
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
