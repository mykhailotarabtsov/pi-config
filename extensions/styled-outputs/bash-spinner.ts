export interface BashSpinnerExecution {
  status: string;
  _spinnerInterval?: ReturnType<typeof setInterval>;
  _spinnerFrame?: number;
}

export function startBashSpinner(
  execution: BashSpinnerExecution,
  frames: readonly string[],
  intervalMs: number,
  onFrame: () => void,
  requestRender: () => void,
): boolean {
  if (execution.status !== "running" || execution._spinnerInterval || frames.length === 0) return false;
  execution._spinnerFrame = 0;
  execution._spinnerInterval = setInterval(() => {
    execution._spinnerFrame = (execution._spinnerFrame! + 1) % frames.length;
    onFrame();
    requestRender();
  }, intervalMs);
  return true;
}

export function stopBashSpinner(execution: BashSpinnerExecution): void {
  if (!execution._spinnerInterval) return;
  clearInterval(execution._spinnerInterval);
  execution._spinnerInterval = undefined;
}
