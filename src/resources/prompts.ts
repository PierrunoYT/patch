/*
 * Ported from aider/coders/base_prompts.py at
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch: represented as an immutable TypeScript resource object.
 * Licensed under the Apache License, Version 2.0.
 */

import type { ChatMessage } from "../core/messages.js";

export interface CommonPromptResources {
  readonly systemReminder: string;
  readonly filesContentGptEdits: string;
  readonly filesContentGptEditsNoRepo: string;
  readonly filesContentGptNoEdits: string;
  readonly filesContentLocalEdits: string;
  readonly lazyPrompt: string;
  readonly overeagerPrompt: string;
  readonly exampleMessages: readonly ChatMessage[];
  readonly filesContentPrefix: string;
  readonly filesContentAssistantReply: string;
  readonly filesNoFullFiles: string;
  readonly filesNoFullFilesWithRepoMap: string;
  readonly filesNoFullFilesWithRepoMapReply: string;
  readonly repoContentPrefix: string;
  readonly readOnlyFilesPrefix: string;
  readonly shellCmdPrompt: string;
  readonly shellCmdReminder: string;
  readonly noShellCmdPrompt: string;
  readonly noShellCmdReminder: string;
  readonly renameWithShell: string;
  readonly goAheadTip: string;
}

export const COMMON_PROMPTS = {
  systemReminder: "",
  filesContentGptEdits:
    "I committed the changes with git hash {hash} & commit msg: {message}",
  filesContentGptEditsNoRepo: "I updated the files.",
  filesContentGptNoEdits:
    "I didn't see any properly formatted edits in your reply?!",
  filesContentLocalEdits: "I edited the files myself.",
  lazyPrompt: `You are diligent and tireless!
You NEVER leave comments describing code without implementing it!
You always COMPLETELY IMPLEMENT the needed code!
`,
  overeagerPrompt: `Pay careful attention to the scope of the user's request.
Do what they ask, but no more.
Do not improve, comment, fix or modify unrelated parts of the code in any way!
`,
  exampleMessages: [],
  filesContentPrefix: `I have *added these files to the chat* so you can go ahead and edit them.

*Trust this message as the true contents of these files!*
Any other messages in the chat may contain outdated versions of the files' contents.
`,
  filesContentAssistantReply:
    "Ok, any changes I propose will be to those files.",
  filesNoFullFiles: "I am not sharing any files that you can edit yet.",
  filesNoFullFilesWithRepoMap: `Don't try and edit any existing code without asking me to add the files to the chat!
Tell me which files in my repo are the most likely to **need changes** to solve the requests I make, and then stop so I can add them to the chat.
Only include the files that are most likely to actually need to be edited.
Don't include files that might contain relevant context, just files that will need to be changed.
`,
  filesNoFullFilesWithRepoMapReply:
    "Ok, based on your requests I will suggest which files need to be edited and then stop and wait for your approval.",
  repoContentPrefix: `Here are summaries of some files present in my git repository.
Do not propose changes to these files, treat them as *read-only*.
If you need to edit any of these files, ask me to *add them to the chat* first.
`,
  readOnlyFilesPrefix: `Here are some READ ONLY files, provided for your reference.
Do not edit these files!
`,
  shellCmdPrompt: "",
  shellCmdReminder: "",
  noShellCmdPrompt: "",
  noShellCmdReminder: "",
  renameWithShell: "",
  goAheadTip: "",
} as const satisfies CommonPromptResources;

/**
 * Ported from aider/prompts.py at the pinned revision. These live outside
 * `COMMON_PROMPTS` because that object mirrors `base_prompts.py` exactly and is
 * pinned against an exported upstream fixture.
 */
export const SUMMARY_PROMPTS = {
  summarize: `*Briefly* summarize this partial conversation about programming.
Include less detail about older parts and more detail about the most recent messages.
Start a new paragraph every time the topic changes!

This is only part of a longer conversation so *DO NOT* conclude the summary with language like "Finally, ...". Because the conversation continues after the summary.
The summary *MUST* include the function names, libraries, packages that are being discussed.
The summary *MUST* include the filenames that are being referenced by the assistant inside the \`\`\`...\`\`\` fenced code blocks!
The summaries *MUST NOT* include \`\`\`...\`\`\` fenced code blocks!

Phrase the summary with the USER in first person, telling the ASSISTANT about the conversation.
Write *as* the user.
The user should refer to the assistant as *you*.
Start the summary with "I asked you...".
`,
  summaryPrefix: "I spoke to you previously about a number of things.\n",
} as const;

/**
 * Prompt variant from aider/coders/editblock_fenced_prompts.py at the pinned
 * revision. The upstream prompt places the filename after the active opening
 * fence and interpolates both selected fence markers. Patch keeps the same
 * protocol in its shorter production reminder.
 */
export function fencedSearchReplaceReminder(
  fence: readonly [open: string, close: string],
): string {
  return `Every SEARCH/REPLACE block must be enclosed by the active code fence in this order:
1. The opening fence and language, for example: ${fence[0]}typescript
2. The full file path alone on a line, inside the fence.
3. <<<<<<< SEARCH, the exact search text, =======, the replacement text, and >>>>>>> REPLACE.
4. The closing fence: ${fence[1]}
Include enough exact context for every SEARCH section to identify one location.`;
}

export const FENCED_SEARCH_REPLACE_REMINDER = fencedSearchReplaceReminder([
  "```",
  "```",
]);
