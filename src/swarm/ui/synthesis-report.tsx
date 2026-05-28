import { Badge, Surface } from "@cloudflare/kumo";
import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";
import type { SwarmRunState } from "../types";

export function SynthesisReport({ run }: { run: SwarmRunState }) {
  if (!run.synthesis?.markdown) return null;

  return (
    <Surface className="swarm-synthesis">
      <div className="swarm-synthesis__header">
        <div>
          <div className="swarm-detail-label">Synthesis</div>
          <h3>{run.synthesis.headline || "Final swarm synthesis"}</h3>
        </div>
        <Badge variant="primary">{run.progress.complete} workers</Badge>
      </div>
      <Streamdown className="sd-theme" plugins={{ code }} controls={false}>
        {run.synthesis.markdown}
      </Streamdown>
    </Surface>
  );
}
