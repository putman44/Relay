// OpenAI embeddings for research chunks and Ask Relay questions. The model
// and dimension are fixed by migration 015; changing them needs a migration.
export const RESEARCH_EMBEDDING_MODEL = "text-embedding-3-small";
export const RESEARCH_EMBEDDING_DIMENSIONS = 1536;
// Inputs per request. Callers batch larger sets.
export const MAX_EMBEDDING_BATCH = 64;

export type Embedder = (texts: string[]) => Promise<number[][]>;
type Transport = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text">>;

export function isResearchEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === RESEARCH_EMBEDDING_DIMENSIONS &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

export function createOpenAIEmbedder(
  environment: { OPENAI_API_KEY?: string } = process.env,
  transport: Transport = fetch,
): Embedder {
  const key = environment.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is required for embeddings.");
  return async (texts) => {
    if (
      !Array.isArray(texts) ||
      texts.length < 1 ||
      texts.length > MAX_EMBEDDING_BATCH ||
      texts.some(
        (text) =>
          typeof text !== "string" ||
          !text.trim() ||
          Buffer.byteLength(text) > 30000,
      )
    )
      throw new Error("Embedding input is invalid.");
    const response = await transport("https://api.openai.com/v1/embeddings", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: RESEARCH_EMBEDDING_MODEL,
        input: texts,
        encoding_format: "float",
      }),
    });
    if (!response.ok)
      throw new Error(
        `Embedding request was rejected (HTTP ${response.status}).`,
      );
    const body = await response.text();
    if (Buffer.byteLength(body) > 20_000_000)
      throw new Error("Embedding response is too large.");
    const data = (JSON.parse(body) as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== texts.length)
      throw new Error("Embedding response does not match the request.");
    const embeddings: number[][] = new Array(texts.length);
    for (const item of data as Array<{ index?: unknown; embedding?: unknown }>) {
      const index = item?.index;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= texts.length ||
        embeddings[index] !== undefined ||
        !isResearchEmbedding(item.embedding)
      )
        throw new Error("Embedding response does not match the request.");
      embeddings[index] = item.embedding;
    }
    return embeddings;
  };
}
