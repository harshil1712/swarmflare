import { BrainIcon } from "@phosphor-icons/react";

const SWARM_PROMPTS = [
  "Design an architecture for a durable multi-agent research system",
  "Compare three approaches to deploying AI agents on Cloudflare",
  "Investigate risks in this product idea and propose mitigations",
  "Plan a launch strategy for Swarmflare with engineering and GTM workstreams",
  "Review this implementation plan from architecture, UX, and reliability angles"
];

export function SwarmLaunchpad({
  onPrompt
}: {
  onPrompt: (prompt: string) => void;
}) {
  return (
    <section className="swarm-launchpad">
      <div className="swarm-launchpad__eyebrow">
        <BrainIcon size={16} weight="fill" />
        Agent Swarms on Cloudflare
      </div>
      <h2>Split a hard goal into a live agent swarm.</h2>
      <p>
        Swarmflare plans specialist work units, runs them in parallel, and
        synthesizes the findings into one inspectable answer.
      </p>

      <div className="swarm-lifecycle" aria-label="Agent swarm lifecycle">
        {["Goal", "Plan", "Workers", "Synthesis"].map((step) => (
          <div key={step} className="swarm-lifecycle__step">
            <span />
            {step}
          </div>
        ))}
      </div>

      <div className="swarm-prompt-grid">
        {SWARM_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="swarm-prompt-card"
            onClick={() => onPrompt(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>

      <div className="swarm-launchpad__hint">
        Best for broad goals that need parallel research, critique, planning, or
        synthesis. Quick factual questions still work as ordinary chat.
      </div>
    </section>
  );
}
