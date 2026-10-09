import type {
  GroundingCandidate,
  GroundingSchema,
  LakeSemantics,
  SemanticEvidence,
  SemanticFact
} from "./types.js";
import { intersect, isIdentifierLike, isKeyType, normalizedName, terms } from "./vocabulary.js";

const DEFAULT_MAX_FOCUS_COLUMNS = 5;
const DEFAULT_MAX_CANDIDATES = 24;
const RULE_WEIGHT: Record<SemanticEvidence["rule"], number> = {
  same_name: 0.6,
  target_name_in_source_context: 0.4,
  identifier_names_target_table: 0.5
};

type Column = { table: string; column: string; type: string; description?: string; fact?: SemanticFact };

/**
 * Semantic candidate generation. Finds the key columns the question is about, then lists
 * every key column in another table that names or documentation tie to it.
 *
 * This stage is for recall. It never picks one target among several plausible ones:
 * "RAWS ID number" supports Station ID, WX ID, NESS ID, NWS ID and MesoWest Station ID
 * equally, and only the data can tell them apart.
 */
export const linkCandidates = (input: {
  question: string;
  schema: GroundingSchema;
  lake: LakeSemantics;
  maxFocusColumns?: number;
  maxCandidates?: number;
}): GroundingCandidate[] => {
  const factByColumn = new Map(input.lake.facts.map((fact) =>
    [columnKey(fact.subject.table, fact.subject.column), fact]));
  const dictionaries = new Set(input.lake.dictionaryTables);
  const questionTerms = terms(input.question);
  if (questionTerms.size === 0) {
    return [];
  }
  const columns: Column[] = input.schema.tables
    .filter((table) => !dictionaries.has(table.name))
    .flatMap((table) => table.columns
      .filter((column) => isKeyType(column.type))
      .map((column) => {
        const fact = factByColumn.get(columnKey(table.name, column.name));
        return {
          table: table.name,
          column: column.name,
          type: column.type,
          ...(fact ? { description: fact.text, fact } : {})
        };
      }));
  const relevanceOf = (column: Column): number =>
    intersect(questionTerms, new Set([
      ...terms(column.column),
      ...terms(column.description),
      ...terms(column.table)
    ])).length / questionTerms.size;
  const excluded = duplicateCopies(input.lake, columns, relevanceOf);

  const focus = columns
    .filter((column) => !excluded.has(column.table))
    .map((column) => ({ column, relevance: relevanceOf(column) }))
    .filter((entry) => entry.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, input.maxFocusColumns ?? DEFAULT_MAX_FOCUS_COLUMNS);

  const candidates: GroundingCandidate[] = [];
  for (const { column: source, relevance } of focus) {
    for (const target of columns) {
      if (target.table === source.table || excluded.has(target.table)) {
        continue;
      }
      const evidence = semanticEvidence(source, target);
      if (evidence.length > 0) {
        candidates.push({
          from: { table: source.table, column: source.column },
          to: { table: target.table, column: target.column },
          relation: "references",
          relevance: round(relevance),
          semanticEvidence: evidence
        });
      }
    }
  }
  return candidates
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, input.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
};

export const semanticScore = (candidate: GroundingCandidate): number =>
  Math.min(1, candidate.semanticEvidence.reduce((sum, evidence) => sum + RULE_WEIGHT[evidence.rule], 0));

/**
 * Three signals, each kept as evidence so a reader can see why a candidate exists:
 * - same column name (DataBridge joins.py name heuristic)
 * - the target column's name appears in the source's name or description (start_year -> Year)
 * - the source is an identifier whose name or description names the target table, and the
 *   target is identifier-like ("RAWS ID number" -> any ID column of the RAWS table)
 * Shared description words alone are not evidence: measures of one source share most of
 * their vocabulary.
 */
const semanticEvidence = (source: Column, target: Column): SemanticEvidence[] => {
  const evidence: SemanticEvidence[] = [];
  const quote = source.fact ? { quote: source.fact.text } : {};
  if (normalizedName(source.column) === normalizedName(target.column)) {
    evidence.push({ rule: "same_name", detail: `both columns are named ${target.column}` });
  } else {
    const targetName = terms(target.column);
    const sourceContext = new Set([...terms(source.column), ...terms(source.description)]);
    if (targetName.size > 0 && [...targetName].every((term) => sourceContext.has(term))) {
      evidence.push({
        rule: "target_name_in_source_context",
        detail: `target name terms [${[...targetName].sort().join(", ")}] appear in the source name or description`,
        ...quote
      });
    }
  }
  const namedTableTerms = intersect(
    terms(target.table),
    new Set([...terms(source.column), ...terms(source.description)])
  );
  if (namedTableTerms.length > 0
    && isIdentifierLike(source.column, source.description)
    && isIdentifierLike(target.column, target.description)) {
    evidence.push({
      rule: "identifier_names_target_table",
      detail: `${source.column} is an identifier whose name or description names table term(s) `
        + `[${namedTableTerms.join(", ")}]`,
      ...quote
    });
  }
  return evidence;
};

/**
 * For each pair of identical tables keep one and drop the other. Prefer the table a data
 * dictionary is named after (noaa_wildfires_variabledescrip documents noaa_wildfires, not
 * its copy Fire_Weather_Data_2002_2014_2016), then the one the question points at more,
 * then the first by name.
 */
const duplicateCopies = (
  lake: LakeSemantics,
  columns: Column[],
  relevanceOf: (column: Column) => number
): Set<string> => {
  const dictionaryTerms = new Set(lake.dictionaryTables.flatMap((table) => [...terms(table)]));
  const preference = (table: string): [number, number] => [
    intersect(terms(table), dictionaryTerms).length,
    Math.max(0, ...columns.filter((column) => column.table === table).map(relevanceOf))
  ];
  const copies = new Set<string>();
  for (const [left, right] of lake.duplicateTables) {
    const [leftDictionary, leftRelevance] = preference(left);
    const [rightDictionary, rightRelevance] = preference(right);
    const keepRight = rightDictionary !== leftDictionary
      ? rightDictionary > leftDictionary
      : rightRelevance > leftRelevance;
    copies.add(keepRight ? left : right);
  }
  return copies;
};

const rank = (candidate: GroundingCandidate): number => candidate.relevance + semanticScore(candidate);

const columnKey = (table: string, column: string): string => `${table}\u0000${column}`;

const round = (value: number): number => Math.round(value * 1000) / 1000;
