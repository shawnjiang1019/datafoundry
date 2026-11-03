"""KramaBench ingestors for file types the DuckDB lake loader cannot natively read.

Modules:
    omni   OMNI2 fixed-width text (``.lst`` / ``.dat``) -> named 55-column rows
    tle    two-line element sets (``.tle``)
    sp3    precise orbit files (``.sp3``)
    cdf    NASA/ISTP binary CDF (``.cdf``; requires ``cdflib``)
    npz    numpy geopotential grid (``.npz``)

See ``registry.py`` for the extension -> loader dispatch used by the harness.
"""

from . import cdf, npz, omni, sp3, tle  # noqa: F401
from .registry import SUPPORTED_EXTENSIONS, load_by_extension  # noqa: F401

__all__ = ["cdf", "npz", "omni", "sp3", "tle", "SUPPORTED_EXTENSIONS", "load_by_extension"]
