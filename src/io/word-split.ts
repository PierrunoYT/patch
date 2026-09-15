/** Split shell-like words without treating Windows path separators as escapes. */
export class UnterminatedWordQuoteError extends Error {
  override readonly name = "UnterminatedWordQuoteError";
}

/**
 * Supports single/double quotes and POSIX-style escapes for whitespace, quotes,
 * and literal backslashes. A backslash before any other character is retained,
 * which keeps Windows drive and relative paths intact. Two leading backslashes
 * are retained as a UNC prefix; elsewhere a doubled backslash names one literal
 * backslash.
 */
export function splitQuotedWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  const finish = () => {
    if (started && current !== "") words.push(current);
    current = "";
    started = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] as string;
    if (quote === "'") {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (quote === '"') {
      if (character === quote) {
        quote = undefined;
        continue;
      }
      if (character === "\\") {
        const next = input[index + 1];
        if (next === '"') {
          current += next;
          index += 1;
        } else if (next === "\\") {
          if (current === "") current += "\\\\";
          else current += "\\";
          index += 1;
        } else {
          current += "\\";
        }
        continue;
      }
      current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      finish();
      continue;
    }
    if (character === "\\") {
      const next = input[index + 1];
      started = true;
      if (next === undefined) {
        current += "\\";
      } else if (/\s/u.test(next) || next === "'" || next === '"') {
        current += next;
        index += 1;
      } else if (next === "\\") {
        if (current === "") current += "\\\\";
        else current += "\\";
        index += 1;
      } else {
        current += "\\";
      }
      continue;
    }
    started = true;
    current += character;
  }
  if (quote !== undefined)
    throw new UnterminatedWordQuoteError("Word list has an unterminated quote");
  finish();
  return words;
}
