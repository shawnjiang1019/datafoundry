import { describe, expect, it } from "vitest";

import {
  allowedAnswers,
  answerFormIssue,
  createAnswerFormCheck,
  finalAnswerValue,
  requestedDecimals
} from "./answer-form-check.js";
import type { ProtocolRunState } from "./types.js";

const HARD_7 = "What was the difference in bacterial exceedance rates (to 2 decimal places) for marine beach samples "
  + "collected in 2023 between communities with more than 50% environmental justice (EJ) populations and those with "
  + "less than 25% EJ populations?";

const state = (question?: string): ProtocolRunState => ({
  protocolId: "data-analysis",
  status: "active",
  domain: question ? { evidenceGrounding: { question } } : {}
}) as unknown as ProtocolRunState;

describe("answer form", () => {
  it("reads the last FINAL_ANSWER value", () => {
    expect(finalAnswerValue("draft FINAL_ANSWER: 1\n...\nFINAL_ANSWER: **0.11**")).toBe("0.11");
    expect(finalAnswerValue("FINAL_ANSWER: \"Marine\"")).toBe("Marine");
    expect(finalAnswerValue("no marker here")).toBeUndefined();
  });

  it("reads decimal places and allowed values from the question", () => {
    expect(requestedDecimals(HARD_7)).toBe(2);
    expect(requestedDecimals("What is the percentage (to integer) of time")).toBe(0);
    expect(requestedDecimals("to three decimal places")).toBe(3);
    expect(requestedDecimals("How many beaches?")).toBeUndefined();
    expect(allowedAnswers("Is it true (answer with True or False) that ...")).toEqual(["True", "False"]);
    expect(allowedAnswers("Answer with either 'Freshwater' or 'Marine'.")).toEqual(["Freshwater", "Marine"]);
  });

  it("flags a proportion given where the question means percent (environment-hard-7)", () => {
    const issue = answerFormIssue({
      question: HARD_7,
      answer: "0.11",
      response: "about 11 percentage points (as a proportion, 0.11) higher"
    });
    expect(issue).toMatch(/asks for a rate.*below 1.*times 100.*2 decimal places.*keep it/su);
    // The "50%" threshold alone does not make the question ask for a percentage.
    expect(answerFormIssue({ question: HARD_7, answer: "0.11", response: "difference = 0.11" })).toBeUndefined();
  });

  it("leaves correlations, plain quantities and answers already in range alone", () => {
    expect(answerFormIssue({ question: "what is the Pearson correlation (to 3 decimal places) between rainfall and levels?", answer: "0.206" })).toBeUndefined();
    expect(answerFormIssue({ question: "What was the average rainfall (to 2 decimal places)?", answer: "0.37" })).toBeUndefined();
    expect(answerFormIssue({ question: "What percentage (to 3 decimal places) of samples exceeded?", answer: "4.796" })).toBeUndefined();
    // A rate the agent itself never speaks of in percent is not challenged.
    expect(answerFormIssue({ question: "What is the failure rate?", answer: "0.05", response: "rate = 0.05" })).toBeUndefined();
  });

  it("flags too many decimals and answers outside the allowed values", () => {
    expect(answerFormIssue({ question: "What percentage (to integer) of time?", answer: "86.2" })).toMatch(/an integer/u);
    expect(answerFormIssue({ question: "Answer with True or False.", answer: "true" })).toMatch(/write "True"/u);
    expect(answerFormIssue({ question: "Answer with either 'Freshwater' or 'Marine'.", answer: "Both" })).toMatch(/allows only/u);
    expect(answerFormIssue({ question: "Answer with True or False.", answer: "False" })).toBeUndefined();
  });

  it("sends the agent back once, then lets the answer go out", async () => {
    const check = createAnswerFormCheck({ getState: () => state(HARD_7) });
    const args = { output: "11 percentage points\nFINAL_ANSWER: 0.11" };
    expect((await check.run(args)).score).toBe(0);
    expect(await check.run(args)).toEqual({ score: 1 });
  });

  it("falls back to the task text and passes when there is no final answer", async () => {
    const check = createAnswerFormCheck({ getState: () => { throw new Error("no state"); } });
    expect((await check.run({ output: "FINAL_ANSWER: 86.25", input: { originalTask: "What percentage (to integer)?" } })).score).toBe(0);
    expect(await createAnswerFormCheck({ getState: () => state(HARD_7) }).run({ output: "working..." })).toEqual({ score: 1 });
  });
});
