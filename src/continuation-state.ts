export type NamedAgentState = {
  name: string;
  status: string;
};

export function replacementAgentName(requested: string, agents: NamedAgentState[]): string {
  const base = requested.slice(0, 100);
  const used = new Set(agents
    .filter((agent) => agent.status !== "deleted")
    .map((agent) => agent.name.toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const marker = `-${suffix}`;
    const candidate = `${base.slice(0, 100 - marker.length)}${marker}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error("Could not choose an available agent name.");
}

export function isAgentNotFoundError(error: unknown): boolean {
  return (error as Error & { status?: number })?.status === 404
    || /agent not found|agent .*deleted/i.test(error instanceof Error ? error.message : String(error));
}

export function continuationFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  if (isAgentNotFoundError(error)) {
    return "The previous chat.dev agent no longer exists. In the browser, choose Start New Agent and Move Connection.";
  }
  const detail = message || "The project connection stopped.";
  return `${detail} In the browser, choose Try Again in Editor or Start New Agent and Move Connection.`;
}
