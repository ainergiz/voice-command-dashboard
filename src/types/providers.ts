export interface LLMProviderConfig {
  provider: "anthropic" | "openai" | "gemini" | "workers-ai" | "custom";
  apiKey?: string;
  fastModel: string;
  deepModel: string;
  baseUrl?: string;
}

export interface STTProviderConfig {
  provider: "mistral";
  apiKey: string;
  model: string;
  delayMs: number;
}
