import { Agent } from "@mastra/core/agent";
import { DISABLE_THINKING_HEADER } from "@datafoundry/providers";

import { sharedHelperMastra } from "../runtime/shared-mastra.js";
import { LESSON_WRITER_INSTRUCTIONS, type LessonModel } from "./runtime-evolution.js";

/**
 * The run's model as a lesson writer: one step, no tools, low temperature, thinking off. With
 * thinking on, the first trial (2026-11-13) got a version with no lessons and no readable reply:
 * structured helper calls spend their output budget reasoning (see DISABLE_THINKING_HEADER).
 */
export const createMastraLessonModel = (model: unknown): LessonModel => {
  const agent = new Agent({
    id: "lesson-writer",
    name: "Lesson Writer",
    mastra: sharedHelperMastra(),
    instructions: LESSON_WRITER_INSTRUCTIONS,
    model: model as never
  });
  return async (prompt: string) => (await agent.generate(prompt, {
    maxSteps: 1,
    modelSettings: {
      maxOutputTokens: 2000,
      temperature: 0.2,
      headers: { [DISABLE_THINKING_HEADER]: "1" }
    },
    providerOptions: { openai: { systemMessageMode: "system" } }
  })).text;
};
