"""Tournament grandstand (Blender space, Z up, metres; front edge on y=0 facing -Y, rising toward +Y).

A six-tier aluminium bleacher like the temporary stands behind tour greens: stepped decks with
risers, a bench on each tier, a painted fascia across the front and down the sides, a handrail
round the back and sides, and support columns underneath.

The game seats spectators on the tiers using the same numbers (keep in sync with
src/world/crowd.ts GRANDSTAND): width 16 m, 6 tiers, each 0.85 m deep and 0.42 m higher than the
one in front.
"""
import numpy as np

from env_mesh import MeshAccum

W, N, D, R = 16.0, 6, 0.85, 0.42


def grandstand():
    steel, seat, panel = MeshAccum(), MeshAccum(), MeshAccum()
    hw = W / 2
    for i in range(N):
        top = (i + 1) * R
        # deck and the riser in front of it
        steel.box((0, (i + 0.5) * D, top - 0.03), (hw, D / 2, 0.03))
        steel.box((0, i * D + 0.02, top - R / 2), (hw, 0.02, R / 2))
        # bench toward the front of each tier
        seat.box((0, i * D + 0.3, top + 0.42), (hw - 0.15, 0.13, 0.022))
        for x in np.arange(-hw + 0.5, hw - 0.4, 2.0):
            steel.box((x, i * D + 0.3, top + 0.2), (0.025, 0.1, 0.2))
        # side skirts under each tier
        for sx in (-1, 1):
            panel.box((sx * (hw + 0.02), (i + 0.5) * D, top / 2), (0.02, D / 2, top / 2))
    back = N * D
    topz = N * R
    # back wall and columns
    panel.box((0, back + 0.02, topz / 2), (hw + 0.04, 0.02, topz / 2))
    for x in np.arange(-hw, hw + 0.01, 4.0):
        steel.box((x, back - 0.1, topz / 2), (0.06, 0.06, topz / 2))
        steel.box((x, back / 2, R * N / 4), (0.05, 0.05, R * N / 4))
    # front fascia
    panel.box((0, -0.03, (R + 0.95) / 2), (hw + 0.04, 0.03, (R + 0.95) / 2))
    # handrails: back and sloped sides
    rail_h = 1.05
    steel.beam((-hw, back, topz + rail_h), (hw, back, topz + rail_h), 0.025, 0.025)
    for x in np.arange(-hw, hw + 0.01, 2.0):
        steel.beam((x, back, topz), (x, back, topz + rail_h), 0.02, 0.02, (0, 1, 0))
    for sx in (-1, 1):
        steel.beam((sx * hw, 0.0, R + rail_h), (sx * hw, back, topz + rail_h), 0.025, 0.025)
        for i in range(N + 1):
            y = min(back, i * D)
            z = max(R, min(topz, (i + 1) * R)) if i < N else topz
            steel.beam((sx * hw, y, z), (sx * hw, y, z + rail_h), 0.02, 0.02, (0, 1, 0))
    return dict(GrandstandSteel=steel, GrandstandSeat=seat, GrandstandPanel=panel)

