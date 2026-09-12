/**
 * Settings display adapted from aider/commands.py and aider/format_settings.py
 * at revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to expose an explicit safe-field allowlist instead of
 * dumping configuration, environment, provider options, or partially masked
 * credentials.
 * Licensed under the Apache License, Version 2.0.
 */

export interface SafeSettingsView {
  readonly currentModel: string;
  readonly currentMode: string;
  readonly encoding: string;
  readonly git: boolean;
  readonly gitCommitVerify: boolean;
  readonly generateCommitMessages: boolean;
  readonly lintConfigured: boolean;
  readonly testConfigured: boolean;
  readonly rootCorrected: boolean;
}

function enabled(value: boolean): "enabled" | "disabled" {
  return value ? "enabled" : "disabled";
}

function configured(value: boolean): "configured" | "not configured" {
  return value ? "configured" : "not configured";
}

function safeLabel(value: string): string {
  // U+2028/U+2029 are separators rather than controls, but they end a line in
  // any consumer that splits on Unicode line breaks, so a label carrying one
  // could forge a further settings row.
  const cleaned = value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "�");
  return cleaned.length <= 256 ? cleaned : `${cleaned.slice(0, 255)}…`;
}

/** Render only fields whose names and value shapes are declared above. */
export function renderSettings(settings: SafeSettingsView): string {
  return [
    "Current session:",
    `Model: ${safeLabel(settings.currentModel)}`,
    `Chat mode: ${safeLabel(settings.currentMode)}`,
    "",
    "Effective startup settings:",
    `Encoding: ${safeLabel(settings.encoding)}`,
    `Git: ${enabled(settings.git)}`,
    `Git commit verification: ${enabled(settings.gitCommitVerify)}`,
    `Generated commit messages: ${enabled(settings.generateCommitMessages)}`,
    `Lint command: ${configured(settings.lintConfigured)}`,
    `Test command: ${configured(settings.testConfigured)}`,
    `Repository root corrected: ${settings.rootCorrected ? "yes" : "no"}`,
  ].join("\n");
}
