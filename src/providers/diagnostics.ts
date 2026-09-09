/**
 * Credential diagnostics adapted from aider/models.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified to avoid global environment access and to check Patch's explicit
 * provider/model capability contracts.
 */

import type { ModelCapabilities, ModelSettings } from "../models/settings.js";

export type Capability = keyof ModelCapabilities;

export interface ProviderDiagnostic {
  readonly code:
    "missing-credential" | "model-capability" | "provider-capability";
  readonly message: string;
  readonly capability?: Capability;
  readonly environmentVariable?: string;
}

export interface ProviderDiagnosticOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly credentialPresent?: boolean;
  readonly require?: Partial<Record<Capability, boolean>>;
}

export interface ProviderDiagnosticResult {
  readonly ok: boolean;
  readonly diagnostics: readonly ProviderDiagnostic[];
}

const credentialVariables: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const providerCapabilities: Readonly<Record<string, ReadonlySet<Capability>>> =
  {
    openai: new Set(["streaming", "systemRole", "tools", "images"]),
    anthropic: new Set([
      "streaming",
      "systemRole",
      "tools",
      "images",
      "documents",
      "promptCaching",
    ]),
    deepseek: new Set(["streaming", "systemRole", "tools", "promptCaching"]),
  };

export function diagnoseProvider(
  model: ModelSettings,
  options: ProviderDiagnosticOptions = {},
): ProviderDiagnosticResult {
  const diagnostics: ProviderDiagnostic[] = [];
  const environmentVariable = credentialVariables[model.provider];
  const credentialPresent =
    options.credentialPresent ??
    (environmentVariable === undefined
      ? true
      : Boolean(options.environment?.[environmentVariable]));
  if (!credentialPresent && environmentVariable !== undefined) {
    diagnostics.push({
      code: "missing-credential",
      environmentVariable,
      message: `Provider ${model.provider} requires ${environmentVariable}`,
    });
  }

  const supported = providerCapabilities[model.provider];
  for (const [name, required] of Object.entries(options.require ?? {}) as [
    Capability,
    boolean,
  ][]) {
    if (!required) {
      continue;
    }
    if (!model.capabilities[name]) {
      diagnostics.push({
        code: "model-capability",
        capability: name,
        message: `Model ${model.name} does not declare ${name} support`,
      });
    } else if (supported !== undefined && !supported.has(name)) {
      diagnostics.push({
        code: "provider-capability",
        capability: name,
        message: `Provider adapter ${model.provider} does not support ${name}`,
      });
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export class ProviderConfigurationError extends Error {
  override readonly name = "ProviderConfigurationError";
  readonly diagnostics: readonly ProviderDiagnostic[];

  constructor(result: ProviderDiagnosticResult) {
    super(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    );
    this.diagnostics = result.diagnostics;
  }
}

export function assertProviderReady(
  model: ModelSettings,
  options: ProviderDiagnosticOptions = {},
): void {
  const result = diagnoseProvider(model, options);
  if (!result.ok) {
    throw new ProviderConfigurationError(result);
  }
}
