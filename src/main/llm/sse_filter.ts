import { appLog } from '../app_log';

// The OpenAI SDK's Responses stream accumulator throws "Unhandled response stream event: unknown" on an event type it
// does not know. ChatGPT's Codex backend (and some compatible servers) send extra events such as rate-limit updates,
// so a reply that streamed fine would still fail the turn. This drops those events before the SDK reads the stream.
const KNOWN_EVENT_TYPES = new Set([
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.output_text.annotation.added',
  'response.refusal.delta',
  'response.refusal.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.custom_tool_call_input.delta',
  'response.custom_tool_call_input.done',
  'response.mcp_call_arguments.delta',
  'response.mcp_call_arguments.done',
  'response.shell_call_command.added',
  'response.shell_call_command.delta',
  'response.shell_call_command.done',
  'response.shell_call_output_content.delta',
  'response.shell_call_output_content.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.code_interpreter_call_code.delta',
  'response.code_interpreter_call_code.done',
  'response.code_interpreter_call.in_progress',
  'response.code_interpreter_call.interpreting',
  'response.code_interpreter_call.completed',
  'response.file_search_call.in_progress',
  'response.file_search_call.searching',
  'response.file_search_call.completed',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
  'response.web_search_call.completed',
  'response.image_generation_call.in_progress',
  'response.image_generation_call.generating',
  'response.image_generation_call.completed',
  'response.image_generation_call.partial_image',
  'response.mcp_call.in_progress',
  'response.mcp_call.completed',
  'response.mcp_call.failed',
  'response.mcp_list_tools.in_progress',
  'response.mcp_list_tools.completed',
  'response.mcp_list_tools.failed',
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.audio.delta',
  'response.audio.done',
  'response.audio.transcript.delta',
  'response.audio.transcript.done',
  'response.compaction.compacting',
  'keepalive',
  'error',
]);

// The type of a typed JSON event in an SSE block: null when the event has none, undefined when the block is not a JSON
// event at all (comments, [DONE], unparsable data), which the SDK does not reject.
function eventType(block: string): string | null | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data.startsWith('{')) return undefined;
  try {
    const type = (JSON.parse(data) as { type?: unknown }).type;
    return typeof type === 'string' ? type : null;
  } catch {
    return undefined;
  }
}

// True for an SSE block the SDK would reject. A Responses stream needs a known type on every event; chat completions
// chunks have none, so there an untyped event passes.
export function isUnknownStreamEvent(block: string, responses = false): boolean {
  const type = eventType(block);
  if (type === undefined) return false;
  if (type === null) return responses;
  return !KNOWN_EVENT_TYPES.has(type);
}

export function dropUnknownStreamEvents(response: Response, responses = false): Response {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const keep = (block: string): boolean => {
    if (!isUnknownStreamEvent(block, responses)) return true;
    // Only the event's type name is logged, never its content.
    appLog.warn('llm', `Dropped an unknown stream event: ${String(eventType(block))}`);
    return false;
  };
  const filtered = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const blocks = pending.split(/\r?\n\r?\n/);
        pending = blocks.pop() ?? '';
        for (const block of blocks) {
          if (keep(block)) controller.enqueue(encoder.encode(`${block}\n\n`));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending && keep(pending)) controller.enqueue(encoder.encode(pending));
      },
    }),
  );
  return new Response(filtered, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
