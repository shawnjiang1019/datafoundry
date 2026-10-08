import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createEnvConfig } from "@datafoundry/contracts";

export type ChatProviderConfig = {
  provider: string;
  model: string;
  base_url: string;
  api_key?: string;
  /** Reasoning models (GLM, DeepSeek) return their thinking in `reasoning_content`, which the
   * OpenAI client drops; the openai-compatible client streams it as reasoning parts. */
  reasoning_model?: boolean;
};

export type EmbeddingProviderConfig = {
  provider: string;
  model: string;
  base_url: string;
  embedding_dim: number;
  output_type: "dense";
  api_key?: string;
};

export type ModelProvider =
  | {
      kind: "openai-compatible";
      model_name: string;
      model: unknown;
      prompt_compat?: ModelPromptCompatibility;
    }
  | {
      kind: "mock";
      model_name: string;
    };

export type ModelPromptCompatibility = {
  requires_non_empty_message_content?: boolean;
};

export const createModelProvider = (env: Record<string, string | undefined>): ModelProvider => {
  const config = createEnvConfig(env);
  return createModelProviderFromConfig({
    provider: config.llm.provider,
    model: config.llm.model,
    base_url: config.llm.base_url,
    ...(config.llm.api_key ? { api_key: config.llm.api_key } : {})
  });
};

/** Create one model provider from a persisted model-profile configuration. */
export const createModelProviderFromConfig = (config: ChatProviderConfig): ModelProvider => {
  const providerName = normalizeChatProviderName(config.provider);
  if (!providerName) {
    throw new Error(`PROVIDER_UNSUPPORTED:${config.provider}`);
  }

  if (!config.api_key) {
    return {
      kind: "mock",
      model_name: config.model
    };
  }

  const model = config.reasoning_model
    ? createOpenAICompatible({ name: "openai-compatible", apiKey: config.api_key, baseURL: config.base_url })
      .chatModel(config.model)
    : createOpenAI({ apiKey: config.api_key, baseURL: config.base_url }).chat(config.model);
  const promptCompat = resolvePromptCompatibility(config);

  return {
    kind: "openai-compatible",
    model_name: config.model,
    model,
    ...(promptCompat ? { prompt_compat: promptCompat } : {})
  };
};

const normalizeChatProviderName = (provider: string): "openai-compatible" | undefined => {
  const normalized = provider.trim().toLowerCase().replaceAll("_", "-");
  if (
    normalized === "openai-compatible"
    || normalized === "bailian"
    || normalized === "deepseek"
    || normalized === "openai"
  ) {
    return "openai-compatible";
  }

  return undefined;
};

const resolvePromptCompatibility = (config: ChatProviderConfig): ModelPromptCompatibility | undefined => {
  const normalizedProvider = config.provider.trim().toLowerCase().replaceAll("_", "-");
  const normalizedBaseUrl = config.base_url.trim().toLowerCase();
  const requiresNonEmptyMessageContent =
    normalizedProvider === "bailian"
    || normalizedBaseUrl.includes("dashscope.aliyuncs.com");

  return requiresNonEmptyMessageContent
    ? { requires_non_empty_message_content: true }
    : undefined;
};
