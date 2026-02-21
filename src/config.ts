import type { LLMProviderConfig, STTProviderConfig } from "./types/providers";

export interface Env {
  SessionAgent: DurableObjectNamespace;
  ASSETS: Fetcher;

  // Secrets
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  MISTRAL_API_KEY?: string;

  // Config vars
  LLM_PROVIDER?: string;
  LLM_FAST_MODEL?: string;
  LLM_DEEP_MODEL?: string;
  STT_PROVIDER?: string;
  STT_MODEL?: string;
  STT_DELAY_MS?: string;

  // Workers AI (optional)
  AI?: Ai;
}

export type LLMProviderType = "gemini" | "anthropic" | "openai" | "workers-ai";

export interface AgentConfig {
  llm: LLMProviderConfig;
  stt: STTProviderConfig;
}

const LLM_DEFAULTS: Record<LLMProviderType, { fast: string; deep: string }> = {
  gemini: {
    fast: "gemini-3-flash-preview",
    deep: "gemini-3-flash-preview",
  },
  anthropic: {
    fast: "claude-haiku-4-5-20251001",
    deep: "claude-sonnet-4-5-20250929",
  },
  openai: {
    fast: "gpt-4o-mini",
    deep: "gpt-4o",
  },
  "workers-ai": {
    fast: "@cf/zai-org/glm-4.7-flash",
    deep: "@cf/qwen/qwen3-30b-a3b-fp8",
  },
};

export function buildConfig(env: Env): AgentConfig {
  const provider = (env.LLM_PROVIDER ?? "gemini") as LLMProviderType;
  const defaults = LLM_DEFAULTS[provider] ?? LLM_DEFAULTS.gemini;

  let apiKey = "";
  if (provider === "gemini") {
    apiKey = env.GEMINI_API_KEY ?? "";
  } else if (provider === "anthropic") {
    apiKey = env.ANTHROPIC_API_KEY ?? "";
  } else if (provider === "openai") {
    apiKey = env.OPENAI_API_KEY ?? "";
  }

  return {
    llm: {
      provider,
      fastModel: env.LLM_FAST_MODEL ?? defaults.fast,
      deepModel: env.LLM_DEEP_MODEL ?? defaults.deep,
      apiKey,
    },
    stt: {
      provider: "mistral",
      apiKey: env.MISTRAL_API_KEY ?? "",
      model: env.STT_MODEL ?? "voxtral-mini-transcribe-realtime-2602",
      delayMs: parseInt(env.STT_DELAY_MS ?? "480", 10),
    },
  };
}
