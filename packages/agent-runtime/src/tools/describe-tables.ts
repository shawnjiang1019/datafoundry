import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { DESCRIBE_TABLES_SECTIONS, describeTables, type EnvAnnotation } from "./env-annotation.js";

export const DESCRIBE_TABLES_TOOL_NAME = "describe_tables";

const DESCRIPTION =
  "Read the D-Trail annotation for specific tables before querying or joining them: which rows count "
  + "(eligibility flags), which columns identify an entity, competing measures, which tables relate and on "
  + "which columns, the dataset's own README/notes, and model-written descriptions. Sections: roles, links, "
  + "related_tables, author_text, descriptions (default: all of these), and columns (type, cardinality and "
  + "sample values; narrow with `columns`). Advisory metadata: verify it against the data.";

/**
 * The describe_tables tool (DF_ENV_ANNOTATION_DELIVERY=tool): the full annotation for up to eight
 * tables, fitted to the annotation budget by whole sections. It reads the annotation only, never
 * the data, so it needs no schema_id and is allowed in every protocol phase.
 */
export const describeTablesInputSchema = z.object({
  table_names: z.array(z.string().min(1)).min(1).max(8),
  sections: z.array(z.enum(DESCRIBE_TABLES_SECTIONS)).optional(),
  columns: z.array(z.string().min(1)).max(50).optional()
});

export const createDescribeTablesTool = (annotation: EnvAnnotation) =>
  createTool({
    id: DESCRIBE_TABLES_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: describeTablesInputSchema,
    execute: async (toolInput) =>
      describeTables(annotation, toolInput.table_names, {
        ...(toolInput.sections ? { sections: toolInput.sections } : {}),
        ...(toolInput.columns ? { columns: toolInput.columns } : {})
      })
  });
