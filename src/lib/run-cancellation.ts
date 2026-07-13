const activeRuns = new Map<string, AbortController>();

export function registerRunCancellation(runId: string, controller: AbortController): () => void {
  activeRuns.set(runId, controller);
  return () => {
    if (activeRuns.get(runId) === controller) activeRuns.delete(runId);
  };
}

export function cancelActiveRun(runId: string): boolean {
  const controller = activeRuns.get(runId);
  if (!controller) return false;
  controller.abort(new Error('Cancelled by user'));
  return true;
}
