# Local development dashboard

From the Relay repository root, run these commands in separate terminals:

```sh
npm run dev:init
npm run dev
```

Open http://127.0.0.1:4310/. The server shows its URL at startup and reloads when imported TypeScript source files change. Press Ctrl+C to stop the server. The `relay_dev` Docker database and its volume persist.

`dev:init` is an explicit, one-time copy of the existing `relay-ask-demo` database into a dedicated local `relay_dev` container. It copies saved research and vectors, then applies only migrations 016 and 017 if absent from the copy. It checks the source container label, target container and volume identity, loopback port, and database identity. If the target already exists, it preserves all data and checks its schema. An interrupted or incomplete import requires inspection; it is never automatically reset. Use `npm run dev:status` to see the dev database URL and vector count.

Starting the dashboard makes no Firecrawl, embedding, Ask Relay, or assessment generation calls. The visible Research, Ask Relay, and Generate Assessment actions can call paid providers when you submit them. The copied demo database has no saved lead assessment, so the assessment panel initially offers generation. It does not display the separate stored v5 trial assessment or the later offline replay as a persisted result. A newly generated assessment will be stored only in `relay_dev`.

The existing `scripts/ask-relay-demo.sh` commands continue to use `relay_demo` independently. Neither the dev startup nor initialization deletes or resets that database.
