/**
 * Input bindings adapted from aider/io.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch into bindings consumable by any terminal UI adapter.
 * Licensed under the Apache License, Version 2.0.
 */

export type EditingMode = "emacs" | "vi";
export type InputAction =
  | "submit"
  | "newline"
  | "external-editor"
  | "history-previous"
  | "history-next";

export interface KeyBinding {
  readonly key: string;
  readonly action: InputAction;
  readonly when?: "insert" | "normal";
}

export function terminalKeyBindings(
  mode: EditingMode,
  multiline: boolean,
): readonly KeyBinding[] {
  const enter: KeyBinding[] =
    mode === "vi" && multiline
      ? [
          { key: "enter", action: "newline", when: "insert" },
          { key: "enter", action: "submit", when: "normal" },
        ]
      : [{ key: "enter", action: multiline ? "newline" : "submit" }];
  return [
    ...enter,
    { key: "alt-enter", action: multiline ? "submit" : "newline" },
    { key: "ctrl-x ctrl-e", action: "external-editor" },
    { key: "ctrl-up", action: "history-previous" },
    { key: "ctrl-down", action: "history-next" },
  ];
}
