"""Gold-binding oracle lakes for KramaBench reruns.

An *oracle* here means: force the agent's binding decisions by construction. The
agent's resolver (semantic.context.resolve / inspect_schema / SQL) can only name
tables and columns that exist in the registered DuckDB. So a lake that contains
exactly the gold table/column mappings — and nothing else — makes wrong bindings
impossible: queries against the wrong table/column fail, and the schema the agent
inspects only offers gold candidates.

This module:

* loads a per-task mapping file (`oracle_mappings.json`),
* projects a full domain DuckDB into a per-task gold lake containing only the
  mapped tables (and only the mapped columns, when columns are listed),
* writer helper the SUT uses in ``serve_query`` to cache and register those lakes,
  falling back to the full lake for unmapped tasks.

Mapping file shape (one entry per key — either a KramaBench task id such as
``biomedical-hard-5`` or a fallback key such as ``biomedical``):

    {
      "biomedical-hard-5": {
        "table": {
          "1_s2_0_S0092867420301070_mmc7": [
            "Log2_variant_per_Mbp", "Histologic_type", "Case_excluded"
          ]
        },
        "source_only": false
      },
      "wildfire": {
        "tables": ["some_shared_table"],
        "columns": ["A", "B"],
        "source_only": true
      }
    }

Two granularities are supported so the rerun can measure two ceilings:

* **table-level oracle** — the entry lists *tables* only (or uses columns `"*"`):
  the whole table is kept. The agent still has to pick the column, so this
  measures "how much does correct *table* selection alone help?".
* **column-level oracle** — the entry lists columns per table (the reference's
  full usage: selects, filters, joins, grouping — NOT just the answer column):
  a stricter upper bound, "how much does exact *field* resolution help?".

Use column-level mappings only when they reproduce the reference's *complete*
column usage. Dropping a filter/join/grain column the reference applied
(``Case_excluded``, a join key) cripples valid analysis and the rerun then
under-measures — the golden rule is: the oracle removes candidates, never
columns the reference itself uses.
"""

from __future__ import annotations

import json
import os
from typing import Any

try:
    import duckdb
except ImportError:  # pragma: no cover - same guard as the SUT
    duckdb = None

_FULL_TABLE = "*"


class OracleError(RuntimeError):
    """Raised when an oracle mapping or gold lake cannot be used."""


def load_mappings(path: str) -> dict[str, Any]:
    """Load and lightly validate the oracle mapping file."""
    if not os.path.isfile(path):
        raise OracleError(f"oracle mapping file not found: {path}")
    raw = json.load(open(path, encoding="utf-8"))
    if not isinstance(raw, dict):
        raise OracleError(f"oracle mappings must be a JSON object: {path}")
    return raw


def _entry_tables(entry: Any, key: str) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise OracleError(f"oracle entry for {key!r} must be an object")
    if "table" in entry:
        if "tables" in entry or "columns" in entry:
            raise OracleError(f"oracle {key!r}: use 'table' XOR 'tables'/'columns', not both")
        table = entry["table"]
        if not isinstance(table, dict) or not all(
            isinstance(name, str)
            and (columns in (_FULL_TABLE,) or isinstance(columns, list) and columns
                 and all(isinstance(c, str) for c in columns))
            for name, columns in table.items()
        ):
            raise OracleError(f"oracle {key!r} 'table' must be {{name: [columns]|'*'}}")
        return dict(table)
    tables = entry.get("tables")
    if not isinstance(tables, list) or not all(isinstance(name, str) for name in tables):
        raise OracleError(f"oracle {key!r} needs 'table' or 'tables'")
    columns = entry.get("columns", _FULL_TABLE)
    if columns not in (_FULL_TABLE,):
        if not isinstance(columns, list) or not columns or not all(isinstance(c, str) for c in columns):
            raise OracleError(f"oracle {key!r} 'columns' must be '*' or a non-empty list of names")
    return {name: (list(columns) if columns != _FULL_TABLE else _FULL_TABLE) for name in tables}


def _escape_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def project_gold_lake(src_path: str, out_path: str, entry: Any, key: str) -> int:
    """Project ``src_path`` into ``out_path`` keeping only the gold tables/columns.

    Returns the number of tables written. The source is attached read-only and
    never modified. Existing ``out_path`` is replaced atomically via a temp file.
    """
    if duckdb is None:
        raise OracleError("duckdb is required to build oracle lakes")
    tables = _entry_tables(entry, key)
    tmp = out_path + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = duckdb.connect(tmp)
    try:
        con.execute(f"ATTACH '{src_path.replace(chr(39), chr(39) + chr(39))}' AS src (READ_ONLY)")
        for name, columns in tables.items():
            ident = _escape_ident(name)
            if columns == _FULL_TABLE:
                con.execute(f'CREATE TABLE {ident} AS SELECT * FROM src.{ident}')
            else:
                kept = ", ".join(_escape_ident(col) for col in columns)
                con.execute(f'CREATE TABLE {ident} AS SELECT {kept} FROM src.{ident}')
            count = con.execute(f"SELECT COUNT(*) FROM {ident}").fetchone()[0]
            print(f"[oracle] {key}: kept table {name} ({len(columns) if columns != _FULL_TABLE else 'all'} cols, {count} rows)")
    finally:
        try:
            con.execute("DETACH src")
        except Exception:
            pass
        con.close()
    os.replace(tmp, out_path)
    return len(tables)


def lookup(entry_key: str, domain: str, mappings: dict[str, Any]) -> Any | None:
    """Return the oracle entry for a task, without falling across domains.

    Match order: exact key first (e.g. ``biomedical-hard-5``), then the domain
    (e.g. ``biomedical``) so a shared mapping can cover a whole domain. A
    ``source_only`` marker means the entry is a template, not a confirmed gold
    binding.
    """
    if entry_key in mappings:
        return mappings[entry_key]
    if domain in mappings:
        return mappings[domain]
    return None


def projections_cache_dir(out_root: str) -> str:
    return os.path.join(out_root, "oracle_lakes")


def gold_lake_path(out_root: str, entry_key: str, domain: str) -> str:
    return os.path.join(projections_cache_dir(out_root), f"{domain}__{entry_key}.duckdb")
