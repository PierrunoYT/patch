import { describe, expect, it } from "vitest";

import { retryAfterMilliseconds } from "../src/index.js";

describe("provider retry headers", () => {
  it("prefers milliseconds and caps untrusted delays", () => {
    expect(
      retryAfterMilliseconds(
        new Headers({ "retry-after-ms": "125.2", "retry-after": "9" }),
      ),
    ).toBe(126);
    expect(
      retryAfterMilliseconds(new Headers({ "retry-after": "999999" })),
    ).toBe(60_000);
  });

  it("accepts seconds and HTTP dates but rejects malformed values", () => {
    const now = Date.parse("2026-09-12T08:00:00Z");
    expect(
      retryAfterMilliseconds(new Headers({ "retry-after": "2.5" }), now),
    ).toBe(2500);
    expect(
      retryAfterMilliseconds(
        new Headers({ "retry-after": "Sat, 12 Sep 2026 08:00:03 GMT" }),
        now,
      ),
    ).toBe(3000);
    expect(
      retryAfterMilliseconds(new Headers({ "retry-after": "secret value" })),
    ).toBeUndefined();
    expect(
      retryAfterMilliseconds(new Headers({ "retry-after-ms": "-1" })),
    ).toBeUndefined();
  });
});
