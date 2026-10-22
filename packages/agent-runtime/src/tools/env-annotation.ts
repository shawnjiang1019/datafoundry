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

/** Verbatim text from the source's own README / notes tables (deterministic, with its origin). */
export type EnvAnnotationTextEntry = { kind?: string; text: string; source?: string };

/** One model-written sentence: "checked" (numbers/values matched its facts) or "inferred". */
export type EnvAnnotationClaim = { text: string; verdict?: string };

export type EnvAnnotationTable = {
  columns: Record<string, EnvAnnotationColumn>;
  links?: EnvAnnotationLink[];
  /** Present only with the `author_text` layer enabled. */
  author_text?: { table: EnvAnnotationTextEntry[]; columns: Record<string, EnvAnnotationTextEntry[]> };
  /** Present only with the `descriptions` layer enabled. */
  descriptions?: { summary?: EnvAnnotationClaim; columns: Record<string, EnvAnnotationClaim> };
};

export type EnvAnnotation = {
  environment_id?: string;
  tables: Record<string, EnvAnnotationTable>;
};

/** Environment variable naming the exported annotation file the runtime attaches to every run. */
export const ENV_ANNOTATION_PATH_VARIABLE = "DF_ENV_ANNOTATION_PATH";

/**
 * Optional annotation layers to show beyond roles and links, comma-separated: `author_text`
 * (the source's own README / notes text, verbatim) and `descriptions` (model-written, labelled).
 * Unset or empty shows neither, so runs keep exactly the base annotation.
 */
export const ENV_ANNOTATION_LAYERS_VARIABLE = "DF_ENV_ANNOTATION_LAYERS";
export type EnvAnnotationLayer = "author_text" | "descriptions";
const KNOWN_LAYERS: readonly EnvAnnotationLayer[] = ["author_text", "descriptions"];

const DEFAULT_MAX_ANNOTATION_CHARS = 2500;
const MAX_LINKS_PER_TABLE = 6;
const MAX_AUTHOR_TEXT_CHARS = 400;
const MAX_DESCRIBED_COLUMNS = 8;
const ANNOTATION_NOTE =
  "D-Trail environment annotation from sampled metadata (advisory; verify against the data).";
const AUTHOR_TEXT_NOTE = "author_text is copied word for word from the source's own README / notes.";
const DESCRIPTIONS_NOTE =
  "model_descriptions are model-written readings of the facts, not facts: [inferred] is an "
  + "interpretation; [checked] only had its numbers and quoted values matched to the facts. "
  + "Verify before relying on either.";

/** The layers named by DF_ENV_ANNOTATION_LAYERS (unknown names are ignored). */
export const envAnnotationLayersFromEnvironment = (
  env: NodeJS.ProcessEnv = process.env
): EnvAnnotationLayer[] => {
  const named = new Set((env[ENV_ANNOTATION_LAYERS_VARIABLE] ?? "").split(",").map((part) => part.trim()));
  return KNOWN_LAYERS.filter((layer) => named.has(layer));
};

/**
 * Accept the exporter's `{environment_id, tables: {...}, author_text?, descriptions?}` file;
 * anything else is ignored. The optional sections are attached to their tables only for the
 * enabled `layers` (default: DF_ENV_ANNOTATION_LAYERS).
 */
export const parseEnvAnnotation = (
  value: unknown,
  layers: readonly EnvAnnotationLayer[] = envAnnotationLayersFromEnvironment()
): EnvAnnotation | undefined => {
  if (!isRecord(value) || !isRecord(value.tables)) {
    return undefined;
  }
  const authorText = layers.includes("author_text") && isRecord(value.author_text) ? value.author_text : {};
  const described = layers.includes("descriptions") && isRecord(value.descriptions)
    && isRecord(value.descriptions.tables)
    ? value.descriptions.tables
    : {};
  const tables: Record<string, EnvAnnotationTable> = {};
  for (const [name, table] of Object.entries(value.tables)) {
    if (isRecord(table) && isRecord(table.columns)) {
      const text = parseAuthorText(authorText[name]);
      const descriptions = parseDescriptions(described[name]);
      tables[name] = {
        columns: table.columns as Record<string, EnvAnnotationColumn>,
        links: Array.isArray(table.links) ? table.links.filter(isLink) : [],
        ...(text ? { author_text: text } : {}),
        ...(descriptions ? { descriptions } : {})
      };
    }
  }
  return {
    ...(typeof value.environment_id === "string" ? { environment_id: value.environment_id } : {}),
    tables
  };
};

const parseAuthorText = (value: unknown): EnvAnnotationTable["author_text"] | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const table = Array.isArray(value.table) ? value.table.filter(isTextEntry) : [];
  const columns: Record<string, EnvAnnotationTextEntry[]> = {};
  for (const [column, entries] of Object.entries(isRecord(value.columns) ? value.columns : {})) {
    const kept = Array.isArray(entries) ? entries.filter(isTextEntry) : [];
    if (kept.length > 0) {
      columns[column] = kept;
    }
  }
  return table.length > 0 || Object.keys(columns).length > 0 ? { table, columns } : undefined;
};

const parseDescriptions = (value: unknown): EnvAnnotationTable["descriptions"] | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const summary = isClaim(value.summary) ? value.summary : undefined;
  const columns: Record<string, EnvAnnotationClaim> = {};
  for (const [column, claim] of Object.entries(isRecord(value.columns) ? value.columns : {})) {
    if (isClaim(claim)) {
      columns[column] = claim;
    }
  }
  return summary || Object.keys(columns).length > 0 ? { ...(summary ? { summary } : {}), columns } : undefined;
};

const fileCache = new Map<string, { mtimeMs: number; annotation: EnvAnnotation | undefined }>();

/** Load an exported annotation file; unreadable or malformed files yield undefined (advisory input). */
export const loadEnvAnnotationFile = (
  path: string,
  layers: readonly EnvAnnotationLayer[] = envAnnotationLayersFromEnvironment()
): EnvAnnotation | undefined => {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const key = `${path}\u0000${layers.join(",")}`;
    const cached = fileCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.annotation;
    }
    const annotation = parseEnvAnnotation(JSON.parse(readFileSync(path, "utf8")), layers);
    fileCache.set(key, { mtimeMs, annotation });
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
  return path ? loadEnvAnnotationFile(path, envAnnotationLayersFromEnvironment(env)) : undefined;
};

type TableSummary = {
  eligibility_flags?: { column: string; keep_value?: string }[];
  competing_measures?: string[][];
  identifiers?: string[];
  links?: string[];
  /** Verbatim source text (author_text layer). */
  author_text?: string[];
  /** Model-written sentences, each ending in its verdict (descriptions layer). */
  model_descriptions?: { table?: string; columns?: Record<string, string> };
};

/**
 * The annotation for the named tables only, compact and capped at `maxChars`: tables with an
 * eligibility flag come first, then the rest in the given order. To fit, links are dropped first,
 * then the optional text layers, and whole tables only last.
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
  const render = (entries: typeof ordered, withLinks: boolean, withText: boolean) => {
    const tables = Object.fromEntries(entries.flatMap(({ name, summary }) => {
      const { links, author_text, model_descriptions, ...rest } = summary;
      const shown = {
        ...rest,
        ...(withLinks && links ? { links } : {}),
        ...(withText && author_text ? { author_text } : {}),
        ...(withText && model_descriptions ? { model_descriptions } : {})
      };
      return Object.keys(shown).length > 0 ? [[name, shown]] : [];
    }));
    const shownText = (key: "author_text" | "model_descriptions") =>
      withText && entries.some((entry) => entry.summary[key]);
    const omitted = ordered.length - entries.length;
    return {
      note: ANNOTATION_NOTE,
      ...(shownText("author_text") ? { author_text_note: AUTHOR_TEXT_NOTE } : {}),
      ...(shownText("model_descriptions") ? { model_descriptions_note: DESCRIPTIONS_NOTE } : {}),
      tables,
      ...(omitted > 0 ? { omitted_tables: omitted, hint: "inspect_schema with table_names shows a table's annotation" } : {})
    };
  };
  const fits = (rendered: unknown): boolean => JSON.stringify(rendered).length <= maxChars;
  // Full text, then compact text, then the base annotation (links kept) before cutting further,
  // so enabling a text layer never shows less than the base would.
  const compact = ordered.map(({ name, summary }) => ({ name, summary: compactText(summary) }));
  const attempts: Array<[typeof ordered, boolean, boolean]> = [
    [ordered, true, true],
    [ordered, false, true],
    [compact, true, true],
    [compact, false, true],
    [ordered, true, false]
  ];
  for (const [entries, withLinks, withText] of attempts) {
    const rendered = render(entries, withLinks, withText);
    if (fits(rendered)) {
      return rendered;
    }
  }
  const kept = [...ordered];
  let rendered = render(kept, false, false);
  while (kept.length > 1 && !fits(rendered)) {
    kept.pop();
    rendered = render(kept, false, false);
  }
  return rendered;
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
  const authorText = authorTextLines(table.author_text);
  const modelDescriptions = describedLines(table.descriptions, table.columns);
  const summary: TableSummary = {
    ...(flags.length ? { eligibility_flags: flags } : {}),
    ...(groups.size ? { competing_measures: [...groups.values()] } : {}),
    ...(identifiers.length ? { identifiers } : {}),
    ...(links.length ? { links } : {}),
    ...(authorText.length ? { author_text: authorText } : {}),
    ...(modelDescriptions ? { model_descriptions: modelDescriptions } : {})
  };
  return Object.keys(summary).length > 0 ? summary : undefined;
};

/** Table-level source text, then column notes, verbatim, up to MAX_AUTHOR_TEXT_CHARS in all. */
const authorTextLines = (text: EnvAnnotationTable["author_text"]): string[] => {
  if (!text) {
    return [];
  }
  const all = [
    ...text.table.map((entry) => entry.text),
    ...Object.values(text.columns).flatMap((entries) => entries.map((entry) => entry.text))
  ];
  const lines: string[] = [];
  let used = 0;
  for (const line of all) {
    if (used + line.length > MAX_AUTHOR_TEXT_CHARS) {
      const room = MAX_AUTHOR_TEXT_CHARS - used;
      if (room > 40) {
        lines.push(`${line.slice(0, room)}…`);
      }
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines;
};

/** Roles whose columns' descriptions are shown first, in this order. */
const DESCRIBED_ROLE_ORDER = ["eligibility_flag", "identifier"];

/** Sort key for a described column: by DESCRIBED_ROLE_ORDER, then columns without roles, and
 * other roles (competing measures, many look-alike sentences) last. */
const rolePriority = (column: EnvAnnotationColumn | undefined): number => {
  const roles = column?.roles ?? [];
  const ranked = DESCRIBED_ROLE_ORDER.findIndex((role) => roles.includes(role));
  return ranked >= 0 ? ranked : DESCRIBED_ROLE_ORDER.length + (roles.length > 0 ? 1 : 0);
};

/**
 * The table sentence and up to MAX_DESCRIBED_COLUMNS column sentences, each tagged [verdict];
 * columns ordered by role (eligibility flags first), then name.
 */
const describedLines = (
  described: EnvAnnotationTable["descriptions"],
  columnInfo: Record<string, EnvAnnotationColumn>
): TableSummary["model_descriptions"] | undefined => {
  if (!described) {
    return undefined;
  }
  const tag = (claim: EnvAnnotationClaim): string => `${claim.text} [${claim.verdict ?? "inferred"}]`;
  const columns = Object.entries(described.columns)
    .sort(([a], [b]) => rolePriority(columnInfo[a]) - rolePriority(columnInfo[b]) || a.localeCompare(b))
    .slice(0, MAX_DESCRIBED_COLUMNS);
  return {
    ...(described.summary ? { table: tag(described.summary) } : {}),
    ...(columns.length ? { columns: Object.fromEntries(columns.map(([name, claim]) => [name, tag(claim)])) } : {})
  };
};

/** The compact form of a table's text layers: the table sentence, the first two column
 * sentences (already ordered by role), and the first line of author text. */
const compactText = (summary: TableSummary): TableSummary => {
  const { author_text, model_descriptions, ...rest } = summary;
  const columns = Object.entries(model_descriptions?.columns ?? {}).slice(0, 2);
  const compactDescriptions = model_descriptions
    ? {
        ...(model_descriptions.table ? { table: model_descriptions.table } : {}),
        ...(columns.length ? { columns: Object.fromEntries(columns) } : {})
      }
    : undefined;
  return {
    ...rest,
    ...(author_text?.length ? { author_text: author_text.slice(0, 1) } : {}),
    ...(compactDescriptions && Object.keys(compactDescriptions).length ? { model_descriptions: compactDescriptions } : {})
  };
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

const isTextEntry = (value: unknown): value is EnvAnnotationTextEntry =>
  isRecord(value) && typeof value.text === "string" && value.text.length > 0;

const isClaim = (value: unknown): value is EnvAnnotationClaim =>
  isRecord(value) && typeof value.text === "string" && value.text.length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
