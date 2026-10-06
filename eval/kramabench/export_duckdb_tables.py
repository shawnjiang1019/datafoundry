#!/usr/bin/env python
"""Export every table of each KramaBench domain DuckDB to Parquet or CSV files.

    python eval/kramabench/export_duckdb_tables.py                       # Parquet, all domains (DataLink)
    python eval/kramabench/export_duckdb_tables.py --format csv          # CSV, all domains (d-trail)
    python eval/kramabench/export_duckdb_tables.py --format csv biomedical archeology

Neither DataLink nor d-trail can read the DuckDB files the agent queries, and the raw
lake is partly Excel/HDF/scientific formats they cannot read either. Exporting the
DuckDB tables gives them the same cleaned tables, under the same names, that the agent
sees through kb-<domain>: workbook sheets split into one table each, header rows found,
file families merged, ds_ingest formats decoded.

* parquet -> <out>/<domain>/<table>.parquet, for DataLink's file connector (keeps types;
  `datalink add-table --source <out>/<domain>`). Default out: system_scratch/datalink_sources.
* csv     -> <out>/<domain>/<table>.csv, UTF-8 with a header row, for d-trail's CSV
  connector (`{"kind": "csv", "path": ...}` sources). Default out: system_scratch/dtrail_sources.
  Tables over d-trail's default Budget (100,000 rows or 50 MB per source) are listed;
  pass a larger `budget` in the run request to use them.

Each domain folder gets a manifest.json (table, rows, columns, bytes, source mtime) so a
stale export is easy to spot after a domain DuckDB is rebuilt.

The DataFoundry API keeps each DuckDB file open while it runs, and Windows then refuses
even read-only access: stop DataFoundry before exporting.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import sys

try:
    import duckdb
except ImportError:  # pragma: no cover
    raise SystemExit("pip install duckdb")

KB_ROOT = pathlib.Path(os.environ.get("KB_ROOT", pathlib.Path.home() / "KramaBench"))
DUCKDB_DIR = KB_ROOT / "system_scratch" / "DataFoundrySUT"
DEFAULT_OUT = {
    "parquet": KB_ROOT / "system_scratch" / "datalink_sources",
    "csv": KB_ROOT / "system_scratch" / "dtrail_sources",
}
# Explicit list: the scratch folder can hold other DuckDB files (e.g. a stale input.duckdb
# from before domain-named builds) that are not benchmark domains.
DOMAINS = ["archeology", "astronomy", "biomedical", "environment", "legal", "wildfire"]
# d-trail's Budget defaults (dtrail/contracts.py) applied per source.
DTRAIL_MAX_ROWS = 100_000
DTRAIL_MAX_BYTES = 50_000_000


def export_domain(db_path: pathlib.Path, out_dir: pathlib.Path, fmt: str) -> list[dict]:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        tables = [r[0] for r in con.execute(
            "select table_name from information_schema.tables "
            "where table_schema = 'main' order by table_name").fetchall()]
        out_dir.mkdir(parents=True, exist_ok=True)
        for stale in out_dir.glob(f"*.{fmt}"):
            stale.unlink()  # a table dropped by a rebuild must not linger
        options = "FORMAT parquet" if fmt == "parquet" else "FORMAT csv, HEADER true, DELIMITER ','"
        manifest = []
        for table in tables:
            target = out_dir / f"{table}.{fmt}"
            quoted = '"' + table.replace('"', '""') + '"'
            con.execute(f"COPY (SELECT * FROM {quoted}) TO ? ({options})", [str(target)])
            rows = con.execute(f"SELECT count(*) FROM {quoted}").fetchone()[0]
            cols = con.execute(
                "select count(*) from information_schema.columns where table_name = ?", [table]).fetchone()[0]
            manifest.append({"table": table, "rows": rows, "columns": cols,
                             "bytes": target.stat().st_size, "file": target.name})
    finally:
        con.close()
    (out_dir / "manifest.json").write_text(json.dumps({
        "source": str(db_path),
        "source_modified": dt.datetime.fromtimestamp(db_path.stat().st_mtime).isoformat(timespec="seconds"),
        "exported": dt.datetime.now().isoformat(timespec="seconds"),
        "format": fmt,
        "tables": manifest,
    }, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("domains", nargs="*", help=f"domain names (default: {' '.join(DOMAINS)})")
    parser.add_argument("--format", choices=["parquet", "csv"], default="parquet")
    parser.add_argument("--duckdb-dir", default=str(DUCKDB_DIR))
    parser.add_argument("--out", default=None, help="output root (default depends on --format)")
    args = parser.parse_args()

    source_dir = pathlib.Path(args.duckdb_dir)
    out_root = pathlib.Path(args.out) if args.out else DEFAULT_OUT[args.format]
    failed = []
    for domain in args.domains or DOMAINS:
        db_path = source_dir / f"{domain}.duckdb"
        if not db_path.exists():
            print(f"{domain:12} no {db_path.name}; run the benchmark once to build it")
            failed.append(domain)
            continue
        try:
            manifest = export_domain(db_path, out_root / domain, args.format)
        except duckdb.IOException as e:
            print(f"{domain:12} cannot open ({str(e).splitlines()[0][:90]}); is DataFoundry running?")
            failed.append(domain)
            continue
        rows = sum(t["rows"] for t in manifest)
        size = sum(t["bytes"] for t in manifest) / 1e6
        print(f"{domain:12} {len(manifest):3} tables  {rows:>10,} rows  {size:7.1f} MB -> {out_root / domain}")
        if args.format == "csv":
            for t in manifest:
                if t["rows"] > DTRAIL_MAX_ROWS or t["bytes"] > DTRAIL_MAX_BYTES:
                    print(f"{'':12} over d-trail's default budget: {t['file']} "
                          f"({t['rows']:,} rows, {t['bytes'] / 1e6:.1f} MB)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
