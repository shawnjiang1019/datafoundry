/**
 * The grounding notes without the agent: what the notes MCP service (packages/notes-mcp) needs to
 * make notes for a question and check SQL and answers against them, without building an agent.
 */
export {
  groundEvidence,
  questionForGrounding,
  renderGroundingForAgent,
  summarizeGrounding,
  verifiedJoinRules,
  type EvidenceGroundingDeps
} from "./evidence-grounding-provider.js";
export { renderAnswerFrame, type AnswerFrame, type AnswerFrameProposer, type FrameDecision, type FrameOption } from "./answer-frame.js";
export { checkAnswer, type AnswerChallenge } from "./answer-check.js";
export { checkSqlAgainstNotes, isRejectedJoin } from "./sql-check.js";
export type { AnalysisValidationFinding } from "../protocol/analysis-contract.js";
export type {
  EvidenceGroundingContext,
  GroundingCandidate,
  GroundingSchema,
  GroundingSqlProbe
} from "./types.js";
