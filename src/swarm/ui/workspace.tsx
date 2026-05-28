import { Badge, Button, Surface } from "@cloudflare/kumo";
import { BrainIcon, StopIcon } from "@phosphor-icons/react";
import type { SwarmRunState, WorkUnitStatus } from "../types";
import type { SwarmInspection } from "./types";
import { SwarmProgressRail } from "./progress-rail";
import { SynthesisReport } from "./synthesis-report";
import { getStatusVariant, formatDateTime } from "./utils";
import { WorkerInspection } from "./worker-inspection";
import { SwarmWorkerCard } from "./worker-card";

export function SwarmWorkspace({
  run,
  runs,
  selectedWorkUnitId,
  inspection,
  inspectError,
  isInspecting,
  onSelectRun,
  onCancel,
  onInspectWorkUnit,
}: {
  run?: SwarmRunState;
  runs: SwarmRunState[];
  selectedWorkUnitId?: string;
  inspection?: SwarmInspection;
  inspectError?: string;
  isInspecting: boolean;
  onSelectRun: (runId: string) => void;
  onCancel: (runId: string) => void;
  onInspectWorkUnit: (workUnitId: string) => void;
}) {
  if (!run || run.status === "idle") return null;

  const canCancel = ["planning", "running", "synthesizing"].includes(
    run.status,
  );
  const sortedUnits = [...run.workUnits].sort((a, b) => {
    const order: Record<WorkUnitStatus, number> = {
      running: 0,
      queued: 1,
      failed: 2,
      cancelled: 3,
      complete: 4,
    };
    return order[a.status] - order[b.status];
  });

  return (
    <section className="swarm-workspace" aria-label="Agent swarm workspace">
      <Surface className="swarm-run-card">
        <div className="swarm-run-card__header">
          <div>
            <div className="swarm-launchpad__eyebrow">
              <BrainIcon size={15} weight="fill" />
              Agent Swarm
            </div>
            <h4>{run.goal || "Untitled swarm run"}</h4>
            <div className="swarm-detail-meta">
              <span>{run.model}</span>
              <span>Started {formatDateTime(run.startedAt)}</span>
              {run.completedAt && (
                <span>Completed {formatDateTime(run.completedAt)}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant={getStatusVariant(run.status)}>{run.status}</Badge>
            {canCancel && (
              <Button
                variant="secondary"
                size="sm"
                icon={<StopIcon size={14} />}
                onClick={() => onCancel(run.runId)}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>

        {runs.length > 1 && (
          <div className="swarm-run-tabs">
            {runs.map((candidate) => (
              <button
                key={candidate.runId}
                type="button"
                className={candidate.runId === run.runId ? "is-active" : ""}
                onClick={() => onSelectRun(candidate.runId)}
              >
                {candidate.goal?.slice(0, 42) || candidate.runId}
              </button>
            ))}
          </div>
        )}

        <SwarmProgressRail run={run} />
        {run.error && <div className="swarm-run-error">{run.error}</div>}
      </Surface>

      {run.synthesis?.markdown && <SynthesisReport run={run} />}

      <div className="swarm-grid">
        <Surface className="swarm-map-card">
          <div className="swarm-map-card__header">
            <div>
              <div className="swarm-detail-label">Worker map</div>
              <h3>Parallel specialist work</h3>
            </div>
            <Badge variant="secondary">{run.workUnits.length} units</Badge>
          </div>
          <div className="swarm-worker-grid">
            {sortedUnits.map((unit) => (
              <SwarmWorkerCard
                key={unit.id}
                unit={unit}
                selected={selectedWorkUnitId === unit.id}
                onInspect={onInspectWorkUnit}
              />
            ))}
          </div>
        </Surface>

        <WorkerInspection
          run={run}
          selectedWorkUnitId={selectedWorkUnitId}
          inspection={inspection}
          inspectError={inspectError}
          isInspecting={isInspecting}
        />
      </div>
    </section>
  );
}
