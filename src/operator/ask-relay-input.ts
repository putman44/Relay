import type {
  ResearchDocumentIndexState,
  ResearchIndexResult,
} from "../data/research-embeddings.js";
import type { AskRelayResult } from "../research/ask-relay.js";

export type AskRelayCommand =
  | { action: "preview"; prospectId: string }
  | { action: "index"; prospectId: string }
  | { action: "ask"; prospectId: string; question: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAskRelayArgs(args: string[]): AskRelayCommand {
  const prospect = args[1] === "--prospect" && UUID.test(args[2] ?? "");
  if (args.length === 3 && args[0] === "preview" && prospect) {
    return { action: "preview", prospectId: args[2]! };
  }
  if (
    args.length === 4 &&
    args[0] === "index" &&
    prospect &&
    args[3] === "--confirm-embeddings"
  ) {
    return { action: "index", prospectId: args[2]! };
  }
  if (
    args.length === 5 &&
    args[0] === "ask" &&
    prospect &&
    args[3] === "--confirm-openai" &&
    !!args[4]?.trim()
  ) {
    return { action: "ask", prospectId: args[2]!, question: args[4] };
  }
  throw new Error(
    "Use preview --prospect UUID, index --prospect UUID --confirm-embeddings, " +
      'or ask --prospect UUID --confirm-openai "QUESTION" (quote the question).',
  );
}

export function previewOutput(states: ResearchDocumentIndexState[]): string {
  if (!states.length) return "No research documents are saved for this prospect.";
  return states
    .map(
      (state) =>
        `${state.sourceUrl}: ${state.chunks} chunks, ${state.embedded} embedded`,
    )
    .join("\n");
}

export function indexOutput(result: ResearchIndexResult): string {
  if (!result.documents)
    return "No research documents are saved for this prospect; nothing was embedded.";
  return (
    `Indexed ${result.documents} research document(s): ${result.chunks} chunks, ` +
    `${result.embedded} newly embedded, ${result.reused} already embedded.`
  );
}

export function askOutput(result: AskRelayResult): string {
  const lines = [`Question: ${result.question}`, ""];
  if (result.status === "answered") {
    lines.push("Answer:", result.answer, "", "Sources:");
    for (const citation of result.citations) {
      lines.push(`  [${citation.sourceId}] ${citation.sourceUrl}`);
      lines.push(`       "${citation.quote.replace(/\s+/g, " ")}"`);
    }
  } else {
    lines.push("Answer: Not enough evidence.", result.answer);
    if (result.reason === "unverified_citations")
      lines.push("(The model's citations did not match the retrieved text.)");
  }
  if (result.retrieved.length) {
    lines.push("", `Retrieved ${result.retrieved.length} chunks by vector similarity:`);
    for (const chunk of result.retrieved)
      lines.push(
        `  [${chunk.sourceId}] ${chunk.similarity.toFixed(3)}  ${chunk.sourceUrl}`,
      );
  }
  return lines.join("\n");
}
