/**
 * A planning failure with a stable machine-readable code. `code` is what validators,
 * findings, and replanning dispatch on; `message` is for the model and the trail.
 */
export class PlannerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(`${code}: ${message}`);
    this.name = "PlannerError";
  }
}

export const isPlannerError = (error: unknown): error is PlannerError => error instanceof PlannerError;
