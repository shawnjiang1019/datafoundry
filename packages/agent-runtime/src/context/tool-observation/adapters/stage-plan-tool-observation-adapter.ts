import { asRecord, BaseToolObservationAdapter, pickFields } from "./base-tool-observation-adapter.js";

/** conclude_stage: D-Trail's verdict on a stage's reported outputs. */
export class ConcludeStageToolObservationAdapter extends BaseToolObservationAdapter {
  readonly toolName = "conclude_stage";
  readonly resultType = "conclude-stage";

  protected project(raw: unknown): unknown {
    return {
      ...pickFields(asRecord(raw), ["accepted", "errors", "rejected_attempts", "ready", "done", "error"]),
      source: "d-trail-stage-plan"
    };
  }
}
