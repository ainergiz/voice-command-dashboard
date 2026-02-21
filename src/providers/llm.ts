// --- LLM Provider Interface and Implementations ---

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMCompletionParams {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** When true, instructs the model to return valid JSON. Gemini uses responseMimeType, others rely on prompt. */
  jsonMode?: boolean;
  /** Optional JSON Schema for structured output. Currently supported by Gemini (responseSchema). */
  responseSchema?: Record<string, unknown>;
  /** Gemini thinking level: "minimal" | "low" | "medium" | "high". Controls depth of reasoning. */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolCompletionResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface LLMProvider {
  complete(params: LLMCompletionParams): Promise<string>;
  stream(params: LLMCompletionParams): AsyncGenerator<string>;
  completeWithTools?(params: LLMCompletionParams & { tools: ToolDefinition[] }): Promise<ToolCompletionResult>;
}

// --- Anthropic Implementation ---

interface AnthropicContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicLLM implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl ?? "https://api.anthropic.com/v1";
  }

  async complete(params: LLMCompletionParams): Promise<string> {
    const body = {
      model: this.model,
      max_tokens: params.maxTokens ?? 1024,
      system: params.system,
      messages: params.messages,
      stream: false,
    };

    const resp = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${err}`);
    }

    const result: AnthropicResponse = await resp.json();
    return result.content[0]?.text ?? "";
  }

  async *stream(params: LLMCompletionParams): AsyncGenerator<string> {
    const body = {
      model: this.model,
      max_tokens: params.maxTokens ?? 512,
      system: params.system,
      messages: params.messages,
      stream: true,
    };

    const resp = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${err}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        try {
          const event = JSON.parse(data);
          if (event.type === "content_block_delta" && event.delta?.text) {
            yield event.delta.text;
          }
        } catch {
          // Skip malformed events
        }
      }
    }
  }

  async completeWithTools(
    params: LLMCompletionParams & { tools: ToolDefinition[] }
  ): Promise<ToolCompletionResult> {
    const anthropicTools = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const body = {
      model: this.model,
      max_tokens: params.maxTokens ?? 1024,
      system: params.system,
      messages: params.messages,
      tools: anthropicTools,
      stream: false,
    };

    const resp = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${err}`);
    }

    const result: AnthropicResponse = await resp.json();

    let text = "";
    const toolCalls: ToolCall[] = [];

    for (const block of result.content) {
      if (block.type === "text" && block.text) {
        text += block.text;
      } else if (block.type === "tool_use" && block.name && block.input) {
        toolCalls.push({ name: block.name, input: block.input });
      }
    }

    return { text, toolCalls };
  }
}

// --- OpenAI-compatible Implementation ---

interface OpenAIToolCallResponse {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  message?: { content: string | null; tool_calls?: OpenAIToolCallResponse[] };
  delta?: { content?: string };
  finish_reason: string | null;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
}

export class OpenAILLM implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl ?? "https://api.openai.com/v1";
  }

  async complete(params: LLMCompletionParams): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    for (const m of params.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: params.maxTokens ?? 1024,
        messages,
        stream: false,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${err}`);
    }

    const result: OpenAIResponse = await resp.json();
    return result.choices[0]?.message?.content ?? "";
  }

  async *stream(params: LLMCompletionParams): AsyncGenerator<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    for (const m of params.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: params.maxTokens ?? 512,
        messages,
        stream: true,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${err}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        try {
          const event: OpenAIResponse = JSON.parse(data);
          const content = event.choices[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch {
          // Skip malformed events
        }
      }
    }
  }

  async completeWithTools(
    params: LLMCompletionParams & { tools: ToolDefinition[] }
  ): Promise<ToolCompletionResult> {
    const messages: Array<{ role: string; content: string }> = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    for (const m of params.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const openaiTools = params.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: params.maxTokens ?? 1024,
        messages,
        tools: openaiTools,
        stream: false,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${err}`);
    }

    const result: OpenAIResponse = await resp.json();
    const choice = result.choices[0];
    const text = choice?.message?.content ?? "";
    const toolCalls: ToolCall[] = [];

    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        try {
          toolCalls.push({
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        } catch {
          // Skip malformed tool call arguments
        }
      }
    }

    return { text, toolCalls };
  }
}

// --- Workers AI Implementation ---

export interface WorkersAIBinding {
  run(
    model: string,
    inputs: Record<string, unknown>
  ): Promise<ReadableStream | { response: string }>;
}

export class WorkersAILLM implements LLMProvider {
  private ai: WorkersAIBinding;
  private model: string;

  constructor(ai: WorkersAIBinding, model: string) {
    this.ai = ai;
    this.model = model;
  }

  private buildMessages(params: LLMCompletionParams): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    for (const m of params.messages) {
      messages.push({ role: m.role, content: m.content });
    }
    return messages;
  }

  async complete(params: LLMCompletionParams): Promise<string> {
    const inputs: Record<string, unknown> = {
      messages: this.buildMessages(params),
      max_tokens: params.maxTokens ?? 1024,
      stream: false,
    };
    if (params.jsonMode) {
      inputs.response_format = { type: "json_object" };
    }

    const result = await this.ai.run(this.model, inputs);

    if (result instanceof ReadableStream) {
      return this.readStream(result);
    }

    return (result as { response: string }).response;
  }

  async *stream(params: LLMCompletionParams): AsyncGenerator<string> {
    const inputs: Record<string, unknown> = {
      messages: this.buildMessages(params),
      max_tokens: params.maxTokens ?? 512,
      stream: true,
    };
    if (params.jsonMode) {
      inputs.response_format = { type: "json_object" };
    }

    const result = await this.ai.run(this.model, inputs);

    if (!(result instanceof ReadableStream)) {
      yield (result as { response: string }).response;
      return;
    }

    const reader = result.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        try {
          const event = JSON.parse(data);
          if (event.response) {
            yield event.response;
          }
        } catch {
          // Skip malformed events
        }
      }
    }
  }

  async completeWithTools(
    params: LLMCompletionParams & { tools: ToolDefinition[] }
  ): Promise<ToolCompletionResult> {
    const openaiTools = params.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const inputs: Record<string, unknown> = {
      messages: this.buildMessages(params),
      max_tokens: params.maxTokens ?? 1024,
      stream: false,
      tools: openaiTools,
    };

    const result = await this.ai.run(this.model, inputs);

    // Workers AI returns OpenAI-compatible format for tool calls
    if (result instanceof ReadableStream) {
      // Shouldn't happen with stream: false, but handle gracefully
      const text = await this.readStream(result);
      return { text, toolCalls: [] };
    }

    const resp = result as Record<string, unknown>;

    // Native format: { response: string }
    if (typeof resp.response === "string") {
      return { text: resp.response, toolCalls: [] };
    }

    // OpenAI-compatible format from newer models
    const choices = (resp as { choices?: OpenAIChoice[] }).choices;
    if (choices?.[0]?.message) {
      const msg = choices[0].message;
      const text = msg.content ?? "";
      const toolCalls: ToolCall[] = [];
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          try {
            toolCalls.push({ name: tc.function.name, input: JSON.parse(tc.function.arguments) });
          } catch { /* skip malformed */ }
        }
      }
      return { text, toolCalls };
    }

    return { text: "", toolCalls: [] };
  }

  private async readStream(stream: ReadableStream): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }
}

// --- Gemini Implementation ---

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
}

interface GeminiCandidate {
  content: { parts: GeminiPart[]; role: string };
  finishReason: string;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
}

export class GeminiLLM implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  private buildContents(params: LLMCompletionParams): {
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    systemInstruction?: { parts: Array<{ text: string }> };
  } {
    const contents = params.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const systemInstruction = params.system
      ? { parts: [{ text: params.system }] }
      : undefined;

    return { contents, systemInstruction };
  }

  private buildGenerationConfig(params: LLMCompletionParams, defaultMaxTokens: number): Record<string, unknown> {
    const config: Record<string, unknown> = {
      maxOutputTokens: params.maxTokens ?? defaultMaxTokens,
    };
    if (params.jsonMode) {
      config.responseMimeType = "application/json";
    }
    if (params.responseSchema) {
      config.responseMimeType = "application/json";
      config.responseSchema = params.responseSchema;
    }
    if (params.thinkingLevel) {
      config.thinkingConfig = { thinkingLevel: params.thinkingLevel.toUpperCase() };
    }
    return config;
  }

  async complete(params: LLMCompletionParams): Promise<string> {
    const { contents, systemInstruction } = this.buildContents(params);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: this.buildGenerationConfig(params, 1024),
    };
    if (systemInstruction) body.system_instruction = systemInstruction;

    const resp = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${err}`);
    }

    const result: GeminiResponse = await resp.json();
    const parts = result.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p.text ?? "").join("");
  }

  async *stream(params: LLMCompletionParams): AsyncGenerator<string> {
    const { contents, systemInstruction } = this.buildContents(params);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: this.buildGenerationConfig(params, 512),
    };
    if (systemInstruction) body.system_instruction = systemInstruction;

    const resp = await fetch(
      `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${err}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const event: GeminiResponse = JSON.parse(data);
          const parts = event.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.text) yield part.text;
          }
        } catch {
          // Skip malformed events
        }
      }
    }
  }

  async completeWithTools(
    params: LLMCompletionParams & { tools: ToolDefinition[] }
  ): Promise<ToolCompletionResult> {
    const { contents, systemInstruction } = this.buildContents(params);

    const functionDeclarations = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const body: Record<string, unknown> = {
      contents,
      tools: [{ functionDeclarations }],
      generationConfig: { maxOutputTokens: params.maxTokens ?? 1024 },
    };
    if (systemInstruction) body.system_instruction = systemInstruction;

    const resp = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${err}`);
    }

    const result: GeminiResponse = await resp.json();
    const parts = result.candidates?.[0]?.content?.parts ?? [];

    let text = "";
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (part.text) {
        text += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          name: part.functionCall.name,
          input: part.functionCall.args,
        });
      }
    }

    return { text, toolCalls };
  }
}

// --- Factory ---

import type { LLMProviderConfig } from "../types/providers";

export function createLLMProvider(
  config: LLMProviderConfig,
  model: string,
  ai?: WorkersAIBinding
): LLMProvider {
  switch (config.provider) {
    case "anthropic":
      if (!config.apiKey) throw new Error("Anthropic API key required");
      return new AnthropicLLM(config.apiKey, model, config.baseUrl);

    case "openai":
      if (!config.apiKey) throw new Error("OpenAI API key required");
      return new OpenAILLM(config.apiKey, model, config.baseUrl);

    case "workers-ai":
      if (!ai) throw new Error("Workers AI binding (env.AI) required");
      return new WorkersAILLM(ai, model);

    case "gemini":
      if (!config.apiKey) throw new Error("Gemini API key required");
      return new GeminiLLM(config.apiKey, model, config.baseUrl);

    case "custom":
      if (!config.apiKey) throw new Error("API key required for custom provider");
      if (!config.baseUrl) throw new Error("Base URL required for custom provider");
      // Custom providers use OpenAI-compatible API
      return new OpenAILLM(config.apiKey, model, config.baseUrl);

    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
