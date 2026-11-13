import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  askOutput,
  parseAskRelayArgs,
} from "../../src/operator/ask-relay-input.js";
import {
  citationsVerified,
  parseDraftAnswer,
} from "../../src/research/ask-relay.js";
import { createOpenAIAnswerer } from "../../src/research/openai-answerer.js";
import {
  createOpenAIEmbedder,
  RESEARCH_EMBEDDING_DIMENSIONS,
} from "../../src/research/openai-embeddings.js";

const prospectId = "00000000-0000-4000-a000-000000000001";
const vector = (value: number) =>
  new Array<number>(RESEARCH_EMBEDDING_DIMENSIONS).fill(value);
const reply = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

test("Embedder sends a tool-free embedding request and returns vectors in input order", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const embed = createOpenAIEmbedder({ OPENAI_API_KEY: "test-key" }, async (url, init) => {
    request = { url, init };
    return reply({
      data: [
        { index: 1, embedding: vector(0.2) },
        { index: 0, embedding: vector(0.1) },
      ],
    });
  });
  const result = await embed(["first", "second"]);
  assert.equal(result[0]![0], 0.1);
  assert.equal(result[1]![0], 0.2);
  assert.equal(request?.url, "https://api.openai.com/v1/embeddings");
  assert.equal(request?.init.redirect, "error");
  assert.deepEqual(JSON.parse(String(request?.init.body)), {
    model: "text-embedding-3-small",
    input: ["first", "second"],
    encoding_format: "float",
  });
});

test("Embedder rejects missing keys, bad input, and mismatched responses", async () => {
  assert.throws(() => createOpenAIEmbedder({}), /OPENAI_API_KEY/);
  const embedWith = (body: unknown, status = 200) =>
    createOpenAIEmbedder({ OPENAI_API_KEY: "k" }, async () => reply(body, status));
  const ok = embedWith({ data: [{ index: 0, embedding: vector(0) }] });
  await assert.rejects(ok([]), /input is invalid/);
  await assert.rejects(ok(["  "]), /input is invalid/);
  await assert.rejects(embedWith({}, 401)(["q"]), /HTTP 401/);
  for (const data of [
    [],
    [{ index: 0, embedding: [1, 2, 3] }],
    [{ index: 1, embedding: vector(0) }],
    [{ index: 0, embedding: [...vector(0).slice(1), Number.NaN] }],
    [
      { index: 0, embedding: vector(0) },
      { index: 0, embedding: vector(0) },
    ],
  ])
    await assert.rejects(
      embedWith({ data })(data.length === 2 ? ["a", "b"] : ["a"]),
      /does not match/,
    );
});

test("Answerer sends retrieved excerpts as untrusted data with a strict citation schema", async () => {
  let body: Record<string, any> = {};
  const answer = createOpenAIAnswerer(
    { OPENAI_API_KEY: "k", RELAY_RESEARCH_MODEL: "test-model" },
    async (_url, init) => {
      body = JSON.parse(String(init.body));
      return reply({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: '{"ok":true}' }],
          },
        ],
      });
    },
  );
  const sources = [
    { id: "S1", sourceUrl: "https://fictional.example.com/", text: "Open daily." },
  ];
  assert.equal(await answer("When are they open?", sources), '{"ok":true}');
  assert.equal(body.model, "test-model");
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, []);
  assert.match(body.instructions, /UNTRUSTED DATA/);
  assert.match(body.instructions, /insufficient_evidence/);
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(
    body.text.format.schema.properties.citations.items.properties.source.enum,
    ["S1"],
  );
  assert.deepEqual(JSON.parse(body.input[0].content), {
    question: "When are they open?",
    sources,
  });

  assert.throws(() => createOpenAIAnswerer({ OPENAI_API_KEY: "k" }), /RELAY_RESEARCH_MODEL/);
  const incomplete = createOpenAIAnswerer(
    { OPENAI_API_KEY: "k", RELAY_RESEARCH_MODEL: "m" },
    async () => reply({ status: "incomplete", output: [] }),
  );
  await assert.rejects(incomplete("q", sources), /did not complete/);
  await assert.rejects(answer("q", []), /requires retrieved sources/);
});

test("Draft answers must match the schema and cite only retrieved excerpts", () => {
  const ids = ["S1", "S2"];
  const valid = {
    status: "answered",
    answer: "They are open daily.",
    citations: [{ source: "S1", quote: "Open daily" }],
  };
  assert.deepEqual(parseDraftAnswer(JSON.stringify(valid), ids), valid);
  for (const bad of [
    "not json",
    { ...valid, extra: true },
    { ...valid, status: "maybe" },
    { ...valid, answer: " " },
    { ...valid, citations: [{ source: "S9", quote: "Open daily" }] },
    { ...valid, citations: [{ source: "S1" }] },
  ])
    assert.throws(() => parseDraftAnswer(bad, ids));
});

test("Citations verify only when every quote appears in its cited excerpt", () => {
  const sources = [
    { id: "S1", sourceUrl: "https://a.example.com/", text: "We’re **open daily**\nfrom 7 AM." },
    { id: "S2", sourceUrl: "https://a.example.com/b", text: "Free estimates." },
  ];
  const draft = (citations: { source: string; quote: string }[]) => ({
    status: "answered" as const,
    answer: "Answer.",
    citations,
  });
  assert.ok(citationsVerified(draft([{ source: "S1", quote: "We're open daily from 7 am" }]), sources));
  assert.equal(citationsVerified(draft([]), sources), false);
  // A real quote attributed to the wrong excerpt does not verify.
  assert.equal(citationsVerified(draft([{ source: "S2", quote: "open daily" }]), sources), false);
  // One fabricated quote fails the whole answer.
  assert.equal(
    citationsVerified(
      draft([
        { source: "S1", quote: "open daily" },
        { source: "S2", quote: "Free estimates and financing" },
      ]),
      sources,
    ),
    false,
  );
  assert.equal(citationsVerified(draft([{ source: "S1", quote: "we" }]), sources), false);
});

test("Ask Relay commands require exact arguments and explicit OpenAI confirmation", () => {
  assert.deepEqual(parseAskRelayArgs(["preview", "--prospect", prospectId]), {
    action: "preview",
    prospectId,
  });
  assert.deepEqual(
    parseAskRelayArgs(["index", "--prospect", prospectId, "--confirm-embeddings"]),
    { action: "index", prospectId },
  );
  assert.deepEqual(
    parseAskRelayArgs(["ask", "--prospect", prospectId, "--confirm-openai", "Who are they?"]),
    { action: "ask", prospectId, question: "Who are they?" },
  );
  for (const args of [
    [],
    ["index", "--prospect", prospectId],
    ["ask", "--prospect", prospectId, "Who are they?"],
    ["ask", "--prospect", "not-a-uuid", "--confirm-openai", "Who?"],
    ["ask", "--prospect", prospectId, "--confirm-openai", "Who", "are", "they?"],
    ["ask", "--prospect", prospectId, "--confirm-openai", "  "],
  ])
    assert.throws(() => parseAskRelayArgs(args), /Use preview/);
});

test("Answer output lists verified source URLs; insufficient output says so", () => {
  const retrieved = [{ sourceId: "S1", sourceUrl: "https://a.example.com/", similarity: 0.5 }];
  const answered = askOutput({
    question: "When?",
    status: "answered",
    reason: null,
    answer: "Daily.",
    citations: [{ sourceId: "S1", sourceUrl: "https://a.example.com/", quote: "Open daily" }],
    retrieved,
  });
  assert.match(answered, /Sources:\n {2}\[S1\] https:\/\/a\.example\.com\//);
  const insufficient = askOutput({
    question: "Insurance?",
    status: "insufficient_evidence",
    reason: "model_reported",
    answer: "The excerpts do not mention insurance.",
    citations: [],
    retrieved,
  });
  assert.match(insufficient, /Not enough evidence/);
  assert.doesNotMatch(insufficient, /Sources:/);
});
