import { BrainIcon } from "@phosphor-icons/react";

const SWARM_PROMPTS = [
  "Create an agent company to plan a durable multi-agent research system",
  "Hire a product, architecture, and security team to evaluate this Cloudflare app idea",
  "Run an agent company to investigate risks in this product idea and propose mitigations",
  "Plan a launch strategy with engineering, design, QA, and GTM employees",
  "Staff a small agent company to review this implementation plan from architecture, UX, and reliability angles"
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
        Agent Company on Cloudflare
      </div>
      <h2>Turn a hard goal into a live agent company.</h2>
      <p>
        Swarmflare hires task-scoped AI employees, runs their work in parallel,
        and synthesizes the results into one inspectable answer.
      </p>

      <div className="swarm-lifecycle" aria-label="Agent company lifecycle">
        {["Goal", "Plan", "Employees", "Synthesis"].map((step) => (
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
        Best for broad goals that need parallel research, critique, planning,
        review, or synthesis. Quick factual questions still work as ordinary
        chat.
      </div>
    </section>
  );
}
