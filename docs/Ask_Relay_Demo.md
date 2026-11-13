# Ask Relay demo

Ask Relay answers a natural-language question about one prospect from that
prospect's saved website research. It is a minimal vertical slice:

```text
research_documents (saved Firecrawl pages)
  -> deterministic heading/paragraph chunks (exact source slices)
  -> OpenAI text-embedding-3-small, 1536 dimensions
  -> research_chunks.embedding (pgvector, migration 015)
  -> question embedding -> cosine search over ONE prospect's chunks (top 6)
  -> OpenAI answer that may cite only the retrieved chunks
  -> every citation quote checked against its chunk, including rendered link labels
  -> answer with source URLs, or "Not enough evidence"
```

## What the demo uses

- **Data:** the saved Firecrawl captures in `evals/fixtures/` (local and
  Git-ignored): `hvac-page.json`, `counseling-page.json`, and `relay-page.json`.
  No Firecrawl call is made.
- **Database:** a dedicated local Docker container, `relay-ask-demo`
  (`pgvector/pgvector:0.8.1-pg14`, the image `npm run verify` uses), with a
  persistent volume and a port published only on `127.0.0.1`. Every demo command
  pins `DATABASE_URL` to it, so `.env` cannot redirect the demo to another
  database. The seed script also refuses any database that is not a loopback
  database named `relay_demo`.
- **Demo prospects:** one per capture, with fixed IDs, named `Demo: <domain>`,
  stage `research_review`, and `cold_outreach_blocked = true`.
- **Paid calls:** only `index` (embeddings) and `ask` (question embedding plus
  one answer from `RELAY_RESEARCH_MODEL`). Each requires an explicit
  `--confirm-*` flag. Indexing the three captures embeds about 71 chunks once;
  later runs reuse the stored vectors.

## Prerequisites

1. Docker Desktop is running.
2. `npm install` has been run.
3. `evals/fixtures/hvac-page.json`, `counseling-page.json`, and
   `relay-page.json` exist.
4. `.env` (or the shell) provides `OPENAI_API_KEY` and `RELAY_RESEARCH_MODEL`.
   `DATABASE_URL` from `.env` is ignored by the demo commands.

## Run the demo

From the repository root:

```bash
# 1. Create the demo database, apply all migrations (first run only), and seed
#    the three captured websites. No OpenAI calls. Safe to re-run.
scripts/ask-relay-demo.sh up

# 2. Optional, free: show how each page will be chunked.
scripts/ask-relay-demo.sh preview

# 3. Embed every chunk once (paid OpenAI embeddings). Re-running reuses vectors.
scripts/ask-relay-demo.sh index --confirm-embeddings

# 4. Show that the vectors are stored in PostgreSQL (1536 dimensions).
scripts/ask-relay-demo.sh status

# 5. Ask questions. Each call embeds the question and drafts one answer.
scripts/ask-relay-demo.sh ask hvac --confirm-openai "Do they offer 24-hour emergency service, and where?"
scripts/ask-relay-demo.sh ask hvac --confirm-openai "What does the Loyalty Program offer?"
scripts/ask-relay-demo.sh ask counseling --confirm-openai "Can I attend therapy in person at their office?"
scripts/ask-relay-demo.sh ask relay --confirm-openai "How much does the Relay Launch package cost?"

# Unsupported questions should return "Not enough evidence".
scripts/ask-relay-demo.sh ask counseling --confirm-openai "Which health insurance plans do they accept?"
scripts/ask-relay-demo.sh ask hvac --confirm-openai "How much does a typical AC repair visit cost?"

# Prospect boundary: the counseling prospect's research has no HVAC content,
# and the HVAC chunks are never searched for it.
scripts/ask-relay-demo.sh ask counseling --confirm-openai "Do they install Daikin air conditioners?"
```

The sites are `hvac`, `counseling`, and `relay`. Steps 1–4 are needed only once
per database; after that, run step 5 with any question. Nothing has to be
re-seeded or edited between questions.

### Browser UI

```bash
scripts/ask-relay-demo.sh ui      # then open http://127.0.0.1:4311/  (Ctrl+C to stop)
```

The page lists the prospects that have embedded research, takes one question,
and shows the answer with its source URLs and verified quotes, or "Not enough
evidence". A pending answer page refreshes itself every second until the answer
is ready. Each question asked costs one OpenAI embedding and one answer call;
loading pages costs nothing. Set `RELAY_ASK_UI_PORT` to use another port.

- It uses the same `askRelay()` engine as the command line; nothing about
  retrieval, embeddings, or citation checks differs.
- It listens on `127.0.0.1` only, accepts questions only from its own page, uses
  no JavaScript, and keeps recent answers in memory only (a restart forgets
  them; nothing is written to the database).
- It connects only to the local `relay_demo` database. The launcher refuses any
  other database, including the one in `.env`, before connecting, then checks
  `current_database()` again. Start it with the wrapper command above.
- Resubmitting the same form, for example with a double-click, does not ask
  twice. At most two questions can be in progress at once.

For a future authorized question, set `RELAY_ASK_CITATION_DIAGNOSTICS=true`
when starting the UI to log only failed citation checks. Each diagnostic names
the citation index and source ID, the rejected quote, and a short matching
context from that source when available. It does not log the question, full
retrieved chunks, or the OpenAI request. Leave the flag unset for normal use.

### Reading the output

An answered question prints the answer, then `Sources:` with each cited
excerpt's URL and verified quote, then the retrieved chunks with their cosine
similarity. Source URLs come from the stored chunks, never from the model.

`Answer: Not enough evidence.` appears when:

- the model reports that the retrieved excerpts do not answer the question;
- any citation quote does not appear in the excerpt it cites (the drafted answer
  is withheld); or
- the prospect has no embedded research (no OpenAI call is made).

### Show the stored vectors directly

```bash
docker exec -it relay-ask-demo psql -U relay_demo -d relay_demo -c \
  "SELECT source_url, chunk_index, left(content, 60) AS content,
          vector_dims(embedding) AS dims, embedding_model
   FROM research_chunks ORDER BY source_url, chunk_index LIMIT 10"
```

### Tear down

```bash
scripts/ask-relay-demo.sh down    # removes the container, volume, and vectors
scripts/ask-relay-demo.sh reset   # down, then up (re-indexing is paid again)
```

## Using Ask Relay on a real prospect

The same commands work for any prospect whose research documents were saved by
`npm run research` (see the runbook, section 2, "Ask Relay commands"):

```bash
npm run ask-relay -- preview --prospect PROSPECT_UUID
npm run ask-relay -- index --prospect PROSPECT_UUID --confirm-embeddings
npm run ask-relay -- ask --prospect PROSPECT_UUID --confirm-openai "QUESTION"
```

These use `DATABASE_URL`, which may point at production. Migration 015 must be
applied through the reviewed migration process first, and `index` against a
shared or production database is a separately approved operation.

## Verification

- `npm run typecheck`
- `npx tsx --test tests/research/research-chunker.test.ts tests/research/ask-relay.test.ts`
  (no database, no network)
- `npm run verify` runs every test, including
  `tests/data/research-embeddings.test.ts`, in a disposable Docker database.
  To run only that suite: `npm run verify -- tests/data/research-embeddings.test.ts`.

All tests use fake embedding and answer providers.

## Limitations

- **Demo slice, not production integration.** Indexing is a manual command; the
  research worker does not embed new research automatically.
- **Citation checks prove the quotes, not every sentence.** A verified answer
  could still phrase something the quotes do not fully support.
- **The retrieval depth is fixed.** The six nearest chunks are sent to the model.
  A fact spread across many chunks, such as a full list of services, can be
  partly missed.
- **No similarity threshold.** Answerability is decided by the model plus the
  citation check, because similarity scores did not separate answerable from
  unanswerable questions in the retrieval evaluation.
- **Exact search, no ANN index.** Each search scans one prospect's chunks. This
  is correct and fast for tens to hundreds of chunks; an index would be needed
  only for cross-prospect search.
- **Chunking changes are deliberate.** Changing the chunker or its size makes
  stored chunks differ, and `index` stops instead of overwriting them.
- **The demo database password is fixed** (`relay_demo`). The port is bound to
  `127.0.0.1` only, and the database holds only public website text.
