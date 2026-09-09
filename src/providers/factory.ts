import type { ModelSettings } from "../models/settings.js";
import { AnthropicProvider } from "./anthropic.js";
import { ProviderConfigurationError, diagnoseProvider } from "./diagnostics.js";
import type { ModelProvider } from "./events.js";
import { OpenAIProvider } from "./openai.js";

export interface ProviderFactoryOptions {
  readonly apiKey?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly baseURL?: string;
  readonly timeout?: number;
  readonly defaultHeaders?: Record<string, string>;
  readonly fetch?: typeof fetch;
}

export class UnsupportedProviderError extends Error {
  override readonly name = "UnsupportedProviderError";
  readonly provider: string;

  constructor(provider: string) {
    super(`Unsupported model provider: ${provider}`);
    this.provider = provider;
  }
}

function credential(
  model: ModelSettings,
  options: ProviderFactoryOptions,
): string {
  const variable =
    model.provider === "openai"
      ? "OPENAI_API_KEY"
      : model.provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : "DEEPSEEK_API_KEY";
  const apiKey = options.apiKey ?? options.environment?.[variable];
  if (!apiKey) {
    throw new ProviderConfigurationError(
      diagnoseProvider(model, {
        credentialPresent: false,
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
      }),
    );
  }
  return apiKey;
}

export function createProvider(
  model: ModelSettings,
  options: ProviderFactoryOptions = {},
): ModelProvider {
  if (
    model.provider !== "openai" &&
    model.provider !== "anthropic" &&
    model.provider !== "deepseek"
  ) {
    throw new UnsupportedProviderError(model.provider);
  }
  const shared = {
    apiKey: credential(model, options),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.defaultHeaders === undefined
      ? {}
      : { defaultHeaders: options.defaultHeaders }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  if (model.provider === "anthropic") {
    return new AnthropicProvider({
      ...shared,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });
  }
  const baseURL =
    options.baseURL ??
    (model.provider === "deepseek" ? "https://api.deepseek.com" : undefined);
  return new OpenAIProvider({
    ...shared,
    ...(baseURL === undefined ? {} : { baseURL }),
  });
}
