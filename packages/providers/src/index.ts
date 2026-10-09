import { createOpenAI } from "@ai-sdk/openai";
import { createEnvConfig } from "@datafoundry/contracts";

export type ChatProviderConfig = {
  provider: string;
  model: string;
  base_url: string;
  api_key?: string;
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

  const provider = createOpenAI({
    apiKey: config.api_key,
    baseURL: config.base_url,
    fetch: createThinkingSwitchFetch(config.base_url)
  });
  const promptCompat = resolvePromptCompatibility(config);

  return {
    kind: "openai-compatible",
    model_name: config.model,
    model: provider.chat(config.model),
    ...(promptCompat ? { prompt_compat: promptCompat } : {})
  };
};

/**
 * Request header a caller sets to ask for one model call without a reasoning phase. The provider's
 * fetch removes it before the request leaves; on a GLM endpoint it becomes `thinking: {type: "disabled"}`
 * (structured helper calls otherwise spend their output budget reasoning: 2026-10-08, contract
 * output cut off at 8192 tokens, then 5-minute header timeouts at 32768). Other providers ignore it.
 */
export const DISABLE_THINKING_HEADER = "x-datafoundry-disable-thinking";

const supportsThinkingSwitch = (baseUrl: string): boolean => /(^|\.)(bigmodel\.cn|z\.ai)(\/|:|$)/iu.test(
  baseUrl.replace(/^https?:\/\//iu, "")
);

export const createThinkingSwitchFetch = (
  baseUrl: string,
  baseFetch: typeof fetch = globalThis.fetch
): typeof fetch => async (input, init) => {
  const headers = new Headers(init?.headers);
  if (!headers.has(DISABLE_THINKING_HEADER)) {
    return baseFetch(input, init);
  }
  headers.delete(DISABLE_THINKING_HEADER);
  let body = init?.body;
  if (supportsThinkingSwitch(baseUrl) && typeof body === "string") {
    try {
      body = JSON.stringify({ ...JSON.parse(body) as Record<string, unknown>, thinking: { type: "disabled" } });
    } catch {
      // Not a JSON body: send it unchanged.
    }
  }
  return baseFetch(input, { ...init, headers, ...(body === undefined ? {} : { body }) });
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
