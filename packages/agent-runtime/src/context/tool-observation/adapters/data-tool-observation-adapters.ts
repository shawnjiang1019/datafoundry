import { createHash } from "node:crypto";

import {
  asRecord,
  BaseToolObservationAdapter,
  boundStructuredValue,
  safeSerialize
} from "./base-tool-observation-adapter.js";
import type { ContextBudget } from "../../inventory/context-budget.js";
import { createContextItem, type ContextItem } from "../../inventory/context-item.js";
import { createContextSourceMetadata } from "../../inventory/context-source-metadata.js";

export class ListDataSourcesToolObservationAdapter extends BaseToolObservationAdapter {
  readonly toolName = "list_data_sources";
  readonly resultType = "data-list-sources";

  protected project(raw: unknown): unknown {
    return Array.isArray(raw) ? { datasources: raw } : asRecord(raw);
  }
}

export class PreviewTableToolObservationAdapter extends BaseToolObservationAdapter {
  readonly toolName = "preview_table";
  readonly resultType = "data-preview-table";

  /** Fit the preview by dropping rows, then columns, so the model always gets valid rows. */
  toContextItems(raw: unknown, budget: ContextBudget): ContextItem[] {
    return super.toContextItems(fitTablePreview(asRecord(raw), budget.maxChars ?? 12000), budget);
  }

  protected project(raw: unknown): unknown {
    return asRecord(raw);
  }
}

/** Longest cell text kept in a fitted preview. */
const PREVIEW_MAX_CELL_CHARS = 200;
/** Room left for the context package's own wrapping of the item. */
const PREVIEW_RESERVED_CHARS = 64;

/**
 * A `{columns, rows, ...}` preview cut to fit `maxChars` as whole rows and columns, never as cut-off
 * JSON: long cells are shortened first, then rows dropped from the end (at least one is kept),
 * then columns from the right. Every other field, the env annotation included, is kept whole, and
 * `rows_shown` / `rows_omitted` / `columns_omitted` say what was left out. A preview that is not
 * column/row shaped, or that cannot fit even as one column, is returned unchanged for the generic
 * bound to handle.
 */
export const fitTablePreview = (preview: Record<string, unknown>, maxChars: number): Record<string, unknown> => {
  const budget = Math.max(maxChars - PREVIEW_RESERVED_CHARS, 0);
  const fits = (value: unknown): boolean => safeSerialize(value).length <= budget;
  if (fits(preview) || !Array.isArray(preview.columns) || !Array.isArray(preview.rows)) {
    return preview;
  }
  const columns = preview.columns as unknown[];
  const rows = (preview.rows as unknown[]).map((row) =>
    Array.isArray(row) ? row.map(shortenCell) : row);
  const build = (rowCount: number, columnCount: number): Record<string, unknown> => ({
    ...preview,
    columns: columns.slice(0, columnCount),
    rows: rows.slice(0, rowCount).map((row) => (Array.isArray(row) ? row.slice(0, columnCount) : row)),
    rows_shown: Math.min(rowCount, rows.length),
    ...(rows.length > rowCount ? { rows_omitted: rows.length - rowCount } : {}),
    ...(columns.length > columnCount ? { columns_omitted: columns.length - columnCount } : {}),
    truncated: true
  });
  let rowCount = rows.length;
  while (rowCount > 1 && !fits(build(rowCount, columns.length))) {
    rowCount -= 1;
  }
  let columnCount = columns.length;
  while (columnCount > 1 && !fits(build(rowCount, columnCount))) {
    columnCount -= 1;
  }
  const fitted = build(rowCount, columnCount);
  return fits(fitted) ? fitted : preview;
};

const shortenCell = (cell: unknown): unknown =>
  typeof cell === "string" && cell.length > PREVIEW_MAX_CELL_CHARS
    ? `${cell.slice(0, PREVIEW_MAX_CELL_CHARS)}…`
    : cell;

export class RetrieveKnowledgeToolObservationAdapter extends BaseToolObservationAdapter {
  readonly toolName = "retrieve_knowledge";
  readonly resultType = "knowledge-retrieval";
  protected readonly modelGroupKind = "source";
  protected readonly sourceKind = "knowledge";
  protected readonly sourceOwner = "knowledge-retrieval";

  /** Project retrieved Knowledge chunks as chunk-level source items for precise dedupe and overlap decisions. */
  toContextItems(raw: unknown, budget: ContextBudget): ContextItem[] {
    const projected = this.project(raw);
    const chunks = extractKnowledgeChunks(projected);
    if (chunks.length === 0) {
      return super.toContextItems(raw, budget);
    }

    const record = asRecord(projected);
    const collectionId = stringField(record, "collection_id") ?? "unknown";
    const groupId = `${this.resultType}-observation`;
    const maxModelChars = Math.max(600, Math.floor((budget.maxChars ?? 12000) / chunks.length));
    const modelItems = chunks.map((chunk, index) => {
      const chunkKey = knowledgeChunkIdentity(collectionId, chunk, index);
      return createContextItem({
        id: `${this.resultType}-model-${chunkKey}`,
        sourceType: this.resultType,
        sourceId: chunkKey,
        groupId,
        visibility: "model",
        trust: "tool",
        retention: "supporting",
        priority: 25,
        content: boundStructuredValue(createKnowledgeChunkContent(collectionId, chunk), maxModelChars),
        metadata: createContextSourceMetadata({
          dedupeKeys: knowledgeChunkDedupeKeys(collectionId, chunk),
          exclusivityKey: `knowledge-chunk:${chunkKey}`,
          overlapKeys: knowledgeChunkOverlapKeys(collectionId, chunk),
          sourceKind: this.sourceKind,
          sourceOwner: this.sourceOwner
        }, { atomic: true, groupKind: "source", toolName: this.toolName })
      });
    });
    return [
      ...modelItems,
      createContextItem({
        id: `${this.resultType}-activity`,
        sourceType: this.resultType,
        sourceId: this.toolName,
        groupId,
        visibility: "activity",
        trust: "tool",
        retention: "reference",
        priority: 10,
        content: boundStructuredValue(projected, budget.maxChars ?? 12000),
        metadata: createContextSourceMetadata({
          dedupeKeys: [`knowledge-result:${stableHash(projected)}`],
          exclusivityKey: `knowledge-result:${stableHash(projected)}`,
          overlapKeys: chunks.flatMap((chunk) => knowledgeChunkOverlapKeys(collectionId, chunk)),
          sourceKind: this.sourceKind,
          sourceOwner: this.sourceOwner
        }, { atomic: true, groupKind: "reference", toolName: this.toolName })
      })
    ];
  }

  protected project(raw: unknown): unknown {
    return asRecord(raw);
  }

  protected createDedupeKeys(projected: unknown): string[] {
    const keys = this.knowledgeDedupeKeys(projected);
    return keys.length > 0 ? keys : [`knowledge-result:${stableHash(projected)}`];
  }

  protected createExclusivityKey(projected: unknown): string {
    const collectionId = stringField(asRecord(projected), "collection_id") ?? "unknown";
    return `knowledge-retrieval:${collectionId}:${stableHash(projected)}`;
  }

  protected createOverlapKeys(projected: unknown): string[] {
    return this.knowledgeOverlapKeys(projected);
  }

  private knowledgeDedupeKeys(projected: unknown): string[] {
    const record = asRecord(projected);
    const collectionId = stringField(record, "collection_id") ?? "unknown";
    return unique(extractKnowledgeChunks(projected).flatMap((chunk) => knowledgeChunkDedupeKeys(collectionId, chunk)));
  }

  private knowledgeOverlapKeys(projected: unknown): string[] {
    const record = asRecord(projected);
    const collectionId = stringField(record, "collection_id") ?? "unknown";
    return unique(extractKnowledgeChunks(projected).flatMap((chunk) => knowledgeChunkOverlapKeys(collectionId, chunk)));
  }
}

const createKnowledgeChunkContent = (
  collectionId: string,
  chunk: Record<string, unknown>
): Record<string, unknown> => ({
  collection_id: collectionId,
  ...chunk
});

const extractKnowledgeChunks = (value: unknown): Record<string, unknown>[] => {
  const record = asRecord(value);
  const chunks = Array.isArray(record.chunks) ? record.chunks : Array.isArray(value) ? value : [];
  return chunks.filter(isRecord);
};

const knowledgeChunkIdentity = (
  collectionId: string,
  chunk: Record<string, unknown>,
  index: number
): string => {
  const chunkId = stringField(chunk, "chunk_id");
  const documentId = stringField(chunk, "document_id");
  if (chunkId) {
    return chunkId;
  }
  if (documentId) {
    return `${documentId}:${index}`;
  }
  const content = stringField(chunk, "content") ?? stringField(chunk, "quote") ?? safeSerialize(chunk);
  return `${collectionId}:${contentHash(content)}`;
};

const knowledgeChunkDedupeKeys = (collectionId: string, chunk: Record<string, unknown>): string[] => {
  const chunkId = stringField(chunk, "chunk_id");
  const documentId = stringField(chunk, "document_id");
  const content = stringField(chunk, "content") ?? stringField(chunk, "quote");
  return unique([
    ...(chunkId ? [`knowledge-chunk:${chunkId}`] : []),
    ...(documentId && chunkId ? [`knowledge-citation:${documentId}:${chunkId}`] : []),
    ...(content ? [`knowledge-content:${collectionId}:${contentHash(content)}`] : [])
  ]);
};

const knowledgeChunkOverlapKeys = (collectionId: string, chunk: Record<string, unknown>): string[] => {
  const content = stringField(chunk, "content") ?? stringField(chunk, "quote");
  if (!content) {
    return [];
  }
  const hash = contentHash(content);
  return [`content:${hash}`, `content:${collectionId}:${hash}`];
};

const stableHash = (value: unknown): string => contentHash(safeSerialize(value));

const contentHash = (text: string): string =>
  createHash("sha256").update(normalizeOverlapText(text)).digest("hex");

const normalizeOverlapText = (text: string): string => text.toLowerCase().replaceAll(/\s+/gu, " ").trim();

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const unique = (values: string[]): string[] => [...new Set(values)].sort((left, right) => left.localeCompare(right));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
