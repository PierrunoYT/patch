import { z } from 'zod';
import type { InvokeChannel } from '@shared/ipc';
import { SECRET_NAMES } from '@shared/settings';

// What each invoke channel may be called with. The renderer's arguments come over IPC as untyped data, and the
// TypeScript types of `InvokeApi` are gone by then, so `handle()` parses them with these before a handler runs (#32).
// A channel's tuple is its argument list: an extra or missing argument is refused, and so is a wrong type, an
// out-of-range number or a string beyond its cap. Sizes are generous (they stop a runaway or hostile caller, not a
// long message); the handlers keep their own, more specific checks.

const MAX_TEXT = 2_000_000;
const MAX_PATH = 4096;
// A 5 MB image as base64 (the renderer refuses larger files), with a little room.
const MAX_BASE64 = 7_200_000;
const MAX_IMAGES = 20;
const MAX_SETTING = 50_000;

const path = z.string().min(1).max(MAX_PATH);
const text = z.string().max(MAX_TEXT);
const none = z.tuple([]);

// Plain data only: a setting's own validation lives in `SettingsStore`, which drops unknown keys and bad values.
const plainObject = z.record(z.string(), z.unknown());

const userMessage = z.object({
  text: z.string().max(MAX_TEXT),
  images: z
    .array(
      z.object({
        mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
        base64: z.string().min(1).max(MAX_BASE64),
        // Present on attachments from the picker; ignored by the main process.
        name: z.string().max(MAX_PATH).optional(),
      }),
    )
    .max(MAX_IMAGES)
    .optional(),
});

// An approval is a boolean; a string or a number that happens to be truthy must not approve (#32).
const approvalDecision = z.object({
  approved: z.boolean(),
  feedback: z.string().max(MAX_TEXT).optional(),
});

// A hidden or tiny panel can report 0 or 1; the terminal service clamps those itself.
const dimension = z.number().int().min(0).max(1000);

export const IPC_ARGS: Record<InvokeChannel, z.ZodTypeAny> = {
  'app:info': none,
  'log:renderer-error': z.tuple([
    z.object({
      source: z.enum(['error', 'unhandledrejection']),
      message: z.string().max(MAX_TEXT),
      stack: z.string().max(MAX_TEXT).optional(),
    }),
  ]),

  'settings:get': none,
  'settings:update': z.tuple([plainObject]),
  'settings:set-secret': z.tuple([z.enum(SECRET_NAMES as [string, ...string[]]), z.string().max(MAX_SETTING)]),
  'chatgpt:sign-in': none,
  'chatgpt:sign-out': none,

  'index:status': none,
  'index:rebuild': none,
  'mcp:status': none,

  'project:choose': none,
  'project:open': z.tuple([path]),
  'project:current': none,
  'project:list': none,
  'project:opened': none,
  'project:close': z.tuple([path]),
  'project:update-settings': z.tuple([
    path,
    z.object({
      instructions: z.string().max(MAX_SETTING),
      allowedCommands: z.string().max(MAX_SETTING),
      allowedNetworkHosts: z.string().max(MAX_SETTING),
    }),
  ]),
  'project:remove': z.tuple([path]),

  'chat:snapshot': none,
  'chat:send': z.tuple([userMessage]),
  'chat:stop': none,
  'chat:resume': none,
  'chat:compact': none,
  'edit:undo': z.tuple([z.string().max(MAX_PATH)]),
  'chat:new': none,
  'chat:decide': z.tuple([z.string().max(MAX_PATH), approvalDecision]),
  'chat:export': none,

  'history:list': none,
  'history:open': z.tuple([z.string().max(MAX_PATH)]),
  'history:delete': z.tuple([z.string().max(MAX_PATH)]),
  'history:clear': none,
  'history:search': z.tuple([z.string().max(10_000)]),

  'files:pick-images': none,
  'files:open-in-editor': z.tuple([path]),
  'files:list': none,

  'terminal:start': z.tuple([dimension, dimension]),
  'terminal:write': z.tuple([z.string().max(MAX_TEXT)]),
  'terminal:resize': z.tuple([dimension, dimension]),

  'git:status': none,
  'git:diff': z.tuple([z.string().max(MAX_PATH).nullable()]),
  'git:commit': z.tuple([text]),
  'git:discard': z.tuple([path]),
  'git:discard-all': none,
  'git:init': none,
  'git:push': none,
  'git:suggest-message': none,
};

// The arguments as the handler will get them. A refused call names the channel and the first problem, never the
// value, which can hold messages or file contents.
export function parseIpcArgs(channel: InvokeChannel, args: unknown[]): unknown[] {
  const result = IPC_ARGS[channel].safeParse(args);
  if (result.success) return result.data as unknown[];
  const issue = result.error.issues[0];
  const where = issue?.path.length ? ` (argument ${issue.path.join('.')})` : '';
  throw new Error(`Invalid arguments for ${channel}${where}: ${issue?.message ?? 'not accepted'}.`);
}
