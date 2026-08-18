export type Phase = "local" | "waking" | "shared" | "frozen";

/** The derived convergence state the whole UI reads from, computed once per
 * render from the real replicas and controls. */
export type Status = {
  cutA: boolean;
  cutB: boolean;
  cut: boolean;
  both: boolean;
  frozen: boolean;
  dead: boolean;
  converged: boolean;
  drifting: boolean;
  reconciling: boolean;
  phase: Phase;
  latency: number;
  pendingA: number;
  pendingB: number;
};

export function computeStatus(input: {
  cutA: boolean;
  cutB: boolean;
  phase: Phase;
  reconciling: boolean;
  latency: number;
  textA: string;
  textB: string;
  pendingA: number;
  pendingB: number;
}): Status {
  const cut = input.cutA || input.cutB;
  const both = input.cutA && input.cutB;
  const frozen = input.phase === "frozen";
  const dead = cut || frozen;
  const pend = input.pendingA + input.pendingB;
  const drifting = dead && (pend > 0 || input.textA !== input.textB);
  const converged = input.pendingA === 0 && input.pendingB === 0 && input.textA === input.textB && !dead;
  return {
    cutA: input.cutA,
    cutB: input.cutB,
    cut,
    both,
    frozen,
    dead,
    converged,
    drifting,
    reconciling: input.reconciling,
    phase: input.phase,
    latency: input.latency,
    pendingA: input.pendingA,
    pendingB: input.pendingB,
  };
}
