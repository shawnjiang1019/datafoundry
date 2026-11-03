#!/usr/bin/env python
# coding: utf-8
"""TLE (two-line element set) ingest for the KramaBench -> DuckDB harness.

Design notes
------------
* Parsing is decoupled from IO: the pure parser is ``parse(text, source_file)``;
  ``load(path)`` only reads the file and delegates.
* Stdlib only (datetime, re). numpy / skyfield are NOT required and not used.
* Two severity levels are recognised on purpose (see README.md):
    - ``load()`` / ``parse()`` treat structurally malformed files (a line-1 with
      no following line-2) as *hard* errors and raise ``ValueError`` so an
      ingest harness can quarantine the file.
    - Field-level problems (blank/invalid numeric field) produce ``None`` in the
      affected column and never abort the whole file, so a single bad TLE does
      not tank an entire batch.
"""
from __future__ import annotations

import datetime as _dt
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# Fixed-format TLE field slicing (1-based column numbers follow celestrak.com/
# NORAD/documentation/tle-fmt.php).  Only the fields the ingest task needs are
# translated here; both lines are always 69 characters.
# ---------------------------------------------------------------------------

# Line 1 (69 chars), 0-based [start:end) slices.
_L1_NORAD = slice(2, 7)        # cols  3- 7  satellite catalog number
_L1_CLASS = slice(7, 8)        # col   8     classification (U/C/S)
_L1_EPOCH_YY = slice(18, 20)   # cols 19-20  epoch year (2 digits)
_L1_EPOCH_DD = slice(20, 32)   # cols 21-32  epoch day-of-year + day fraction
_L1_NDOT = slice(33, 43)       # cols 34-43  1st derivative of mean motion (plain float)
_L1_NDDOT = slice(44, 52)      # cols 45-52  2nd derivative (implied-decimal exponent field)
_L1_BSTAR = slice(53, 61)      # cols 54-61  BSTAR drag (implied-decimal exponent field)
_L1_EPHTYPE = slice(62, 63)    # col   63    ephemeris type
_L1_ELEMSET = slice(64, 68)    # cols 65-68  element set number
_L1_CHECKSUM = slice(68, 69)   # col   69    checksum

# Line 2 (69 chars), 0-based [start:end) slices.
_L2_NORAD = slice(2, 7)        # cols  3- 7  satellite catalog number
_L2_INCL = slice(8, 16)        # cols  9-16  inclination (deg)
_L2_RAAN = slice(17, 25)       # cols 18-25  RAAN (deg)
_L2_ECC = slice(26, 33)        # cols 27-33  eccentricity (7 digits, implied decimal)
_L2_ARGPER = slice(34, 42)     # cols 35-42  argument of perigee (deg)
_L2_MEANAN = slice(43, 51)     # cols 44-51  mean anomaly (deg)
_L2_MMOTION = slice(52, 63)    # cols 53-63  mean motion (rev/day)
_L2_REVNO = slice(63, 68)      # cols 64-68  revolution number at epoch
_L2_CHECKSUM = slice(68, 69)   # col   69    checksum

_RE_EXP_FIELD = re.compile(r"^\s*([-+])?\s*(\d{1,6})\s*([-+])(\d{1,2})\s*$")


def _slice_field(line, colslice):
    """Return the stripped slice of ``line`` or None if out of range/blank."""
    if line is None:
        return None
    if abs(colslice.start) >= len(line) or colslice.stop > len(line):
        return None
    txt = line[colslice].strip()
    return txt if txt else None


def _parse_float(value, default=None):
    if value is None:
        return default
    value = value.strip()
    if not value:
        return default
    try:
        f = float(value)
    except ValueError:
        return default
    if f != f or f in (float("inf"), float("-inf")):  # NaN / inf guard
        return default
    return f


def _parse_int(value, default=None):
    if value is None:
        return default
    value = value.strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _parse_exponential_field(value, default=None):
    """Parse a TLE implied-decimal exponent field.

    e.g. ``20621-3`` -> 0.20621e-3, ``-27142-4`` -> -0.27142e-4, ``00000-0`` -> 0.0.

    The 8-char field is  [sign] ddddd [sign] dd  where the 5-digit mantissa has
    an *implied decimal before its first digit* and the final two digits with a
    sign are a power-of-ten exponent.  We compute mantissa * 10**(exp - n_digits),
    algebraically identical to the implied-decimal reading.
    """
    if value is None:
        return default
    value = value.strip()
    if not value:
        return default
    m = _RE_EXP_FIELD.match(value)
    if not m:
        return default
    mantissa_sign, digits, exp_sign, exp = m.groups()
    mantissa = int(digits) * (-1 if mantissa_sign == "-" else 1)
    return float(mantissa) * 10.0 ** (int(exp) * (-1 if exp_sign == "-" else 1) - len(digits))


def _tle_year_to_four(year2):
    """Apply the standard 1957-rule for 2-digit TLE years.

    yy >= 57 -> 19xx (Sputnik launched 1957; nothing in orbit predates it),
    yy <= 56 -> 20xx.  (celestrak.com/NORAD/documentation/tle-fmt.php)
    """
    if isinstance(year2, str):
        year2 = int(year2)
    return 1900 + year2 if year2 >= 57 else 2000 + year2


def epoch_from_tle(year2, day_fraction):
    """Return a naive-UTC ``datetime`` for a TLE epoch ``yy ddd.ddddd``.

    ``day_fraction`` is the day-of-year (e.g. 122.17811289). Raises ValueError
    on nonsensical input.  Naive UTC is deliberate (matches skyfield's
    ``satellite.epoch.utc_datetime()`` used by the reference solutions).
    """
    year = _tle_year_to_four(year2)
    doy_int = int(day_fraction)
    frac = day_fraction - doy_int
    base = _dt.datetime(year, 1, 1) + _dt.timedelta(days=doy_int - 1)
    micros = int(round(frac * 86400.0 * 1e6))
    if micros >= 86400 * 1_000_000:  # rounding spill into the next day
        base += _dt.timedelta(days=1)
        micros -= 86400 * 1_000_000
    return base + _dt.timedelta(microseconds=micros)


def extract_norad(line2):
    """Parse the NORAD catalog id out of a TLE line-2 (columns 3-7).

    Returns int, or None when the line is missing/short/non-numeric.
    """
    if not line2 or len(line2) < 7:
        return None
    return _parse_int(line2[_L2_NORAD])


def parse_group(name, line1, line2, source_file=None):
    """Parse one 3-line (name + line1 + line2) or 2-line TLE group into a row dict.

    Returns a dict with the ingest schema; never raises for field-level noise.
    ``name`` may be None (2-line-pair files such as the KramaBench inputs).
    """
    norad_l1 = _parse_int(_slice_field(line1, _L1_NORAD))
    norad = _parse_int(_slice_field(line2, _L2_NORAD)) or norad_l1

    yy = _parse_int(_slice_field(line1, _L1_EPOCH_YY))
    dd = _parse_float(_slice_field(line1, _L1_EPOCH_DD))
    if yy is not None and dd is not None:
        try:
            epoch = epoch_from_tle(yy, dd)
        except (ValueError, OverflowError):
            epoch = None
    else:
        epoch = None

    name = name.strip() if isinstance(name, str) and name.strip() else None

    incl = _parse_float(_slice_field(line2, _L2_INCL))
    raan = _parse_float(_slice_field(line2, _L2_RAAN))
    ecc_raw = _slice_field(line2, _L2_ECC)
    if ecc_raw is None:
        eccentricity = None
    elif "." not in ecc_raw and ecc_raw.isdigit():
        eccentricity = float("0." + ecc_raw)   # 7-digit implied decimal
    else:
        eccentricity = _parse_float(ecc_raw)   # tolerant of explicit decimals
    argper = _parse_float(_slice_field(line2, _L2_ARGPER))
    meanan = _parse_float(_slice_field(line2, _L2_MEANAN))
    mmotion = _parse_float(_slice_field(line2, _L2_MMOTION))

    ndot = _parse_float(_slice_field(line1, _L1_NDOT), default=None)
    nddot = _parse_exponential_field(_slice_field(line1, _L1_NDDOT), default=None)
    bstar = _parse_exponential_field(_slice_field(line1, _L1_BSTAR), default=None)

    elemset = _parse_int(_slice_field(line1, _L1_ELEMSET))
    revno = _parse_int(_slice_field(line2, _L2_REVNO))

    return {
        "source_file": source_file,
        "name": name,
        "satname": name,
        "norad_cat_id": norad,
        "epoch": epoch,
        "inclination_deg": incl,
        "raan_deg": raan,
        "eccentricity": eccentricity,
        "arg_perigee_deg": argper,
        "mean_anomaly_deg": meanan,
        "mean_motion_rev_per_day": mmotion,
        "ndot": ndot,
        "first_derivative": ndot,
        "nddot": nddot,
        "second_derivative": nddot,
        "bstar": bstar,
        "element_set_number": elemset,
        "revolution_number": revno,
        "classification": _slice_field(line1, _L1_CLASS),
    }


def parse(text, source_file=None):
    """Parse the contents of a TLE file (text) into a list of row dicts.

    Groups are formed as an optional name line followed by a ``1 ...`` line then
    a ``2 ...`` line.  Files containing plain line-1/line-2 pairs with no name
    line (the case for KramaBench's TLE/48445.tle and TLE/43180.tle inputs)
    parse identically with ``name`` = None.

    Raises ValueError when a line-1 is found without a following line-2 (hard
    structural error, so a harness can quarantine the file).
    """
    lines = [ln.rstrip("\r\n") for ln in text.splitlines()]
    non_empty = [ln for ln in lines if ln.strip()]

    groups = []
    i = 0
    n = len(non_empty)
    while i < n:
        name = None
        first = non_empty[i]
        if not first.startswith("1") and not first.startswith("2"):
            # candidate name line (any non-empty line that is not a TLE line)
            name = first.strip()
            i += 1
            if i >= n:
                break
            first = non_empty[i]
        if not first.startswith("1"):
            # orphan / junk line that is not shape '1 ...': skip (tolerated)
            i += 1
            continue
        if i + 1 >= n or not non_empty[i + 1].startswith("2"):
            raise ValueError(
                "TLE line '1' encountered without a following '2' line "
                "(input = %r)." % (source_file,)
            )
        groups.append(parse_group(name, non_empty[i], non_empty[i + 1], source_file))
        i += 2

    return groups


def load(path):
    """Read a TLE file from ``path`` and return a list of per-group row dicts.

    Thin IO wrapper; all parsing semantics live in ``parse``.
    """
    path = Path(path)
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    return parse(text, source_file=str(path))


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("usage: tle.py <file.tle>", file=sys.stderr)
        raise SystemExit(2)
    for row in load(sys.argv[1]):
        print(row)
