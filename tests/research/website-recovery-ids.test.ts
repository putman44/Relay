import assert from "node:assert/strict";
import { test } from "node:test";
import { isUuid } from "../../src/research/website-index.js";

// The recovery script once used a pattern with one hex group too few and rejected every real ID.
test("recovery identity validation accepts real-format UUIDs and rejects malformed values", () => {
  for (const id of [
    "aafb94ca-80bc-4e5f-9932-eeb8e61188f0",
    "6f431004-8b53-4b5a-99e0-bf5f88b25cee",
    "0810ab39-d8e0-484b-9d12-3fa2048ecc9e",
    "00000000-0000-4000-a000-000000000001",
    "AAFB94CA-80BC-4E5F-9932-EEB8E61188F0",
  ]) assert.equal(isUuid(id), true, id);

  for (const value of [
    "aafb94ca-80bc-4e5f-e61188f0abcd",
    "aafb94ca80bc4e5f9932eeb8e61188f0",
    "aafb94ca-80bc-4e5f-9932-eeb8e61188f",
    "aafb94ca-80bc-4e5f-9932-eeb8e61188f00",
    "aafb94ca-80bc-4e5f-9932-eeb8e61188fg",
    " aafb94ca-80bc-4e5f-9932-eeb8e61188f0",
    "aafb94ca-80bc-4e5f-9932-eeb8e61188f0\n",
    "aafb94ca-80bc-4e5f-9932-eeb8e61188f0; DROP TABLE prospects",
    "",
    undefined,
    null,
    42,
  ]) assert.equal(isUuid(value), false, String(value));
});
