#!/usr/bin/env python
# coding: utf-8
"""Ingestor for numpy binary grids (.npz) -> long-format grid rows.

Target data: ``mock_tiegcm_grid_sept2019.npz``, a mock geopotential grid that
the KramaBench hard-12 reference trilinearly interpolates with
``scipy.interpolate.RegularGridInterpolator``.

Variable-name contract (from the hard-12 reference):
    * lat_grid -> 1-D array of grid latitudes  (degrees)
    * lon_grid -> 1-D array of grid longitudes (degrees)
    * alt_grid -> 1-D array of grid altitudes  (km)

The geopotential field, if present in the file, is expected under one of
``geopotential_grid`` / ``potential_grid`` / ``potential`` / ``geopotential``
with shape ``(n_lat, n_lon, n_alt)`` (the order used by the reference when it
builds the field).  When the npz stores only the *axes* (which is all the
reference actually loads), we synthesize the mock field exactly as the
reference does:

    geopotential[i, :, :] = G * (R_EARTH * 1000 + alt[i] * 1000)   [J/kg]

i.e. an altitude-only field broadcast over lat/lon, where
``R_EARTH = 6371.0 km`` and ``G = 9.80665 m/s^2``.

Only ``numpy`` is required.
"""

from __future__ import annotations

import numpy as np

REQUIRES = {
    "numpy": ">=1.20",
}

R_EARTH_KM = 6371.0  # Earth radius in km (reference value)
G = 9.80665          # standard gravity, m/s^2

LAT_KEY = "lat_grid"
LON_KEY = "lon_grid"
ALT_KEY = "alt_grid"

FIELD_KEY_CANDIDATES = (
    "geopotential_grid",
    "potential_grid",
    "potential",
    "geopotential",
)


def requires() -> list[str]:
    """Human-readable dependency notes."""
    return [f"{k}{v}" for k, v in REQUIRES.items()]


def _synthesize_potential(alt_km):
    """Alt-axis-only geopotential in J/kg, matching the hard-12 mock field."""
    alt = np.asarray(alt_km, dtype=float)
    return G * (R_EARTH_KM * 1000.0 + alt * 1000.0)


def _resolve_axes(data):
    """Return (lat, lon, alt) 1-D arrays from the loaded NpzFile.

    Names follow the reference; unknown shapes are raveled to 1-D.
    """
    try:
        lat = np.asarray(data[LAT_KEY]).ravel()
        lon = np.asarray(data[LON_KEY]).ravel()
        alt = np.asarray(data[ALT_KEY]).ravel()
    except KeyError as exc:
        raise KeyError(
            f"Expected axes '{LAT_KEY}', '{LON_KEY}', '{ALT_KEY}' in {data.files}"
        ) from exc
    return lat, lon, alt


def _broadcast_field(field, n_lat, n_lon, n_alt):
    """Normalize a potential field to shape (n_lat, n_lon, n_alt).

    Accepts:
      * (n_lat, n_lon, n_alt) -> used verbatim (reference layout).
      * (n_alt,)              -> altitude-only field, broadcast over lat/lon.
    Returns (field_broadcast, description).
    """
    shape = tuple(field.shape)
    if shape == (n_lat, n_lon, n_alt):
        return field, f"3-D (lat, lon, alt) {shape}"
    if shape == (n_alt,):
        return np.broadcast_to(field[None, None, :], (n_lat, n_lon, n_alt)), (
            f"alt-axis only {shape} (broadcast over lat/lon)"
        )
    raise ValueError(
        f"Unsupported geopotential field shape {shape}; expected "
        f"({n_lat}, {n_lon}, {n_alt}) or ({n_alt},)"
    )


def load(path, field_key=None, synthesize=True):
    """Expand an npz geopotential grid into long-format rows.

    Returns a list of dicts, one per grid cell:
        {'grid_lat': <float>, 'grid_lon': <float>,
         'grid_alt': <float>, 'potential': <float>}

    Args:
        path:       Path to the .npz file.
        field_key:  Explicit key of the potential field inside the npz. When
                    ``None``, the first of FIELD_KEY_CANDIDATES found is used.
        synthesize: When no field is present and ``True`` (default), build the
                    mock altitude-only field (reference hard-12 formula).
                    When ``False``, raise ValueError instead.

    Raises:
        ValueError: if no field is in the npz and ``synthesize=False``, or the
                    field shape is not recognized.
    """
    with np.load(path) as data:
        lat, lon, alt = _resolve_axes(data)
        n_lat, n_lon, n_alt = lat.size, lon.size, alt.size

        if field_key is None:
            for candidate in FIELD_KEY_CANDIDATES:
                if candidate in data.files:
                    field_key = candidate
                    break

        if field_key is not None:
            field, _ = _broadcast_field(
                np.asarray(data[field_key]), n_lat, n_lon, n_alt
            )
            if field.dtype != object and field.dtype != bool:
                field = field.astype(float)
        elif synthesize:
            field = np.broadcast_to(
                _synthesize_potential(alt)[None, None, :], (n_lat, n_lon, n_alt)
            )
        else:
            raise ValueError(
                f"No geopotential field found in {data.files} "
                f"(none of {FIELD_KEY_CANDIDATES}); pass field_key or "
                "synthesize=True."
            )

        field = np.asarray(field)
        field = np.broadcast_to(field, (n_lat, n_lon, n_alt)).astype(float)

        grid_lat, grid_lon, grid_alt = np.meshgrid(lat, lon, alt, indexing="ij")
        glat = grid_lat.ravel()
        glon = grid_lon.ravel()
        galt = grid_alt.ravel()
        gpot = np.asarray(field).ravel()

        rows = [
            {
                "grid_lat": a.item(),
                "grid_lon": b.item(),
                "grid_alt": c.item(),
                "potential": d.item(),
            }
            for a, b, c, d in zip(glat, glon, galt, gpot)
        ]
        return rows
