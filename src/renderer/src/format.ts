// Small display helpers shared by the views.

// Token counts as in the status bar: 950, 48k, 12.5k, 1M, 1.05M.
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${trim((tokens / 1_000_000).toFixed(2))}M`;
  if (tokens >= 1000) return `${trim((tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1))}k`;
  return String(tokens);
}

// How long a tool ran: 140ms, 2.4s, 1m 05s.
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${trim((ms / 1000).toFixed(1))}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

// A rough token count for text not yet sent (about four characters per token), for the composer.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function trim(number: string): string {
  return number.includes('.') ? number.replace(/\.?0+$/, '') : number;
}

// UI conveniences only (panel visibility and width); the app works the same when storage is unavailable.
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore.
  }
}

// The model menu's group for a model id. Claude Code ids also start with 'claude-', so they are checked first.
export function modelGroup(id: string): 'Claude' | 'OpenAI' | 'Claude Code' | 'Other' {
  if (id.startsWith('claude-code/')) return 'Claude Code';
  if (id.startsWith('claude-')) return 'Claude';
  if (id.startsWith('gpt-')) return 'OpenAI';
  return 'Other';
}
