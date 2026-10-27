import { Badge } from "@cloudflare/kumo";
import type { SwarmWorkUnitState } from "../types";
import { getStatusVariant } from "./utils";

export function SwarmWorkerCard({
  unit,
  selected,
  onInspect
}: {
  unit: SwarmWorkUnitState;
  selected: boolean;
  onInspect: (workUnitId: string) => void;
}) {
  return (
    <button
      type="button"
      data-status={unit.status}
      className={`swarm-worker-card ${selected ? "is-selected" : ""}`}
      onClick={() => onInspect(unit.id)}
    >
      <div className="swarm-worker-card__topline">
        <span>{unit.employeeName ?? unit.role}</span>
        <Badge variant={getStatusVariant(unit.status)}>{unit.status}</Badge>
      </div>
      <h4>{unit.title}</h4>
      {unit.employeeName && (
        <span className="swarm-worker-card__meta">{unit.role}</span>
      )}
      {unit.objective && <p>{unit.objective}</p>}
      {unit.summary && (
        <p className="swarm-worker-card__summary">{unit.summary}</p>
      )}
      {unit.output?.confidence && (
        <span className="swarm-worker-card__meta">
          Confidence: {unit.output.confidence}
        </span>
      )}
      {unit.error && (
        <span className="swarm-worker-card__error">{unit.error}</span>
      )}
    </button>
  );
}
