import { finalAnswerText } from "./final-answer.js";
import type { DataAnalysisState } from "./protocols/data-analysis.js";
import type { ProtocolRunState } from "./types.js";

/**
 * Answer form: the value can be right while its form is wrong. On 2026-11-12, environment-hard-7
 * computed 0.15124 - 0.04249 correctly and answered 0.11 where the question meant percentage points
 * (10.87); its own summary said "about 11 percentage points". This check reads the final answer
 * against the form the question asks for (allowed values, decimal places, percent vs proportion) and
 * sends the agent back once with both readings. It never rewrites the answer: the agent decides.
 */

const DEFAULT_MAX_CHALLENGES = 1;

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/** Decimal places the question asks for: 0 for "to integer", undefined when it names none. */
export const requestedDecimals = (question: string): number | undefined => {
  const places = /\bto\s+(\d+|one|two|three|four|five|six)\s+decimal(?:\s+places?|s)?\b/iu.exec(question)
    ?? /\((\d+)\s*(?:dp|d\.p\.|decimals?)\)/iu.exec(question);
  if (places) {
    const word = (places[1] ?? "").toLowerCase();
    return NUMBER_WORDS[word] ?? Number(word);
  }
  if (/\b(?:to\s+(?:the\s+nearest\s+)?(?:integer|whole\s+number)|as\s+an?\s+(?:integer|whole\s+number)|round(?:ed)?\s+to\s+(?:an?\s+)?integer)\b/iu.test(question)) {
    return 0;
  }
  return undefined;
};

/** The values the question allows ("answer with True or False", "either 'A' or 'B'"), else undefined. */
export const allowedAnswers = (question: string): string[] | undefined => {
  if (/\banswer\s+(?:with|in|as)\s+(?:either\s+)?(?:a\s+)?(?:["'`]?true["'`]?\s*(?:or|\/)\s*["'`]?false["'`]?)/iu.test(question)) {
    return ["True", "False"];
  }
  const quoted = /\banswer\s+(?:with|in|as)\s+(?:either\s+)?["'`‘“]([^"'`’”]+)["'`’”]\s+or\s+["'`‘“]([^"'`’”]+)["'`’”]/iu.exec(question);
  if (quoted?.[1] && quoted[2]) return [quoted[1].trim(), quoted[2].trim()];
  return undefined;
};

const NUMERIC = /^[-+]?\d+(?:\.\d+)?%?$/u;

/** What is wrong with the answer's form, as one message, or undefined when nothing is. */
export const answerFormIssue = (input: { question: string; answer: string; response?: string }): string | undefined => {
  const { question, answer } = input;
  const response = input.response ?? "";
  const issues: string[] = [];

  const allowed = allowedAnswers(question);
  if (allowed) {
    if (!allowed.includes(answer)) {
      const caseOnly = allowed.find((value) => value.toLowerCase() === answer.toLowerCase());
      issues.push(caseOnly
        ? `The question asks for exactly ${allowed.map((value) => `"${value}"`).join(" or ")}; write "${caseOnly}", not "${answer}".`
        : `The question allows only ${allowed.map((value) => `"${value}"`).join(" or ")}, but the final answer is "${answer}".`);
    }
    return issues[0];
  }

  const compact = answer.replaceAll(",", "");
  if (!NUMERIC.test(compact)) return undefined;
  const value = Number(compact.replace("%", ""));
  const decimals = requestedDecimals(question);
  const shownDecimals = (/\.(\d+)/u.exec(compact)?.[1] ?? "").length;
  if (decimals !== undefined && shownDecimals > decimals) {
    issues.push(`The question asks for ${decimals === 0 ? "an integer" : `${decimals} decimal place${decimals === 1 ? "" : "s"}`}, `
      + `but the final answer ${answer} has ${shownDecimals}. Round it once, at the end.`);
  }

  // Percent vs proportion: a rate or percentage below 1 that the question or the agent's own text
  // speaks of in percent. Questions about proportions, fractions, ratios or correlations are left alone.
  // The words, not a bare "%": "communities with more than 50% EJ" sets a threshold, not the answer's unit.
  const asksPercent = /\bpercent(?:age)?s?\b/iu.test(question);
  const asksRate = /\brates?\b/iu.test(question);
  const proportionWords = /\b(?:proportion|fraction|ratio|share\s+as\s+a\s+decimal|correlation|coefficient|probability|between\s+0\s+and\s+1)\b/iu;
  const responseSpeaksPercent = /percentage\s+points?|\d\s*%|\bper\s*cent\b|\bpercent\b/iu.test(response);
  if (!compact.endsWith("%") && value !== 0 && Math.abs(value) < 1 && !proportionWords.test(question)
      && (asksPercent || (asksRate && responseSpeaksPercent))) {
    issues.push(`The question asks for a ${asksPercent ? "percentage" : "rate"} and the final answer ${answer} is below 1. `
      + "If it is a proportion (0-1), the percentage is the unrounded proportion times 100 (not the rounded answer "
      + "times 100), rounded once at the end"
      + (decimals !== undefined ? ` to ${decimals} decimal place${decimals === 1 ? "" : "s"}` : "")
      + ". Use the unit the question and the data use for this rate (check how the question and your own summary "
      + "state it); if the answer is already in percent, keep it.");
  }
  return issues.length > 0 ? issues.join(" ") : undefined;
};

/**
 * How to act on a challenge. Environment-hard-7 (2026-11-13) agreed the answer should be 10.87, then
 * repeated its committed 0.11: the commit result had said "do not commit again", so it never changed it.
 */
const CHANGE_STEPS = "If you change the value: compute it in a query (for example 100 * the proportion, before any rounding), "
  + "commit it again with analysis_requirements_commit (a new value replaces the committed one), and give that value "
  + "as FINAL_ANSWER. If you keep it, say why in one sentence and give FINAL_ANSWER again.";

type ScorerRunInput = { output?: unknown; input?: { originalTask?: unknown } } | undefined;

/** The question to read the form from: the grounded question when there is one, else the task text. */
const questionFor = (state: ProtocolRunState | undefined, args: ScorerRunInput): string => {
  const domain = state?.domain as DataAnalysisState | undefined;
  const grounded = domain?.evidenceGrounding?.question;
  if (typeof grounded === "string" && grounded.trim()) return grounded;
  const task = args?.input?.originalTask;
  return typeof task === "string" ? task : "";
};

/**
 * A Mastra completion check (isTaskComplete scorer) for the answer's form. No model call; sends the
 * agent back at most `maxChallenges` times per run, then lets the answer go out as written.
 */
export const createAnswerFormCheck = (input: { getState: () => ProtocolRunState; maxChallenges?: number }) => {
  let challenges = 0;
  return {
    id: "answer-form",
    name: "Answer form matches the question",
    run: async (args?: ScorerRunInput): Promise<{ score: number; reason?: string }> => {
      let reason: string | undefined;
      try {
        const response = typeof args?.output === "string" ? args.output : "";
        const answer = finalAnswerText(response);
        if (!answer) return { score: 1 };
        let state: ProtocolRunState | undefined;
        try {
          state = input.getState();
        } catch {
          state = undefined;
        }
        const question = questionFor(state, args);
        if (!question) return { score: 1 };
        reason = answerFormIssue({ question, answer, response });
        console.warn(`[answer-form-check] issue=${reason ? "yes" : "none"} challenges=${challenges}`);
      } catch (error) {
        console.warn(`[answer-form-check] skipped: ${error instanceof Error ? error.message : String(error)}`);
        return { score: 1 };
      }
      if (!reason || challenges >= (input.maxChallenges ?? DEFAULT_MAX_CHALLENGES)) return { score: 1 };
      challenges += 1;
      return { score: 0, reason: `${reason} ${CHANGE_STEPS}` };
    }
  };
};
