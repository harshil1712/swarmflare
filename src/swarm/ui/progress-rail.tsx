import type { SwarmRunState } from "../types";

export function SwarmProgressRail({ run }: { run: SwarmRunState }) {
  const progress = run.progress.total
    ? Math.round((run.progress.complete / run.progress.total) * 100)
    : 0;
  const stats: Array<[string, number]> = [
    ["Total", run.progress.total],
    ["Queued", run.progress.queued],
    ["Running", run.progress.running],
    ["Done", run.progress.complete],
    ["Failed", run.progress.failed]
  ];

  return (
    <div className="swarm-progress">
      <div className="swarm-progress__bar" aria-label={`${progress}% complete`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="swarm-progress__stats">
        {stats.map(([label, value]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
