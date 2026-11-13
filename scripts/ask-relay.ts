import "dotenv/config";
import {
  askOutput,
  indexOutput,
  parseAskRelayArgs,
  previewOutput,
} from "../src/operator/ask-relay-input.js";

async function main() {
  const command = parseAskRelayArgs(process.argv.slice(2));
  const { db } = await import("../src/db.js");
  try {
    const { indexProspectResearch, previewProspectResearch } =
      await import("../src/data/research-embeddings.js");
    if (command.action === "preview") {
      console.log(
        previewOutput(await previewProspectResearch(command.prospectId, db)),
      );
      return;
    }
    const { createOpenAIEmbedder } =
      await import("../src/research/openai-embeddings.js");
    const embed = createOpenAIEmbedder();
    if (command.action === "index") {
      console.log(
        indexOutput(
          await indexProspectResearch(command.prospectId, { database: db, embed }),
        ),
      );
      return;
    }
    const { askRelay } = await import("../src/research/ask-relay.js");
    const { createOpenAIAnswerer } =
      await import("../src/research/openai-answerer.js");
    const result = await askRelay(
      { prospectId: command.prospectId, question: command.question },
      { database: db, embed, answer: createOpenAIAnswerer() },
    );
    console.log(askOutput(result));
  } finally {
    await db.end();
  }
}
main().catch((error: unknown) => {
  console.error(
    `Ask Relay stopped: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
