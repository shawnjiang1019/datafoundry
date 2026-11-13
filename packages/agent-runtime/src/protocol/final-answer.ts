/**
 * The answer on the run's last FINAL_ANSWER line, as written, for every completion check to read the
 * same way. Accepts a full-width colon, and drops markdown emphasis, backticks and one pair of matching
 * quotes around the value ("**0.11**", "`Marine`", "\"Marine\""). Undefined when there is no such line
 * or it is empty.
 */
export const finalAnswerText = (text: string): string | undefined => {
  const line = [...text.matchAll(/FINAL_ANSWER\s*[:：]\s*(.+)/giu)].at(-1)?.[1];
  if (line === undefined) return undefined;
  let value = line.trim().replace(/^\*+|\*+$/gu, "").trim().replace(/^`+|`+$/gu, "").trim();
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === "'" || value[0] === "\"")) {
    value = value.slice(1, -1).trim();
  }
  return value.length > 0 ? value : undefined;
};
