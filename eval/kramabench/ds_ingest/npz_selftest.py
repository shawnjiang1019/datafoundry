#!/usr/bin/env python
# coding: utf-8
"""Self-test for the NPZ ingestor (npz.py).

Builds a tiny geopotential grid inline with numpy, saves it to a temp .npz,
loads it back via npz.load() and asserts row counts / key sets / types /
values.  Also checks the synthesized (alt-axis only) fallback path.
"""

from __future__ import annotations

import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import npz  # noqa: E402  (local module under test)


def _build_cases(tmpdir):
    lat = np.array([-60.0, 0.0, 60.0])
    lon = np.array([-180.0, 0.0, 180.0])
    alt = np.array([100.0, 200.0])

    grid_lat, grid_lon, grid_alt = np.meshgrid(lat, lon, alt, indexing="ij")
    field = grid_alt * 0.0 + grid_lat * 0.0 + grid_alt  # potential == altitude

    with_field = os.path.join(tmpdir, "with_field.npz")
    np.savez(
        with_field,
        lat_grid=lat,
        lon_grid=lon,
        alt_grid=alt,
        geopotential_grid=field,
    )
    axes_only = os.path.join(tmpdir, "axes_only.npz")
    np.savez(axes_only, lat_grid=lat, lon_grid=lon, alt_grid=alt)
    return with_field, axes_only, (lat, lon, alt, field)


def main():
    tmpdir = tempfile.mkdtemp(prefix="npz_selftest_")
    try:
        with_field, axes_only, (lat, lon, alt, field) = _build_cases(tmpdir)
        n_expected = int(lat.size * lon.size * alt.size)

        rows = npz.load(with_field)
        assert len(rows) == n_expected, (len(rows), n_expected)
        for row in rows:
            assert set(row) == {"grid_lat", "grid_lon", "grid_alt", "potential"}
            for key in ("grid_lat", "grid_lon", "grid_alt", "potential"):
                assert isinstance(row[key], float), (key, type(row[key]))
        assert rows[0]["grid_lat"] == -60.0 and rows[0]["grid_lon"] == -180.0
        assert rows[0]["grid_alt"] == 100.0 and rows[0]["potential"] == 100.0

        assert float(field.ravel().sum()) == sum(r["potential"] for r in rows)

        # Synthesized altitude-only fallback (reference hard-12 formula).
        rows2 = npz.load(axes_only)
        assert len(rows2) == n_expected
        expect0 = npz.G * (npz.R_EARTH_KM * 1000.0 + alt[0] * 1000.0)
        assert rows2[0]["potential"] == expect0
        assert rows2[n_expected - 1]["potential"] == npz.G * (
            npz.R_EARTH_KM * 1000.0 + alt[-1] * 1000.0
        )

        # synthesize=False must raise when the field is absent.
        try:
            npz.load(axes_only, synthesize=False)
        except ValueError:
            pass
        else:
            raise AssertionError("expected ValueError when synthesize=False")
        print("PASS")
        return 0
    except AssertionError:
        import traceback

        traceback.print_exc()
        print("FAIL")
        return 1
    finally:
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
