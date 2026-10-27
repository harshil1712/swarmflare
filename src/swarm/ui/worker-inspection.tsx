import { Badge, Surface, Text } from "@cloudflare/kumo";
import type { SwarmRunState } from "../types";
import type { SwarmInspection } from "./types";
import { formatDateTime, getStatusVariant } from "./utils";

export function WorkerInspection({
  run,
  selectedWorkUnitId,
  inspection,
  inspectError,
  isInspecting
}: {
  run: SwarmRunState;
  selectedWorkUnitId?: string;
  inspection?: SwarmInspection;
  inspectError?: string;
  isInspecting: boolean;
}) {
  if (!selectedWorkUnitId) {
    return (
      <Surface className="swarm-detail-card">
        <Text size="sm" bold>
          Employee inspection
        </Text>
        <Text size="xs" variant="secondary">
          Select an employee to inspect its objective, findings, confidence, and
          durable trace.
        </Text>
      </Surface>
    );
  }

  const unit = run.workUnits.find(
    (candidate) => candidate.id === selectedWorkUnitId
  );
  const rawInspection = inspection?.workers.find(
    (worker) => worker.workUnitId === selectedWorkUnitId
  );

  return (
    <Surface className="swarm-detail-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Text size="sm" bold>
            {unit?.employeeName ?? unit?.title ?? "Employee inspection"}
          </Text>
          {unit?.role && (
            <Text size="xs" variant="secondary">
              {unit.employeeName ? `${unit.role} - ${unit.title}` : unit.role}
            </Text>
          )}
        </div>
        {unit?.status && (
          <Badge variant={getStatusVariant(unit.status)}>{unit.status}</Badge>
        )}
      </div>

      {isInspecting ? (
        <Text size="xs" variant="secondary">
          Loading employee trace...
        </Text>
      ) : inspectError ? (
        <Text size="xs" variant="secondary">
          {inspectError}
        </Text>
      ) : (
        <div className="space-y-3">
          {unit?.objective && (
            <div>
              <div className="swarm-detail-label">Objective</div>
              <p className="swarm-detail-copy">{unit.objective}</p>
            </div>
          )}
          {unit?.expectedOutput && (
            <div>
              <div className="swarm-detail-label">Expected output</div>
              <p className="swarm-detail-copy">{unit.expectedOutput}</p>
            </div>
          )}
          {unit?.output?.answer && (
            <div>
              <div className="swarm-detail-label">Employee answer</div>
              <p className="swarm-detail-copy">{unit.output.answer}</p>
            </div>
          )}
          {unit?.output?.keyFindings?.length ? (
            <div>
              <div className="swarm-detail-label">Key findings</div>
              <ul className="swarm-finding-list">
                {unit.output.keyFindings.map((finding) => (
                  <li key={finding}>{finding}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {unit?.output?.deliverables?.length ? (
            <div>
              <div className="swarm-detail-label">Deliverables</div>
              <ul className="swarm-finding-list">
                {unit.output.deliverables.map((deliverable) => (
                  <li key={deliverable}>{deliverable}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {unit?.output?.decisions?.length ? (
            <div>
              <div className="swarm-detail-label">Decisions</div>
              <ul className="swarm-finding-list">
                {unit.output.decisions.map((decision) => (
                  <li key={decision}>{decision}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {unit?.output?.risks?.length ? (
            <div>
              <div className="swarm-detail-label">Risks</div>
              <ul className="swarm-finding-list">
                {unit.output.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {unit?.output?.openQuestions?.length ? (
            <div>
              <div className="swarm-detail-label">Open questions</div>
              <ul className="swarm-finding-list">
                {unit.output.openQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="swarm-detail-meta">
            <span>Started {formatDateTime(unit?.startedAt)}</span>
            <span>Completed {formatDateTime(unit?.completedAt)}</span>
            {unit?.output?.confidence && (
              <span>Confidence {unit.output.confidence}</span>
            )}
          </div>
          <details className="swarm-trace">
            <summary>Debug trace</summary>
            <pre>{JSON.stringify(rawInspection ?? inspection, null, 2)}</pre>
          </details>
        </div>
      )}
    </Surface>
  );
}
