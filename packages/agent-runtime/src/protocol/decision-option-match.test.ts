import { describe, expect, it } from "vitest";

import { matchOption } from "./analysis-decisions.js";

const options = [
  "Include all rows with serous Histologic_type, regardless of the Case_excluded flag.",
  "Include only rows not flagged as excluded (Case_excluded = 'No'), mirroring the study's analysis population.",
  "Average age per unique patient."
];

describe("decision choices match the option they clearly refer to", () => {
  it("keeps the forms accepted before", () => {
    expect(matchOption("2", options)).toBe(options[1]);
    expect(matchOption("Reading 3", options)).toBe(options[2]);
    expect(matchOption(options[0]!.toUpperCase(), options)).toBe(options[0]);
  });

  it("accepts a number that opens a longer choice", () => {
    expect(matchOption("2. Include only rows not flagged as excluded", options)).toBe(options[1]);
    expect(matchOption("Reading 1: keep every serous row", options)).toBe(options[0]);
    expect(matchOption("Option 3 - per patient", options)).toBe(options[2]);
  });

  it("accepts a choice that starts with an option's full text, ignoring quotes", () => {
    expect(matchOption(`${options[1]} The flag marks cases the study left out.`, options)).toBe(options[1]);
    expect(matchOption("1. 'Include all rows with serous Histologic_type, regardless of the Case_excluded flag.'", options))
      .toBe(options[0]);
  });

  it("accepts a single (reading N) mention", () => {
    expect(matchOption("Use the study population (reading 2): drop excluded cases", options)).toBe(options[1]);
  });

  it("refuses what names none, several, or conflicting options", () => {
    expect(matchOption("probe", options)).toBeUndefined();
    expect(matchOption("7", options)).toBeUndefined();
    expect(matchOption("between reading 1 and reading 2", options)).toBeUndefined();
    expect(matchOption(`1. ${options[1]}`, options)).toBeUndefined();
  });
});
