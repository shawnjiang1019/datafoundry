import { AGENT_RUNTIME_LIMITS } from "../../config/agent-runtime-limits.js";
import { envAnnotationMaxCharsFromEnvironment } from "../../tools/env-annotation.js";
import {
  SCHEMA_MAX_COLUMNS_PER_TABLE,
  SCHEMA_MAX_TABLES,
  SQL_MAX_ACTIVITY_ROWS,
  SQL_MAX_CELL_CHARS,
  SQL_MAX_MODEL_ROWS,
  SQL_MAX_SQL_CHARS
} from "../inventory/context-limits.js";

export const DEFAULT_TOOL_OBSERVATION_SOURCE_LIMIT_PROFILES: Record<string, Record<string, number>> = {
  inspect_schema: {
    // The environment annotation is capped on its own (DF_ENV_ANNOTATION_MAX_CHARS), so it gets
    // that much room on top of the schema's share instead of pushing the result over the cap.
    additionalMaxChars: envAnnotationMaxCharsFromEnvironment(),
    maxColumnsPerTable: SCHEMA_MAX_COLUMNS_PER_TABLE,
    maxTables: SCHEMA_MAX_TABLES
  },
  "mcp__*": {
    maxChars: AGENT_RUNTIME_LIMITS.toolObservationMaxChars
  },
  run_sql_readonly: {
    maxActivityRows: SQL_MAX_ACTIVITY_ROWS,
    maxCellChars: SQL_MAX_CELL_CHARS,
    maxModelRows: SQL_MAX_MODEL_ROWS,
    maxSqlChars: SQL_MAX_SQL_CHARS
  }
};
