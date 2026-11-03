"""Ingestors for KramaBench file types DuckDB cannot natively load.

Each module exposes ``load(path) -> list[dict]`` returning one row per record,
with semantic, SQL-addressable column names.  The harness's
``build_domain_duckdb`` routes the file extensions below through
:func:`load_by_extension` instead of skipping them:

============================  ===============================================
 extension                     source / tasks
============================  ===============================================
 ``.tle``                      two-line element sets     (astronomy-easy-5, hard-9)
 ``.sp3``                      precise orbit / POD       (astronomy-hard-10, hard-12)
 ``.lst``, ``.dat``            OMNI2 fixed-width text    (astronomy-hard-8, hard-9, hard-11)
 ``.npz``                      numpy geopotential grid   (astronomy-hard-12)
 ``.cdf``                      NASA/ISTP binary CDF      (astronomy-hard-8; needs ``cdflib``)
============================  ===============================================
"""

from __future__ import annotations

import pathlib

from . import cdf, npz, omni, sp3, tle

#: File extensions routed through the ingest package.
SUPPORTED_EXTENSIONS = frozenset({".tle", ".sp3", ".lst", ".dat", ".npz", ".cdf"})

#: Default DuckDB table name per extension (see build_domain_duckdb for the
#: folder-qualified naming used for text families).
DEFAULT_TABLE_NAME = {
    ".tle": "tle",
    ".sp3": "pod_sp3",
    ".lst": "omni_lst",
    # Not "omni2": the astronomy lake's OMNI2/ CSV folder already builds a table named
    # OMNI2, and DuckDB table names are case-insensitive, so the two would collide.
    ".dat": "omni2_low_res",
    ".npz": "mock_tiegcm_grid",
    ".cdf": "swarm_accacal",
}


def load_by_extension(path) -> list[dict]:
    """Parse one file by extension and return its row dicts.

    Raises ValueError for unsupported extensions and propagates parser errors
    (caller decides whether to quarantine or skip the file).
    """
    suffix = pathlib.Path(path).suffix.lower()
    if suffix == ".tle":
        return tle.load(path)
    if suffix == ".sp3":
        return sp3.load(path)
    if suffix in (".lst", ".dat"):
        return omni.load(path)
    if suffix == ".npz":
        return npz.load(path)
    if suffix == ".cdf":
        return cdf.load(path)
    raise ValueError(f"ds_ingest does not handle extension {suffix!r}")
