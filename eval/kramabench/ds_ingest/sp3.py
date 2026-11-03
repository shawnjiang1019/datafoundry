#!/usr/bin/env python
# coding: utf-8
"""SP3 (precise orbit / POD) ingest for the KramaBench -> DuckDB harness.

Design notes
------------
* Pure parsing is decoupled from IO: ``parse(text, source_file)`` is the parser,
  ``load(path)`` just reads the file.  ``parse_header`` reads only the head of a
  file (first ~40 lines) for the start epoch / counts / interval.
* Stdlib only. numpy / skyfield NOT required.
* One output row per ``P<sat>`` record. ``V<sat>``, ``EP``/``EN``-style records,
  ``+``/``++`` continuation, ``%``-lines, ``/*`` comments and any other non-P
  lines are skipped (see README.md, "skip rules").
* Header first line is matched leniently: Swarm files begin ``#dV``; IGS files
  commonly begin ``#cP`` / ``#aP``.  Any ``#<ver>[<P|V>] YYYY ...`` line works.
"""
from __future__ import annotations

import datetime as _dt
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# SP3 fixed-format header columns (1-based, per SP3-c/d spec; see README.md for
# the byte map and the byte-level ambiguity note).  These are used as the
# primary reading of the first line; we fall back to whitespace tokenization
# when a file that is almost-but-not-quite fixed-column is encountered.
# ---------------------------------------------------------------------------
_HDR_YEAR = slice(3, 7)        # cols  4- 7  year (4 digits)
_HDR_MONTH = slice(8, 10)      # cols  9-10  month
_HDR_DAY = slice(11, 13)       # cols 12-13  day
_HDR_HOUR = slice(14, 16)      # cols 15-16  hour
_HDR_MIN = slice(17, 19)       # cols 18-19  minute
_HDR_SEC = slice(20, 31)       # cols 21-31  second (F11.8)
_HDR_EPOCHS = slice(32, 38)    # cols 33-38  number of epochs

# Regex for the first header line.  Covers both
#   #cP2019  8 31  0  0  0.00000000      288 ...
#   #dV2019  9 29  0  0  0.00000000    8640 ...
# (i.e. version marker may or may not be followed by a P/V type char and there
# may or may not be whitespace before the year).
_RE_HDR = re.compile(r"^#\w+\s*(\d{4})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\b")
_RE_TIME_EPOCH = re.compile(r"^\*\s*(\d{4})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)")

# Clock sentinel: SP3 position lines carry clock in microseconds; the value
# 999999.999999 (or 999999.000000) means "no clock data" per the spec.
CLOCK_SENTINEL = 999999.999999


class Sp3Error(ValueError):
    """Raised for structurally invalid SP3 input (e.g. no header / bad epoch)."""


def _read_lines(text):
    return text.splitlines()


def _parse_datetime(parts):
    """Build a naive-UTC datetime from 6 token parts (y mo d h mi s[.frac]).

    The 8-digit fractional-seconds field (F11.8 / F10.8) is truncated to
    microsecond resolution, matching pandas ``%Y %m %d %H %M %S.%f`` as used by
    the reference solutions (they read six fraction digits; trailing digits are
    discarded, not rounded).
    """
    year, month, day, hour, minute = (int(parts[i]) for i in range(5))
    sec_str = parts[5]
    if "." in sec_str:
        whole, _, frac = sec_str.partition(".")
        second = int(whole)
        micro = int((frac + "000000")[:6])
    else:
        second = int(sec_str)
        micro = 0
    return _dt.datetime(year, month, day, hour, minute, second, micro)


def _token_style_epoch(line):
    m = _RE_TIME_EPOCH.match(line)
    if not m:
        return None
    return _parse_datetime(m.groups())


def _token_style_header_dt(line):
    m = _RE_HDR.match(line)
    if not m:
        return None
    return _parse_datetime(m.groups())


def parse_shape(line):
    """Classify one SP3 record line.

    Returns
        ('P', sat, raw_tokens)           for a P-position line
        ('epoch', epoch_datetime)        for a ``*`` time line
        ('other', None)                  anything else (V/EP/EN//+//%/comment/EOF)
    Sat is the 3-char satellite identifier after 'P', e.g. 'L47' for 'PL47'.
    """
    if not line:
        return "other", None
    if line[0] == "*":
        ts = _token_style_epoch(line)
        return ("epoch", ts) if ts is not None else ("other", None)
    if line[0] == "P" and len(line) > 1 and line[1] != " ":
        parts = line.split()
        if len(parts) >= 5:  # P<sat> x y z clock  (+ optional signal: 5th..)
            return "P", (parts[0][1:], float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4]))
    return "other", None


def parse(text, source_file=None):
    """Parse SP3 file contents into a list of row dicts, one per P-position line.

    Rows: dict(source_file, sat, epoch, x_km, y_km, z_km, clock_usec).

    ``epoch`` is naive UTC. ``clock_usec`` is the raw float (the spec sentinel
    999999.999999 meaning 'no clock' is preserved so filtering stays explicit;
    sees also README.md assumptions).

    Raises Sp3Error if a ``P`` data line arrives before any ``*`` epoch line, or
    if the file has no recognizable header.
    """
    lines = _read_lines(text)

    # header start epoch, for validation only
    hdr_dt = None
    hdr_count = None
    for ln in lines:
        if ln.startswith("#") and not ln.startswith("##"):
            hdr_dt = _token_style_header_dt(ln)
            parts = ln.split()
            if len(parts) > 6 and parts[6].isdigit():
                hdr_count = int(parts[6])
            break
    if hdr_dt is None:
        raise Sp3Error("No SP3 header line (#...) found; not an SP3 file.")

    rows = []
    current_epoch = None
    for ln in lines:
        kind, payload = parse_shape(ln)
        if kind == "P":
            if current_epoch is None:
                raise Sp3Error(
                    "SP3 P-record before any epoch ('*') line in %r." % (source_file,)
                )
            sat, x, y, z, clock = payload
            rows.append(
                {
                    "source_file": source_file,
                    "sat": sat,
                    "epoch": current_epoch,
                    "x_km": x,
                    "y_km": y,
                    "z_km": z,
                    "clock_usec": clock,
                }
            )
        elif kind == "epoch":
            current_epoch = payload

    return rows


def load(path):
    """Read an .sp3 file from ``path`` and return a list of P-record row dicts."""
    path = Path(path)
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    return parse(text, source_file=str(path))


def parse_header(path, max_head_lines=40):
    """Return header metadata for a .sp3 file:
        dict(start_epoch, epoch_count, interval_seconds, version, data_used,
             coord_system, orbit_type, agency, count_from_double_hash,
             count_doublehash_ambiguous, mjd_doublehash, epoch_count_actual)

    ``epoch_count``     -> number of epochs declared on the ``#...`` line
    ``interval_seconds``-> epoch interval in seconds (from the ``##`` line, or
                           None when the ``##`` line is absent)
    ``count_from_double_hash`` -> integers found on the ``##`` line
    ``mjd_doublehash``  -> integer token found on the ``##`` line (MJD of epoch)
    ``epoch_count_actual`` -> number of distinct ``*`` epoch lines seen in the
                              *head* of the file (sampled, not the full file).

    NOTE (Swarm quirk, see README.md): for the KramaBench Swarm files the ``#``
    line says 8640 epochs but the ``##`` line says 2073.  Both are surfaced here
    and neither is trusted for cardinality; the caller should count actual
    ``*`` lines (or P rows) in ``parse()`` output.
    """
    path = Path(path)
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        head = [fh.readline() for _ in range(max_head_lines)]

    info = {
        "version": None,
        "start_epoch": None,
        "epoch_count": None,
        "data_used": None,
        "coord_system": None,
        "orbit_type": None,
        "agency": None,
        "interval_seconds": None,
        "count_from_double_hash": None,
        "mjd_doublehash": None,
        "epoch_count_actual": None,
    }

    for ln in head:
        ln = ln.rstrip("\r\n")
        if not ln:
            continue
        if ln.startswith("#") and not ln.startswith("##"):
            info["start_epoch"] = _token_style_header_dt(ln)
            parts = ln.split()
            marker = parts[0]
            if len(marker) >= 2:
                info["version"] = marker[1]
            if len(marker) >= 3:
                info["data_used"] = marker[2]  # 'P' or 'V' position/velocity flag
            if len(parts) > 6 and parts[6].isdigit():
                info["epoch_count"] = int(parts[6])
            # trailing free-form tokens: coord system / orbit type / agency
            if len(parts) > 7:
                info["coord_system"] = parts[7]
            if len(parts) > 8:
                info["orbit_type"] = parts[8]
            if len(parts) > 9:
                info["agency"] = " ".join(parts[9:])
        elif ln.startswith("##"):
            parts = ln.split()
            if len(parts) > 1 and parts[1].isdigit():
                info["count_from_double_hash"] = int(parts[1])
            # remaining numeric tokens: [start_time_f] interval_f [mjd] [extra]
            num_tokens = [_cast_num(t) for t in parts[2:] if _cast_num(t) is not None]
            if len(num_tokens) >= 2 and isinstance(num_tokens[1], float):
                info["interval_seconds"] = num_tokens[1]
            for t in num_tokens:
                if isinstance(t, int) and t > 40000:  # MJDs are large 5-digit ints
                    info["mjd_doublehash"] = t
                    break
        elif ln.startswith("*"):
            if info["epoch_count_actual"] is None:
                info["epoch_count_actual"] = 0
            info["epoch_count_actual"] += 1
    return info


def _cast_num(tok):
    try:
        f = float(tok)
    except ValueError:
        return None
    if "." in tok:
        return f
    return int(f)


_SAT_FROM_FILENAME = re.compile(r"SP3([A-Za-z0-9])")


def satellite_from_filename(path):
    """Best-effort extraction of the satellite designator from a filename.

    KramaBench Swarm filenames look like ``SW_OPER_SP3ACOM_2__20190928...`` ->
    returns ``"A"``.  Files with a ``SP3<X>`` token return that letter/digit;
    otherwise None (caller falls back to the ``sat`` column on the rows, which
    for Swarm are PRN-style ids such as ``L47``).
    """
    m = _SAT_FROM_FILENAME.search(str(path))
    return m.group(1).upper() if m else None


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("usage: sp3.py <file.sp3>", file=sys.stderr)
        raise SystemExit(2)
    for row in load(sys.argv[1])[:20]:
        print(row)
