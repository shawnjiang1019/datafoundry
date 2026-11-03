#!/usr/bin/env python
# coding: utf-8
"""Ingestor for NASA/ISTP binary CDF files (.cdf) -> long-format rows / CSV.

Target data: Swarm "ACCACAL" (calibrated along-track acceleration), e.g.
    SW_OPER_ACCACAL_2__20240511T000000_20240511T235959_0304.cdf

Variable-name contract (from the KramaBench hard-8 reference):
    * time   -> CDF time index for each sample  (read via ``varget("time")``)
    * a_cal  -> calibrated acceleration; the reference uses column 0
                (``varget("a_cal")[:, 0]``, along-track acc). Shape is
                (n_samples, n_components); we expand each component into a
                separate ``a_cal_<i>`` column so every row stays scalar and
                long-format-friendly for SQL.

Dependencies
------------
* ``cdflib``  (does the CDF parsing; also pulls in ``numpy``/``pandas``)
* ``numpy``   (array plumbing)

``cdflib`` is imported LAZILY inside ``__load_cdflib()`` so this module still
imports cleanly when cdflib is missing (only the read functions fail).

Time conversion: ``cdflib.cdfepoch.to_datetime`` yields naive UTC datetimes;
we serialise each as an ISO-8601 string ``YYYY-MM-DDTHH:MM:SS.ffffff`` under
the key ``timestamp``.
"""

from __future__ import annotations

import csv

import numpy as np

REQUIRES = {
    "cdflib": ">=0.4.0 (lazy import; read APIs need it)",
    "numpy": ">=1.20",
}

DEFAULT_TIME_VAR = "time"
DEFAULT_VALUE_VARS = ("a_cal",)


def requires() -> list[str]:
    """Human-readable dependency notes, callable without cdflib installed."""
    return [f"{k}{v}" for k, v in REQUIRES.items()]


def _load_cdflib():
    """Lazily import cdflib and fail with a clear message when absent."""
    try:
        import cdflib  # local import: keeps module import clean if missing
    except ImportError as exc:  # pragma: no cover - exercised on CD-less envs
        raise ImportError(
            "cdflib is required to read NASA/ISTP binary CDF files. "
            "Install it with:  pip install cdflib"
        ) from exc
    return cdflib


def _py_scalar(value):
    """Convert a numpy scalar to a plain Python scalar."""
    return value.item() if hasattr(value, "item") else value


def _extract_values(value, name):
    """Turn a variable's row-slice into scalar columns.

    * Scalar value            -> single column ``{name: value}``.
    * 1-D row slice           -> expanded into ``name_0``, ``name_1``, ... so
                                 rows stay scalar/long-format friendly for SQL.
    """
    if getattr(value, "ndim", 1) == 0:
        return {name: _py_scalar(value)}
    flat = np.asarray(value).ravel()
    if flat.size == 1:
        return {name: _py_scalar(flat[0])}
    return {f"{name}_{j}": _py_scalar(comp) for j, comp in enumerate(flat)}


def load(path, time_var=DEFAULT_TIME_VAR, value_vars=DEFAULT_VALUE_VARS):
    """Read a CDF file into long-format rows.

    Returns a list of dicts, one per sample:
        {'timestamp': '<ISO-8601 UTC string>',
         'a_cal_0': <float>, 'a_cal_1': <float>, ...}

    Args:
        path:       The .cdf file to read.
        time_var:   Variable holding the CDF epoch index (default 'time').
        value_vars: Value variables to expand per sample (default ('a_cal',)).

    Raises:
        ImportError: if cdflib is not installed.
        KeyError:    if ``time_var`` or a value variable is absent.
    """
    cdflib = _load_cdflib()
    cdf = cdflib.CDF(path)
    try:
        epoch = np.asarray(cdf.varget(time_var))
        if epoch.ndim > 1:
            epoch = epoch.reshape(-1)  # tolerated (n_samples, 1) style
        times = cdflib.cdfepoch.to_datetime(epoch)

        cache = {}
        for var in value_vars:
            cache[var] = cdf.varget(var)

        rows = []
        for i, ts in enumerate(times):
            row = {"timestamp": ts.isoformat()}
            for var in value_vars:
                value = cache[var][i] if cache[var].ndim > 0 else cache[var]
                row.update(_extract_values(value, var))
            rows.append(row)
        return rows
    finally:
        try:
            cdf.close()
        except Exception:  # pragma: no cover - defensive close
            pass


def to_csv(path, out_csv, **load_kwargs):
    """Read a CDF file and write a CSV for a DuckDB loader.

    Args:
        path:        The .cdf file to read.
        out_csv:     Destination CSV path (written/overwritten).
        load_kwargs: Forwarded to :func:`load` (e.g. time_var/value_vars).
    """
    rows = load(path, **load_kwargs)
    fieldnames = list(rows[0].keys()) if rows else []
    with open(out_csv, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)
