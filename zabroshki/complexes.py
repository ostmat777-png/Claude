"""Territories ("комплексы"): one marker + outline for a whole abandoned site instead of many small parts.

A complex is either
* an OSM territory polygon with a lifecycle tag (brownfield, disused military area, abandoned:* area …) that
  contains candidate buildings, or
* a cluster of suspicious buildings whose outlines are within ~40 m of each other (single linkage).
Members stay in the database (hidden by default in the UI) and are listed in the complex's panel.
"""
from __future__ import annotations

import logging
from collections import Counter

from shapely import STRtree
from shapely.ops import unary_union

from . import osm
from .candidates import new_candidate
from .geo import LocalProj

log = logging.getLogger(__name__)
LINK_M = 40.0          # buildings closer than this belong to one site
MIN_SCORE = 0.35       # buildings that take part in clustering
MIN_MEMBERS = 2
TERRITORY_MIN_M2 = 1500


def _n_buildings(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        w = "здание"
    elif n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        w = "здания"
    else:
        w = "зданий"
    return f"{n} {w}"


def _guard_of(members):
    gs = [m["guard"] for m in members]
    if "red" in gs:
        return "red"
    cnt = Counter(gs)
    return "green" if cnt.get("green", 0) > len(gs) / 2 else "yellow"


def build_complexes(cands, lp: LocalProj, start_idx: int) -> list:
    """Returns new complex candidates (already scored); marks members with f['complex_key']."""
    for c in cands:
        c["f"].pop("complex_key", None)
    cands[:] = [c for c in cands if c["kind"] != "complex"]
    blds = [c for c in cands if c.get("footprint") is not None and c["kind"] not in ("deadend", "clearing", "area")]
    if not blds:
        return []
    geoms = [lp.geom_to_m(c["footprint"]) for c in blds]
    tree = STRtree(geoms)
    groups: list[list[int]] = []
    used = set()

    # 1) OSM territories with lifecycle tags
    territories = [c for c in cands if c.get("footprint") is not None and c["kind"] in ("area", "military", "industrial")
                   and osm.is_lifecycle(c["tags"]) and "building" not in c["tags"]
                   and not osm.is_construction(c["tags"]) and not c["f"].get("in_construction")]
    terr_of_group = {}
    for t in territories:
        tg = lp.geom_to_m(t["footprint"])
        if tg.area < TERRITORY_MIN_M2:
            continue
        # the lifecycle tag is on the territory itself: every building inside belongs to the site
        idx = [i for i in tree.query(tg, predicate="intersects") if i not in used and blds[i] is not t]
        if len(idx) >= 1:
            groups.append(idx)
            used.update(idx)
            terr_of_group[len(groups) - 1] = t

    # 2) clusters of suspicious buildings
    seeds = [i for i, c in enumerate(blds) if c["score"] >= MIN_SCORE and i not in used]
    seed_set = set(seeds)
    parent = {i: i for i in seeds}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for i in seeds:
        for j in tree.query(geoms[i], predicate="dwithin", distance=LINK_M):
            if j in seed_set and j != i:
                parent[find(j)] = find(i)
    clusters: dict = {}
    for i in seeds:
        clusters.setdefault(find(i), []).append(i)
    for members in clusters.values():
        if len(members) >= MIN_MEMBERS:
            groups.append(members)

    out = []
    for gi, members in enumerate(groups):
        mem = [blds[i] for i in members]
        terr = terr_of_group.get(gi)
        if terr is not None:
            poly_m = lp.geom_to_m(terr["footprint"])
            tags = dict(terr["tags"])
        else:
            if len(mem) < MIN_MEMBERS:
                continue
            poly_m = unary_union([geoms[i].buffer(12) for i in members]).buffer(-6).simplify(2)
            if poly_m.is_empty:
                poly_m = unary_union([geoms[i] for i in members]).convex_hull
            tags = {}
        poly_ll = lp.geom_to_ll(poly_m)
        rp = poly_ll.representative_point()
        best = max(mem, key=lambda m: m["score"])
        if terr is not None and terr["score"] > best["score"]:
            best = terr
        n_rel = sum(1 for m in mem if m["f"].get("reliable"))
        kinds = Counter(m["kind"] for m in mem if m["kind"] not in ("house", "building", "unmapped"))
        what = {"military": "военный объект", "farm": "ферма", "industrial": "промзона", "ruins": "руины"}.get(
            kinds.most_common(1)[0][0] if kinds else "", "постройки")
        title = (terr["title"] + " — " if terr is not None and terr.get("title") else "") + \
            f"{what}, {_n_buildings(len(mem))}"
        cx = new_candidate(f"cx:{rp.y:.6f},{rp.x:.6f}", rp.y, rp.x, "complex", title, poly_ll,
                           set().union(*[m["sources"] for m in mem]), tags)
        cx["idx"] = start_idx + len(out)
        confirm = []
        for m in sorted(mem, key=lambda m: -m["score"]):
            for t in m["f"].get("confirm") or []:
                if t not in confirm:
                    confirm.append(t)
        f = cx["f"]
        f.update({
            "members": [m["idx"] for m in mem], "n_members": len(mem), "n_reliable": n_rel,
            "area_m2": round(poly_m.area, 0), "confirm": confirm[:6],
            "confirm_n": max((m["f"].get("confirm_n") or 0) for m in mem),
            "contra": [] if n_rel else (best["f"].get("contra") or []),
            # precision first: a territory is shown by default only if at least one of its buildings is reliable
            "reliable": bool(n_rel),
            "in_settlement": best["f"].get("in_settlement"), "near_place_name": best["f"].get("near_place_name"),
        })
        n_strong = sum(1 for m in mem if m["score"] >= 0.5)
        base = max(best["score"], terr["score"] if terr is not None else 0.0)
        cx["score"] = min(0.99, base + 0.03 * max(0, n_strong - 1))
        if terr is not None and terr["f"].get("reliable"):
            f["reliable"] = True
            for t_ in terr["f"].get("confirm") or []:
                if t_ not in f["confirm"]:
                    f["confirm"].insert(0, t_)
        cx["reasons"] = [{"w": 0, "text": f"Территория: {_n_buildings(len(mem))}, с высоким баллом {n_strong}, "
                                          f"надёжных {n_rel}", "k": "complex"}] + \
            [{"w": r["w"], "text": "Лучшее здание: " + r["text"], "k": r.get("k")} for r in best["reasons"][:6]]
        cx["guard"] = _guard_of(mem)
        cx["guard_reasons"] = [{"w": 0, "text": f"По зданиям комплекса: {dict(Counter(m['guard'] for m in mem))}"}] + \
            best["guard_reasons"][:5]
        cx["stage"] = max(m.get("stage", 1) for m in mem)
        for m in mem:
            m["f"]["complex_key"] = cx["key"]
        if terr is not None:
            terr["f"]["complex_key"] = cx["key"]  # the territory itself is represented by the complex
        out.append(cx)
    log.info("complexes: %d", len(out))
    return out
