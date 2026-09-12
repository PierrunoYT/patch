/**
 * Ported from aider/models.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to resolve main, weak, and editor roles without recursive model
 * construction.
 * Licensed under the Apache License, Version 2.0.
 */

import type { EditFormat } from "../edits/types.js";
import { ModelCatalog, type ResolvedModel } from "./catalog.js";

export interface ModelSelectionOptions {
  readonly main: string;
  readonly weak?: string | false;
  readonly editor?: string | false;
  readonly editorEditFormat?: EditFormat;
}

export interface ModelSelection {
  readonly main: ResolvedModel;
  readonly weak: ResolvedModel;
  readonly editor: ResolvedModel;
  readonly editorEditFormat: EditFormat;
}

function secondary(
  catalog: ModelCatalog,
  main: ResolvedModel,
  requested: string | false | undefined,
  configured: string | undefined,
): ResolvedModel {
  const name = requested === false ? undefined : (requested ?? configured);
  return name === undefined || name === main.canonicalName
    ? main
    : catalog.resolve(name);
}

export function selectModels(
  catalog: ModelCatalog,
  options: ModelSelectionOptions,
): ModelSelection {
  const main = catalog.resolve(options.main);
  const weak = secondary(catalog, main, options.weak, main.settings.weakModel);
  const editor = secondary(
    catalog,
    main,
    options.editor,
    main.settings.editorModel,
  );
  return {
    main,
    weak,
    editor,
    editorEditFormat:
      options.editorEditFormat ??
      main.settings.editorEditFormat ??
      editor.settings.editFormat,
  };
}
