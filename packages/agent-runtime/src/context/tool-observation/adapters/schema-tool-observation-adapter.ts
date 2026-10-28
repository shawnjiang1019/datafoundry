import type { SchemaSummary } from "@datafoundry/data-gateway";

import type { ContextBudget } from "../../inventory/context-budget.js";
import type { ContextItem } from "../../inventory/context-item.js";
import {
  DEFAULT_TOOL_OBSERVATION_PROJECTION_POLICY,
  projectSchemaToolObservation
} from "../tool-observation-projection-policy.js";
import { toolObservationProjectionToItems } from "../tool-observation-projection-items.js";
import type { ToolObservationAdapter } from "../tool-observation-adapter.js";

type SchemaResultInput = SchemaSummary & {
  env_annotation?: Record<string, unknown>;
  describe_tables?: Record<string, unknown>;
  schema_id?: string;
};

/** Room kept beside the annotation for its keys and the result wrapper. */
const ANNOTATION_KEY_MARGIN = 256;

/** Replaces annotation blocks that exceed their room, so the result stays valid and says where to look. */
const ANNOTATION_TOO_LARGE = {
  note: "The environment annotation for these tables is larger than this result allows.",
  hint: "Call describe_tables for the tables you need, or inspect_schema with table_names."
};

export class SchemaToolObservationAdapter implements ToolObservationAdapter {
  readonly toolName = "inspect_schema";
  readonly resultType = "schema";
  readonly sourceType = "tool-observation";

  toContextItems(raw: unknown, budget: ContextBudget): ContextItem[] {
    const schema = normalizeSchemaResultInput(raw);
    if (!schema) {
      return toolObservationProjectionToItems(createInvalidSchemaProjection(raw), this.resultType, 10);
    }
    // The annotation has its own room in the budget (additionalMaxChars); the schema is fitted to
    // the rest, so a large annotation can no longer push the whole result over the cap.
    const annotationRoom = getLimit(budget, "additionalMaxChars", 0);
    const reserved = annotationRoom > 0 ? annotationRoom + ANNOTATION_KEY_MARGIN : 0;
    const projection = projectSchemaToolObservation(schema, {
      ...DEFAULT_TOOL_OBSERVATION_PROJECTION_POLICY,
      schema: {
        max_chars: (budget.maxChars ?? DEFAULT_TOOL_OBSERVATION_PROJECTION_POLICY.schema.max_chars) - reserved,
        max_columns_per_table: getLimit(
          budget,
          "maxColumnsPerTable",
          DEFAULT_TOOL_OBSERVATION_PROJECTION_POLICY.schema.max_columns_per_table
        ),
        max_tables: getLimit(budget, "maxTables", DEFAULT_TOOL_OBSERVATION_PROJECTION_POLICY.schema.max_tables)
      }
    });
    if (schema.schema_id) {
      projection.model = { ...(projection.model as SchemaSummary), schema_id: schema.schema_id };
      projection.activity = { ...(projection.activity as SchemaSummary), schema_id: schema.schema_id };
    }
    // Already capped by the tool registry (envAnnotationForTables / describeTables); appended after
    // the schema, within the annotation's room.
    const blocks = annotationBlocks(schema, annotationRoom);
    if (Object.keys(blocks).length > 0) {
      projection.model = { ...(projection.model as SchemaSummary), ...blocks };
      projection.activity = { ...(projection.activity as SchemaSummary), ...blocks };
    }
    return toolObservationProjectionToItems(projection, this.resultType, 10);
  }
}

/** The result's annotation blocks, or a pointer in their place when they exceed `room` (0: no check). */
const annotationBlocks = (schema: SchemaResultInput, room: number): Record<string, unknown> => {
  const blocks = {
    ...(schema.env_annotation ? { env_annotation: schema.env_annotation } : {}),
    ...(schema.describe_tables ? { describe_tables: schema.describe_tables } : {})
  };
  const size = Object.values(blocks).reduce((total, block) => total + JSON.stringify(block).length, 0);
  if (room > 0 && size > room) {
    return { env_annotation: ANNOTATION_TOO_LARGE };
  }
  return blocks;
};

const getLimit = (budget: ContextBudget, key: string, defaultValue: number): number =>
  budget.sourceLimits?.[key] ?? defaultValue;

const normalizeSchemaResultInput = (raw: unknown): SchemaResultInput | undefined => {
  if (!isRecord(raw) || !Array.isArray(raw.tables)) {
    return undefined;
  }
  const schema: SchemaResultInput = {
    datasource_id: typeof raw.datasource_id === "string" ? raw.datasource_id : "unknown",
    tables: raw.tables.filter(isSchemaTable)
  };
  if (typeof raw.schema_id === "string") {
    schema.schema_id = raw.schema_id;
  }
  if (isRecord(raw.env_annotation)) {
    schema.env_annotation = raw.env_annotation;
  }
  if (isRecord(raw.describe_tables)) {
    schema.describe_tables = raw.describe_tables;
  }
  return schema;
};

const createInvalidSchemaProjection = (raw: unknown) => {
  const serialized = safeSerialize(raw);
  const preview = serialized.slice(0, 4000);
  const content = {
    tool_result_invalid: true,
    tool_name: "inspect_schema",
    reason: "Tool observation did not contain a schema summary.",
    preview
  };

  return {
    model: content,
    activity: content,
    artifactRefs: [],
    auditRefs: [],
    truncation: [{
      sourceId: "schema-result-invalid",
      truncated: serialized.length > preview.length,
      reason: "Invalid schema tool observation preview was bounded for model context.",
      originalSize: serialized.length,
      returnedSize: preview.length
    }]
  };
};

const isSchemaTable = (value: unknown): value is SchemaSummary["tables"][number] => {
  if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.columns)) {
    return false;
  }
  return value.columns.every((column) =>
    isRecord(column) &&
    typeof column.name === "string" &&
    typeof column.type === "string" &&
    (column.nullable === undefined || typeof column.nullable === "boolean")
  );
};

const safeSerialize = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
