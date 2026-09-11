import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ConcreteApplicationService,
  decodeHtmlEntities,
  FakeProvider,
  htmlToReadableText,
  urlTokenBudget,
} from "../src/index.js";

describe("HTML to readable text", () => {
  it("keeps reading text and structure and drops markup, media, and attributes", () => {
    const html = `<!doctype html>
<html><head><title>Ignored</title><style>body{color:red}</style></head>
<body onload="steal()">
  <h1>Title</h1>
  <p>First <b>paragraph</b> with a <a href="https://example.com/a">link</a>.</p>
  <script>alert("no")</script>
  <svg><path d="M0 0"/></svg>
  <ul><li>one</li><li>two</li></ul>
  <p>Ends &amp; done&hellip;</p>
</body></html>`;

    expect(htmlToReadableText(html)).toBe(
      [
        "# Title",
        "",
        "First paragraph with a [link](https://example.com/a).",
        "",
        "- one",
        "- two",
        "",
        "Ends & done…",
      ].join("\n"),
    );
  });

  it("refuses to carry a script, data, or relative link target", () => {
    // A link whose target is not an absolute http(s) URL keeps its text and
    // loses the target, so no inline payload reaches the model.
    expect(
      htmlToReadableText(
        '<a href="javascript:steal()">click</a> <a href="data:text/html,x">or</a> <a href="/local">here</a>',
      ),
    ).toBe("click or here");
  });

  it("degrades on malformed markup instead of failing", () => {
    expect(htmlToReadableText("<p>open")).toBe("open");
    // An unterminated tag ends the document rather than being read as text.
    expect(htmlToReadableText("visible <p unterminated")).toBe("visible");
    expect(htmlToReadableText("<!-- comment -->kept")).toBe("kept");
    expect(htmlToReadableText("")).toBe("");
  });

  it("decodes the references a reader would see and leaves the rest alone", () => {
    expect(decodeHtmlEntities("a &lt; b &#65; &#x42; &nbsp;x")).toBe(
      "a < b A B  x",
    );
    // An unknown or unrepresentable reference stays as written.
    expect(decodeHtmlEntities("&notareference; &#xD800; &#0;")).toBe(
      "&notareference; &#xD800; &#0;",
    );
  });
});

describe("/web ingestion", () => {
  const create = async (
    fetchUrl: (
      url: string,
      options: { signal?: AbortSignal },
    ) => Promise<{ url: string; contentType: string; content: string }>,
  ) => {
    const root = await mkdtemp(join(tmpdir(), "patch-web-"));
    const provider = new FakeProvider([
      {
        actions: [
          { type: "text-delta", text: "answered" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: {
        provider,
        fetchUrl: async (url, options) => ({
          rendered: false,
          ...(await fetchUrl(url, options)),
        }),
      },
    });
    return { provider, service };
  };

  it("adds one user-named page to history as labeled, readable text", async () => {
    const requested: string[] = [];
    const { provider, service } = await create(async (url) => {
      requested.push(url);
      return {
        // Redirects can land elsewhere, and the label must name where the text
        // actually came from.
        url: "https://example.com/final",
        contentType: "text/html",
        content: "<h1>Doc</h1><p>Body text.</p>",
      };
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "web",
    });
    const submit = (message: string) =>
      session.submit(message, {
        signal: new AbortController().signal,
        emit: () => undefined,
      });

    await expect(
      submit("/web https://example.com/start"),
    ).resolves.toMatchObject({
      response: "Added https://example.com/final to the chat",
    });
    expect(requested).toEqual(["https://example.com/start"]);

    await submit("what does it say?");
    expect(provider.requests[0]?.messages).toContainEqual({
      role: "user",
      content:
        "Here is the content of https://example.com/final:\n\n# Doc\n\nBody text.",
    });
    await service.close();
  });

  it("truncates a page to a share of the input window", async () => {
    const { service } = await create(async () => ({
      url: "https://example.com/big",
      contentType: "text/plain",
      content: "x".repeat(500_000),
    }));
    const session = await service.createSession({
      principal: "test",
      sessionId: "web-big",
    });
    const submit = (message: string) =>
      session.submit(message, {
        signal: new AbortController().signal,
        emit: () => undefined,
      });

    await expect(submit("/web https://example.com/big")).resolves.toMatchObject(
      {
        response: expect.stringContaining("(truncated)"),
      },
    );
    const { messages } = (await session.snapshot()) as {
      messages: readonly { role: string; content: string }[];
    };
    const ingested = messages.find((message) =>
      message.content.startsWith("Here is the content of"),
    );
    expect(ingested?.content).toContain("[Truncated at about");
    // A page cannot take the whole window, whatever its size.
    expect(ingested?.content.length).toBeLessThan(500_000);
    await service.close();
  });

  it("budgets a share of the window and never less than a usable page", () => {
    expect(urlTokenBudget(128_000)).toBe(32_000);
    expect(urlTokenBudget(undefined)).toBe(2048);
    expect(urlTokenBudget(1000)).toBe(1024);
  });
});
