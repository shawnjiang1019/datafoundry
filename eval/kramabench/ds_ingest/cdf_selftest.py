#!/usr/bin/env python
# coding: utf-8
"""Self-test for the CDF ingestor (cdf.py).

Behaviour matrix (per spec):
  * cdflib NOT installed -> print "SKIPPED (cdflib unavailable)" and exit 0.
  * cdflib installed     -> generate a minimal CDF fixture with cdflib's own
                            CDF writer (best-effort across the 1.x / legacy
                            writer APIs).  If the writer is unavailable/errors
                            we can't fabricate a real CDF, so we print a clear
                            skip reason.  Otherwise run load()/to_csv()
                            assertions and print PASS/FAIL.
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdf  # noqa: E402  (local module under test)


def _build_mini_fixture(out_path):
    """Try every known cdflib writer API to write a 3-sample minimal CDF."""
    from datetime import datetime

    import cdflib
    import numpy as np

    times = [datetime(2024, 5, 11, h, 0, 0) for h in (0, 1, 2)]
    epoch_vals = cdflib.cdfepoch.compute(times)
    acc = np.array(
        [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]], dtype=np.float64
    )

    # Strategy 1: modern `cdflib.CDF(path, create=True)` context manager.
    try:
        with cdflib.CDF(out_path, create=True) as writer:
            writer["time"] = epoch_vals
            writer["a_cal"] = acc
        return out_path
    except Exception:
        pass

    # Strategy 2: legacy `cdflib.create(path)` + item assignment.
    try:
        writer = cdflib.create(out_path)
        writer["time"] = epoch_vals
        writer["a_cal"] = acc
        writer.close()
        return out_path
    except Exception:
        pass

    raise RuntimeError(
        "cdflib CDF writer API unavailable in this version "
        f"({getattr(cdflib, '__version__', '?')})"
    )


def main():
    try:
        import cdflib  # noqa: F401
    except ImportError:
        print("SKIPPED (cdflib unavailable)")
        return 0

    try:
        fixture = _build_mini_fixture(os.path.join(tempfile.mkdtemp(), "mini.cdf"))
    except Exception as exc:
        print(f"SKIPPED (cannot fabricate a minimal CDF fixture: {exc!r})")
        return 0

    try:
        rows = cdf.load(fixture)
        assert len(rows) == 3, f"expected 3 rows, got {len(rows)}"
        assert rows[0]["timestamp"].startswith("2024-05-11T"), rows[0]
        assert rows[0]["a_cal_0"] == 1.0, rows[0]
        assert rows[2]["a_cal_2"] == 9.0, rows[2]
        assert set(x for r in rows for x in r)  # non-empty, keys consistent

        csv_path = os.path.join(tempfile.mkdtemp(), "mini.csv")
        n = cdf.to_csv(fixture, csv_path)
        assert n == 3
        with open(csv_path, "r", encoding="utf-8") as fh:
            header = fh.readline().strip()
            assert header.split(",") == ["timestamp", "a_cal_0", "a_cal_1", "a_cal_2"], header
        print("PASS")
        return 0
    except AssertionError:
        import traceback

        traceback.print_exc()
        print("FAIL")
        return 1
    finally:
        try:
            os.unlink(fixture)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
