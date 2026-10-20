import { describe, expect, it } from 'vitest';
import { dropUnknownStreamEvents, isUnknownStreamEvent } from './sse_filter';

const sse = (...events: string[]) => events.map((e) => `${e}\n\n`).join('');

describe('isUnknownStreamEvent', () => {
  it('flags a typed event the SDK does not know', () => {
    expect(isUnknownStreamEvent('event: codex.rate_limits\ndata: {"type":"codex.rate_limits"}')).toBe(true);
  });

  it('keeps known events, untyped chunks and [DONE]', () => {
    expect(isUnknownStreamEvent('data: {"type":"response.output_text.delta","delta":"hi"}')).toBe(false);
    expect(isUnknownStreamEvent('data: {"choices":[]}')).toBe(false);
    expect(isUnknownStreamEvent('data: [DONE]')).toBe(false);
    expect(isUnknownStreamEvent(': keep-alive')).toBe(false);
  });

  it('flags an untyped event only on a Responses stream', () => {
    expect(isUnknownStreamEvent('data: {"rate":1}', true)).toBe(true);
    expect(isUnknownStreamEvent('data: {"rate":1}')).toBe(false);
  });
});

describe('dropUnknownStreamEvents', () => {
  it('removes unknown events across chunk boundaries and keeps the rest', async () => {
    const body = sse(
      'data: {"type":"response.created"}',
      'data: {"type":"codex.rate_limits","x":1}',
      'data: {"type":"response.completed"}',
    );
    const split = Math.floor(body.length / 2);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body.slice(0, split)));
        controller.enqueue(encoder.encode(body.slice(split)));
        controller.close();
      },
    });
    const response = dropUnknownStreamEvents(
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    );
    expect(await response.text()).toBe(sse('data: {"type":"response.created"}', 'data: {"type":"response.completed"}'));
  });

  it('leaves non-stream responses alone', async () => {
    const original = new Response('{"type":"nope"}', { headers: { 'content-type': 'application/json' } });
    expect(dropUnknownStreamEvents(original)).toBe(original);
  });
});
