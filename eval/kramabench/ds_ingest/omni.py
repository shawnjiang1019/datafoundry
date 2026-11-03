"""OMNI (OMNI2) solar-wind text-file ingestor for a KramaBench -> DuckDB harness.

Two input flavours are supported, dispatched by file extension:

* ``.dat`` / ``.txt``: the classic OMNI2 55-column fixed-width hourly layout
  (e.g. ``omni2_2024.dat``, ``omni2_2023.dat``, ``omni2.txt``).  Each data line
  is exactly 327 characters wide (55 Fortran fields).  Column offsets follow
  the reference spec in ``astronomy-hard-9.py`` / ``astronomy-hard-11.py``.
* ``.lst``: a whitespace-separated time series in the form
  ``year day-of-year hour value`` (e.g. ``omni2_Kp_Index.lst``,
  ``omni2_Flow_Pressure.lst``).  Each line carries one measurement for one
  parameter series.

Parsed rows are returned as plain dicts.  Values are kept "loosely typed":
empty fields become ``None``, integral strings become ``int``, other numeric
strings become ``float``, and everything else stays a ``str``.  Missing-value
sentinels (9999, 999.9, 99.99, 99999.99, 999999.99) are NOT converted to
``None``; they are preserved as parsed so a downstream query can filter them.
Only ``stdlib`` is required.
"""

import datetime as _dt
import re as _re
from pathlib import Path

COLUMNS = [
    "year", "doy", "hour", "brn", "imf_id", "sw_id", "n_imf", "n_sw",
    "B_mag_avg", "B_vec_mag", "B_lat", "B_long",
    "Bx_GSE", "By_GSE", "Bz_GSE", "By_GSM", "Bz_GSM",
    "sigma_B_mag", "sigma_B_vec", "sigma_Bx", "sigma_By", "sigma_Bz",
    "proton_temp", "proton_density", "flow_speed", "flow_long", "flow_lat",
    "Na_Np", "flow_pressure",
    "sigma_T", "sigma_N", "sigma_V", "sigma_phi_V", "sigma_theta_V",
    "sigma_Na_Np",
    "electric_field", "plasma_beta", "alfven_mach",
    "Kp", "sunspot", "Dst", "AE",
    "pf_1MeV", "pf_2MeV", "pf_4MeV", "pf_10MeV", "pf_30MeV", "pf_60MeV",
    "flag", "ap", "f10.7", "PC_N", "AL", "AU", "mach_number",
]

WIDTHS = (
    4, 4, 3, 5, 3, 3, 4, 4,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 9, 6, 6, 6, 6, 6, 6, 9,
    6, 6, 6, 6, 6, 7, 7, 6, 3, 4, 6, 5,
    10, 9, 9, 9, 9, 9, 3, 4, 6, 6, 6, 6, 5,
)

if len(COLUMNS) != len(WIDTHS):
    raise AssertionError("COLUMNS/WIDTHS length mismatch")
if sum(WIDTHS) != 327:
    raise AssertionError("WIDTHS must sum to 327 per the OMNI2 55-column spec")

_LST_HEADER = _re.compile(r"^(?:omni2)[_\-\s]*", _re.IGNORECASE)


def _coerce(token: str):
    s = token.strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        return s


def _is_intlike(token: str) -> bool:
    s = token.strip()
    if not s:
        return False
    try:
        int(s)
        return True
    except ValueError:
        return False


def _split_fwf(line: str):
    fields = []
    offset = 0
    for width in WIDTHS:
        fields.append(line[offset:offset + width])
        offset += width
    return fields


def ydh_to_utc(year, doy, hour):
    """Build a timezone-aware UTC datetime from year, day-of-year and hour."""
    try:
        base = _dt.datetime(int(year), 1, 1, tzinfo=_dt.timezone.utc)
        return base + _dt.timedelta(days=int(doy) - 1, hours=int(hour))
    except (TypeError, ValueError, OverflowError):
        return None


def load_dat(path, with_datetime: bool = False):
    """Parse the classic OMNI2 55-column fixed-width hourly layout.

    Each emitted dict has exactly :data:`COLUMNS` keys when
    ``with_datetime=False`` (the default); with ``with_datetime=True`` an
    extra ``datetime_utc`` ISO-8601 string key is appended.
    Blank lines, ``#``-comment lines and descriptive non-data lines (whose
    first three fixed-width fields are not integers ``year doy hour``) are
    skipped.
    """
    rows = []
    base_keys = list(COLUMNS)
    with Path(path).open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\r\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = _split_fwf(line)
            if len(parts) < len(COLUMNS):
                continue
            if not (_is_intlike(parts[0]) and _is_intlike(parts[1])
                    and _is_intlike(parts[2])):
                continue
            row = dict(zip(base_keys, (_coerce(p) for p in parts)))
            if with_datetime:
                stamp = ydh_to_utc(row["year"], row["doy"], row["hour"])
                row["datetime_utc"] = _iso_utc(stamp)
            rows.append(row)
    return rows


def load_lst(path, parameter=None):
    """Parse a whitespace-separated ``year doy hour value`` time-series file.

    The parameter series name is derived from the file name (e.g. file
    ``omni2_Kp_Index.lst`` -> parameter ``Kp_Index``), or can be given
    explicitly via ``parameter``.  Every data line yields one (epoch, value)
    row: ``{parameter, year, doy, hour, value, datetime_utc}``.
    """
    if parameter is None:
        parameter = _lst_parameter(path)
    rows = []
    with Path(path).open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\r\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            tokens = line.split()
            if len(tokens) < 4:
                continue
            year_token, doy_token, hour_token, value_token = tokens[:4]
            if not (_is_intlike(year_token) and _is_intlike(doy_token)
                    and _is_intlike(hour_token)):
                continue
            year, doy, hour = int(year_token), int(doy_token), int(hour_token)
            stamp = ydh_to_utc(year, doy, hour)
            rows.append({
                "parameter": parameter,
                "year": year,
                "doy": doy,
                "hour": hour,
                "value": _coerce(value_token),
                "datetime_utc": _iso_utc(stamp),
            })
    return rows


def _lst_parameter(path) -> str:
    stem = Path(path).stem
    name = _LST_HEADER.sub("", stem)
    name = name.strip(" _-")
    return name or stem


def _iso_utc(stamp):
    if stamp is None:
        return None
    return stamp.isoformat().replace("+00:00", "Z")


def load(path):
    """Dispatch on file extension: ``.lst`` -> :func:`load_lst`,
    ``.dat``/``.txt`` -> :func:`load_dat`.  Anything else raises ValueError."""
    suffix = Path(path).suffix.lower()
    if suffix == ".lst":
        return load_lst(path)
    if suffix in (".dat", ".txt"):
        return load_dat(path)
    raise ValueError(f"unsupported OMNI file extension: {suffix!r}")
