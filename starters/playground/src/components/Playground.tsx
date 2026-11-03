import { SeclaiAgent } from "@seclai/react";
import "@seclai/react/styles.css";
import { useState } from "react";
import type { PlaygroundCase } from "../lib/cases";

export function Playground({ cases }: { cases: PlaygroundCase[] }) {
  const [activeKey, setActiveKey] = useState(cases[0]!.key);
  const active = cases.find((c) => c.key === activeKey) ?? cases[0]!;

  return (
    <>
      <nav className="tabs">
        {cases.map((c) => (
          <button
            key={c.key}
            type="button"
            aria-pressed={c.key === active.key}
            onClick={() => setActiveKey(c.key)}
          >
            {c.label}
          </button>
        ))}
      </nav>

      <p className="hint">{active.hint}</p>

      {active.agentId ? (
        // Keyed so that switching tabs starts each case from a clean state.
        <SeclaiAgent key={active.key} mode={active.mode} agentId={active.agentId} />
      ) : (
        <p className="hint">
          Set <code>SECLAI_AGENT_ID_{active.key.toUpperCase()}</code> in <code>.env</code> to try
          this case.
        </p>
      )}
    </>
  );
}
