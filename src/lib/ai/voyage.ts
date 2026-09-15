import "server-only";
import { aiConfig, limits } from "@/lib/config";
import { AppError } from "@/lib/errors";

/**
 * Voyage embeddings adapter.
 *
 * Indexed documents and live queries must use identical settings, so the model,
 * dimension, and input type travel with every stored vector and are compared on
 * read.
 */

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimension: number;
  totalTokens: number;
}

export async function embed(
  texts: string[],
  inputType: "query" | "document",
  signal?: AbortSignal,
): Promise<EmbeddingResult> {
  const config = aiConfig();
  if (!config.voyageApiKey) {
    throw new AppError("UPSTREAM_UNAVAILABLE", "The embedding provider is not configured.");
  }
  if (texts.length === 0) {
    return { vectors: [], model: config.voyageModel, dimension: config.voyageDimension, totalTokens: 0 };
  }

  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(limits.providerCallTimeoutMs)])
    : AbortSignal.timeout(limits.providerCallTimeoutMs);
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.voyageApiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: config.voyageModel,
      input_type: inputType,
      output_dimension: config.voyageDimension,
      truncation: true,
    }),
    signal: requestSignal,
  });

  if (!response.ok) {
    throw new AppError("UPSTREAM_UNAVAILABLE", `embedding provider returned ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding: number[]; index: number }>;
    usage?: { total_tokens?: number };
  };

  const rows = (payload.data ?? []).slice().sort((a, b) => a.index - b.index);
  if (rows.length !== texts.length) {
    throw new AppError("UPSTREAM_UNAVAILABLE", "embedding provider returned an unexpected row count");
  }

  const dimension = rows[0]?.embedding.length ?? config.voyageDimension;
  if (dimension !== config.voyageDimension) {
    // A dimension change invalidates the index; fail loudly rather than mixing.
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `embedding dimension ${dimension} does not match the configured ${config.voyageDimension}`,
    );
  }

  return {
    vectors: rows.map((row) => row.embedding),
    model: config.voyageModel,
    dimension,
    totalTokens: payload.usage?.total_tokens ?? 0,
  };
}

/** Formats a pgvector literal for a Postgres function argument. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`;
}
