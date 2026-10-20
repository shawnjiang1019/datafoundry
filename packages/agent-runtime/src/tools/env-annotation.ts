import { readFileSync, statSync } from "node:fs";

/**
 * D-Trail environment annotation, as exported by `dtrail-annotate --export-agent-json`: per table,
 * the sampled column roles (eligibility flags, competing measures, identifiers) and the metadata
 * links to other tables. Everything here is advisory: it enriches inspect_schema / preview_table
 * results and adds warnings to run_sql_readonly results, and never blocks or rewrites a call.
 */
export type EnvAnnotationColumn = {
  type?: string;
  roles?: string[];
  role_details?: {
    eligibility_flag?: { keep_value?: string };
    competing_measures?: { group?: string[] };
  };
  value_sample?: string[];
  cardinality?: string;
};

export type EnvAnnotationLink = {
  column: string;
  other_table: string;
  other_column: string;
  kind: string;
  signals?: string[];
  score?: number | null;
};

export type EnvAnnotationTable = {
  columns: Record<string, EnvAnnotationColumn>;
  links?: EnvAnnotationLink[];
};

export type EnvAnnotation = {
  environment_id?: string;
  tables: Record<string, EnvAnnotationTable>;
};

/** Environment variable naming the exported annotation file the runtime attaches to every run. */
export const ENV_ANNOTATION_PATH_VARIABLE = "DF_ENV_ANNOTATION_PATH";

const DEFAULT_MAX_ANNOTATION_CHARS = 2500;
const MAX_LINKS_PER_TABLE = 6;
const ANNOTATION_NOTE =
  "D-Trail environment annotation from sampled metadata (advisory; verify against the data).";

/** Accept the exporter's `{environment_id, tables: {...}}` file; anything else is ignored. */
export const parseEnvAnnotation = (value: unknown): EnvAnnotation | undefined => {
  if (!isRecord(value) || !isRecord(value.tables)) {
    return undefined;
  }
  const tables: Record<string, EnvAnnotationTable> = {};
  for (const [name, table] of Object.entries(value.tables)) {
    if (isRecord(table) && isRecord(table.columns)) {
      tables[name] = {
        columns: table.columns as Record<string, EnvAnnotationColumn>,
        links: Array.isArray(table.links) ? table.links.filter(isLink) : []
      };
    }
  }
  return {
    ...(typeof value.environment_id === "string" ? { environment_id: value.environment_id } : {}),
    tables
  };
};

const fileCache = new Map<string, { mtimeMs: number; annotation: EnvAnnotation | undefined }>();

/** Load an exported annotation file; unreadable or malformed files yield undefined (advisory input). */
export const loadEnvAnnotationFile = (path: string): EnvAnnotation | undefined => {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const cached = fileCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.annotation;
    }
    const annotation = parseEnvAnnotation(JSON.parse(readFileSync(path, "utf8")));
    fileCache.set(path, { mtimeMs, annotation });
    return annotation;
  } catch {
    return undefined;
  }
};

/** The annotation named by DF_ENV_ANNOTATION_PATH, or undefined when the variable is unset. */
export const envAnnotationFromEnvironment = (
  env: NodeJS.ProcessEnv = process.env
): EnvAnnotation | undefined => {
  const path = env[ENV_ANNOTATION_PATH_VARIABLE]?.trim();
  return path ? loadEnvAnnotationFile(path) : undefined;
};

type TableSummary = {
  eligibility_flags?: { column: string; keep_value?: string }[];
  competing_measures?: string[][];
  identifiers?: string[];
  links?: string[];
};

/**
 * The annotation for the named tables only, compact and capped at `maxChars`: tables with an
 * eligibility flag come first, then the rest in the given order; links are dropped before tables.
 * Undefined when no named table has anything to report.
 */
export const envAnnotationForTables = (
  annotation: EnvAnnotation,
  tableNames: string[],
  maxChars = DEFAULT_MAX_ANNOTATION_CHARS
): Record<string, unknown> | undefined => {
  const summaries = tableNames.flatMap((name) => {
    const table = lookupTable(annotation, name);
    const summary = table ? summarizeTable(table) : undefined;
    return summary ? [{ name, summary }] : [];
  });
  if (summaries.length === 0) {
    return undefined;
  }
  const ordered = [
    ...summaries.filter((entry) => entry.summary.eligibility_flags),
    ...summaries.filter((entry) => !entry.summary.eligibility_flags)
  ];
  const render = (entries: typeof ordered, withLinks: boolean) => {
    const tables = Object.fromEntries(entries.map(({ name, summary }) => {
      const { links, ...rest } = summary;
      return [name, withLinks && links ? { ...rest, links } : rest];
    }));
    const omitted = ordered.length - entries.length;
    return {
      note: ANNOTATION_NOTE,
      tables,
      ...(omitted > 0 ? { omitted_tables: omitted, hint: "inspect_schema with table_names shows a table's annotation" } : {})
    };
  };
  const full = render(ordered, true);
  if (JSON.stringify(full).length <= maxChars) {
    return full;
  }
  const kept = [...ordered];
  let withoutLinks = render(kept, false);
  while (kept.length > 1 && JSON.stringify(withoutLinks).length > maxChars) {
    kept.pop();
    withoutLinks = render(kept, false);
  }
  return withoutLinks;
};

const summarizeTable = (table: EnvAnnotationTable): TableSummary | undefined => {
  const flags: { column: string; keep_value?: string }[] = [];
  const groups = new Map<string, string[]>();
  const identifiers: string[] = [];
  for (const [column, info] of Object.entries(table.columns).sort(([a], [b]) => a.localeCompare(b))) {
    const roles = info.roles ?? [];
    if (roles.includes("eligibility_flag")) {
      const keep = info.role_details?.eligibility_flag?.keep_value;
      flags.push({ column, ...(keep ? { keep_value: keep } : {}) });
    }
    const group = info.role_details?.competing_measures?.group;
    if (roles.includes("competing_measures") && group && group.length > 1) {
      groups.set(group.join("\u0000"), group);
    }
    if (roles.includes("identifier")) {
      identifiers.push(column);
    }
  }
  const links = [...(table.links ?? [])]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || linkText(a).localeCompare(linkText(b)))
    .slice(0, MAX_LINKS_PER_TABLE)
    .map(linkText);
  const summary: TableSummary = {
    ...(flags.length ? { eligibility_flags: flags } : {}),
    ...(groups.size ? { competing_measures: [...groups.values()] } : {}),
    ...(identifiers.length ? { identifiers } : {}),
    ...(links.length ? { links } : {})
  };
  return Object.keys(summary).length > 0 ? summary : undefined;
};

const linkText = (link: EnvAnnotationLink): string =>
  `${link.column} -> ${link.other_table}.${link.other_column} (${link.kind}`
  + `${link.signals?.length ? `: ${link.signals.join(", ")}` : ""})`;

export type EnvAnnotationGuard = {
  /** Advisory warnings for one SQL statement; each warning is returned at most once per guard. */
  check(sql: string): string[];
};

/**
 * Check SQL against the annotation's roles: (1) a query that reads a table with an eligibility flag
 * but never mentions the flag column, and (2) a query that uses one column of a competing-measures
 * group without its siblings. Matching is lexical (identifier boundaries, case-insensitive); a
 * column only counts for a table the query mentions. One guard per run deduplicates warnings.
 */
export const createEnvAnnotationGuard = (annotation: EnvAnnotation): EnvAnnotationGuard => {
  const issued = new Set<string>();
  return {
    check(sql: string): string[] {
      const warnings: string[] = [];
      const add = (key: string, text: string): void => {
        if (!issued.has(key)) {
          issued.add(key);
          warnings.push(text);
        }
      };
      for (const [tableName, table] of Object.entries(annotation.tables).sort(([a], [b]) => a.localeCompare(b))) {
        if (!mentions(sql, tableName)) {
          continue;
        }
        for (const [column, info] of Object.entries(table.columns).sort(([a], [b]) => a.localeCompare(b))) {
          const roles = info.roles ?? [];
          if (roles.includes("eligibility_flag") && !mentions(sql, column)) {
            const keep = info.role_details?.eligibility_flag?.keep_value;
            const values = keep ? `keep ${keep}` : `values ${(info.value_sample ?? []).join(", ")}`;
            add(
              `eligibility:${tableName}:${column}`,
              `Table ${tableName} has eligibility flag ${column} (${values}) that this query does not filter; `
              + "if the question concerns samples/patients in the study, filter it"
              + (keep ? ` (${column} = ${keep}).` : ".")
            );
          }
          const group = info.role_details?.competing_measures?.group ?? [];
          if (roles.includes("competing_measures") && group.length > 1 && mentions(sql, column)) {
            // Only when no sibling is used too: a query reading several variants already chose.
            const alternatives = group.filter((name) => name !== column);
            if (alternatives.every((name) => !mentions(sql, name))) {
              add(
                `competing:${tableName}:${column}`,
                `Column ${column} of ${tableName} has competing variants: ${alternatives.join(", ")}; `
                + `confirm ${column} is the measure the question asks for.`
              );
            }
          }
        }
      }
      return warnings;
    }
  };
};

const lookupTable = (annotation: EnvAnnotation, name: string): EnvAnnotationTable | undefined => {
  const direct = annotation.tables[name];
  if (direct) {
    return direct;
  }
  const wanted = name.toLowerCase();
  const unqualified = wanted.slice(wanted.lastIndexOf(".") + 1);
  const match = Object.keys(annotation.tables).find((key) => {
    const lowered = key.toLowerCase();
    return lowered === wanted || lowered === unqualified;
  });
  return match ? annotation.tables[match] : undefined;
};

/** Whether `name` occurs in `sql` as a whole identifier (not inside a longer one), ignoring case. */
const mentions = (sql: string, name: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}($|[^A-Za-z0-9_])`, "iu").test(sql);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const isLink = (value: unknown): value is EnvAnnotationLink =>
  isRecord(value)
  && typeof value.column === "string"
  && typeof value.other_table === "string"
  && typeof value.other_column === "string"
  && typeof value.kind === "string";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
