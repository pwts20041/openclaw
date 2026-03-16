import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  cosineSimilarity,
  parseEmbedding,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

/**
 * Extract a relevant snippet window around the query match in the text.
 * If the query is found, returns a window centered on the match.
 * Otherwise falls back to the beginning of the text.
 */
function extractRelevantSnippet(
  text: string,
  query: string,
  maxChars: number,
): { snippet: string; offsetLines: number } {
  if (text.length <= maxChars) {
    return { snippet: text, offsetLines: 0 };
  }

  // Try to find the query (case-insensitive) in the text
  const lowerText = text.toLowerCase();
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2);

  let matchIndex = -1;

  // Find the first matching term
  for (const term of queryTerms) {
    const idx = lowerText.indexOf(term);
    if (idx !== -1) {
      matchIndex = idx;
      break;
    }
  }

  // If no match found, fall back to beginning
  if (matchIndex === -1) {
    return { snippet: truncateUtf16Safe(text, maxChars), offsetLines: 0 };
  }

  // Calculate window start, trying to center the match
  const halfWindow = Math.floor(maxChars / 2);
  let windowStart = Math.max(0, matchIndex - halfWindow);
  let windowEnd = Math.min(text.length, windowStart + maxChars);

  // Adjust if we're near the end
  if (windowEnd === text.length && windowEnd - windowStart < maxChars) {
    windowStart = Math.max(0, windowEnd - maxChars);
  }

  // Try to start at a line boundary for cleaner output
  if (windowStart > 0) {
    const lineStart = text.lastIndexOf("\n", windowStart);
    if (lineStart !== -1 && windowStart - lineStart < 100) {
      windowStart = lineStart + 1;
      // Recalculate windowEnd to maintain maxChars length after snap
      windowEnd = Math.min(text.length, windowStart + maxChars);
    }
  }

  // Count lines before the window to adjust startLine/endLine display
  const textBeforeWindow = text.substring(0, windowStart);
  const offsetLines = (textBeforeWindow.match(/\n/g) || []).length;

  const snippet = text.substring(windowStart, windowEnd);
  return { snippet: truncateUtf16Safe(snippet, maxChars), offsetLines };
}


export type SearchSource = string;

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: SearchSource;
};

export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;
  providerModel: string;
  queryVec: number[];
  queryText: string;
  limit: number;
  snippetMaxChars: number;
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
  sourceFilterChunks: { sql: string; params: SearchSource[] };
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0) {
    return [];
  }
  if (await params.ensureVectorReady(params.queryVec.length)) {
    const rows = params.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
          `       c.source,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${params.vectorTable} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ?${params.sourceFilterVec.sql}\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        vectorToBlob(params.queryVec),
        params.providerModel,
        ...params.sourceFilterVec.params,
        params.limit,
      ) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: SearchSource;
      dist: number;
    }>;
    return rows.map((row) => {
      const { snippet, offsetLines } = extractRelevantSnippet(row.text, params.queryText, params.snippetMaxChars);
      return {
        id: row.id,
        path: row.path,
        startLine: row.start_line + offsetLines,
        endLine: row.end_line,
        score: 1 - row.dist,
        snippet,
        source: row.source,
      };
    });
  }

  const candidates = listChunks({
    db: params.db,
    providerModel: params.providerModel,
    sourceFilter: params.sourceFilterChunks,
  });
  const scored = candidates
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map((entry) => {
      const { snippet, offsetLines } = extractRelevantSnippet(
        entry.chunk.text,
        params.queryText,
        params.snippetMaxChars,
      );
      return {
        id: entry.chunk.id,
        path: entry.chunk.path,
        startLine: entry.chunk.startLine + offsetLines,
        endLine: entry.chunk.endLine,
        score: entry.score,
        snippet,
        source: entry.chunk.source,
      };
    });
}

export function listChunks(params: {
  db: DatabaseSync;
  providerModel: string;
  sourceFilter: { sql: string; params: SearchSource[] };
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
  source: SearchSource;
}> {
  const rows = params.db
    .prepare(
      `SELECT id, path, start_line, end_line, text, embedding, source\n` +
        `  FROM chunks\n` +
        ` WHERE model = ?${params.sourceFilter.sql}`,
    )
    .all(params.providerModel, ...params.sourceFilter.params) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: SearchSource;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    embedding: parseEmbedding(row.embedding),
    source: row.source,
  }));
}

export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  providerModel: string | undefined;
  query: string;
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: SearchSource[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
}): Promise<Array<SearchRowResult & { textScore: number }>> {
  if (params.limit <= 0) {
    return [];
  }
  const ftsQuery = params.buildFtsQuery(params.query);
  if (!ftsQuery) {
    return [];
  }

  // When providerModel is undefined (FTS-only mode), search all models
  const modelClause = params.providerModel ? " AND model = ?" : "";
  const modelParams = params.providerModel ? [params.providerModel] : [];

  const rows = params.db
    .prepare(
      `SELECT id, path, source, start_line, end_line, text,\n` +
        `       bm25(${params.ftsTable}) AS rank\n` +
        `  FROM ${params.ftsTable}\n` +
        ` WHERE ${params.ftsTable} MATCH ?${modelClause}${params.sourceFilter.sql}\n` +
        ` ORDER BY rank ASC\n` +
        ` LIMIT ?`,
    )
    .all(ftsQuery, ...modelParams, ...params.sourceFilter.params, params.limit) as Array<{
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  }>;

  return rows.map((row) => {
    const textScore = params.bm25RankToScore(row.rank);
    const { snippet, offsetLines } = extractRelevantSnippet(row.text, params.query, params.snippetMaxChars);
    return {
      id: row.id,
      path: row.path,
      startLine: row.start_line + offsetLines,
      endLine: row.end_line,
      score: textScore,
      textScore,
      snippet,
      source: row.source,
    };
  });
}
