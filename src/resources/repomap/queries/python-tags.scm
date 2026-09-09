; Ported from aider/queries/tree-sitter-language-pack/python-tags.scm at revision
; 5dc9490bb35f9729ef2c95d00a19ccd30c26339c. Modified for Patch packaging.

(module (expression_statement (assignment left: (identifier) @name.definition.constant) @definition.constant))

(class_definition
  name: (identifier) @name.definition.class) @definition.class

(function_definition
  name: (identifier) @name.definition.function) @definition.function

(call
  function: [
      (identifier) @name.reference.call
      (attribute
        attribute: (identifier) @name.reference.call)
  ]) @reference.call
