; Ported from aider/queries/tree-sitter-language-pack/bash-tags.scm at revision
; 5dc9490bb35f9729ef2c95d00a19ccd30c26339c. Modified for Patch packaging.
; Licensed under the Apache License, Version 2.0.

(function_definition
  name: (word) @name.definition.function) @definition.function

(variable_assignment
  name: (variable_name) @name.definition.variable) @definition.variable

(command
  name: (command_name) @name.reference.call) @reference.call
