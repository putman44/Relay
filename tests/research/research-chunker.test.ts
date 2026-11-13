import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  chunkResearchMarkdown,
  RESEARCH_CHUNK_MAX_CHARS,
} from "../../src/research/research-chunker.js";

const page = [
  "Proud to serve Riverbend and Oak Hollow",
  "# Fictional Comfort Co.",
  "We repair furnaces and air conditioners for homes in Riverbend.",
  "## Emergency service",
  "Technicians answer calls 24 hours a day, every day.",
  "![badge](https://cdn.example.com/badge.png)",
  "## Service area",
  "### Towns",
  "Riverbend, Oak Hollow, and Pine Flats.",
].join("\n\n");

test("Chunks are exact slices of the source Markdown", () => {
  const chunks = chunkResearchMarkdown(page);
  assert.ok(chunks.length > 0);
  for (const [position, chunk] of chunks.entries()) {
    assert.equal(chunk.index, position);
    assert.equal(chunk.content, page.slice(chunk.start, chunk.end));
    assert.equal(chunk.content, chunk.content.trim());
  }
});

test("Headings start chunks and consecutive headings stay with their content", () => {
  const contents = chunkResearchMarkdown(page).map((chunk) => chunk.content);
  assert.deepEqual(contents, [
    "Proud to serve Riverbend and Oak Hollow",
    "# Fictional Comfort Co.\n\nWe repair furnaces and air conditioners for homes in Riverbend.",
    // The trailing image-only block adds no text, so it is not appended.
    "## Emergency service\n\nTechnicians answer calls 24 hours a day, every day.",
    "## Service area\n\n### Towns\n\nRiverbend, Oak Hollow, and Pine Flats.",
  ]);
});

test("Image-only blocks and thematic breaks never form chunks", () => {
  const markdown = [
    "![logo](https://cdn.example.com/logo.png)",
    "First section text.",
    "* * *",
    "[](https://example.com/empty-link)",
    "---",
    "Second section text.",
  ].join("\n\n");
  assert.deepEqual(
    chunkResearchMarkdown(markdown).map((chunk) => chunk.content),
    ["First section text.", "Second section text."],
  );
});

test("Paragraphs are packed up to the size limit", () => {
  const paragraph = "Fictional sentence about seasonal maintenance plans. ".repeat(4).trim();
  const markdown = Array.from({ length: 12 }, () => paragraph).join("\n\n");
  const chunks = chunkResearchMarkdown(markdown);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= RESEARCH_CHUNK_MAX_CHARS);
    assert.equal(chunk.content, markdown.slice(chunk.start, chunk.end));
  }
  // Every paragraph lands in exactly one chunk, in order.
  assert.equal(
    chunks.map((chunk) => chunk.content).join("\n\n"),
    markdown,
  );
});

test("An oversized block is split into ordered slices that keep every word", () => {
  const sentence = "Our licensed team serves Riverbend homes year-round. ";
  const block = sentence.repeat(60).trim();
  const markdown = `## Long section\n\n${block}`;
  const chunks = chunkResearchMarkdown(markdown, 400);
  assert.ok(chunks.length > 2);
  let previousEnd = 0;
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= 400);
    assert.ok(chunk.start >= previousEnd);
    assert.equal(chunk.content, markdown.slice(chunk.start, chunk.end));
    previousEnd = chunk.end;
  }
  const words = (text: string) => text.split(/\s+/).filter(Boolean);
  assert.deepEqual(
    words(chunks.map((chunk) => chunk.content).join(" ")),
    words(markdown),
  );
});

test("A hard cut never splits a surrogate pair", () => {
  const markdown = "😀".repeat(300);
  for (const chunk of chunkResearchMarkdown(markdown, 101)) {
    const first = chunk.content.charCodeAt(0);
    const last = chunk.content.charCodeAt(chunk.content.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff));
    assert.ok(!(last >= 0xd800 && last <= 0xdbff));
  }
});

test("Chunking is deterministic and handles CRLF and empty input", () => {
  assert.deepEqual(chunkResearchMarkdown(page), chunkResearchMarkdown(page));
  const crlf = "# Title\r\n\r\nBody text.\r\n\r\n## Next\r\n\r\nMore text.";
  assert.deepEqual(
    chunkResearchMarkdown(crlf).map((chunk) => chunk.content),
    ["# Title\r\n\r\nBody text.", "## Next\r\n\r\nMore text."],
  );
  assert.deepEqual(chunkResearchMarkdown(""), []);
  assert.deepEqual(chunkResearchMarkdown(" \n\n \n"), []);
  assert.throws(() => chunkResearchMarkdown(page, 10), /at least 100/);
});
