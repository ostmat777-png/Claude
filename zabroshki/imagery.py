"""Dense imagery scan of the whole area (stage A, cheap) + per-candidate image features.

* classical per-pixel indices: ExG greenness, local texture -> tree mask, vegetation mask
* DINOv2 patch tokens -> building detector trained on the fly from OSM + Microsoft footprints
* detections of buildings that are not on any map, forest clearings
* per-candidate: trees over the footprint, trees/vegetation in the yard ring, overgrowth vs neighbours,
  detector probability on the footprint, embedding for the abandonment classifier (A)
"""
from __future__ import annotations

import logging
import random
import time

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely import STRtree
from shapely.geometry import box

from . import db, tiles
from .geo import TILE, lonlat_to_pixel, meters_per_pixel, pixel_to_lonlat, tile_bounds, tiles_for_polygon

log = logging.getLogger(__name__)


# ------------------------------------------------------------------ open water from a coarse overview
def _water_like(a: np.ndarray) -> bool:
    veg, tree, lum, snow = veg_tree_masks(a)
    g = a.astype(np.float32).mean(axis=2)
    tex = np.abs(np.diff(g, axis=1)).mean()
    return bool(lum.mean() < 70 and tex < 6 and tree.mean() < 0.03 and lum.max() < 200)


def open_water_tiles(provider, z, tile_list, job=None, dz=3) -> set:
    """Scan tiles that are open water, judged on a z-3 overview (64x fewer downloads). Conservative: the tile AND
    its 8 neighbours must look like water, so shores, islands and piers are always scanned."""
    zo = z - dz
    k = TILE >> dz
    over = sorted({(x >> dz, y >> dz) for x, y in tile_list})
    tiles.prefetch(provider, zo, over, checkpoint=job.checkpoint if job else None,
                   progress=(lambda d, n: job.progress(d, n, f"Обзор местности z{zo}: {d}/{n}")) if job else None)
    cache: dict = {}

    def is_w(x, y):
        key = (x >> dz, y >> dz)
        if key not in cache:
            cache[key] = tiles.tile_array(provider, zo, *key, fetch=False)
        a = cache[key]
        if a is None:
            return False
        sx, sy = (x - (key[0] << dz)) * k, (y - (key[1] << dz)) * k
        return _water_like(a[sy:sy + k, sx:sx + k])
    wl = {t: is_w(*t) for t in tile_list}
    return {(x, y) for (x, y), w in wl.items()
            if w and all(wl.get((x + dx, y + dy), False) for dx in (-1, 0, 1) for dy in (-1, 0, 1))}


class TileFeeder:
    """Downloads tiles in the background, in the order they were added (the polite per-server rate limit applies),
    so the scan can work on tiles that already arrived while others are still downloading, and downloads can start
    while OSM data is still loading."""

    def __init__(self, provider, z, checkpoint=None, threads=None):
        from concurrent.futures import ThreadPoolExecutor
        from .config import settings
        self.provider, self.z = provider, z
        self.checkpoint = checkpoint
        self.ex = ThreadPoolExecutor(max_workers=threads or settings()["download_threads"])
        self.futs: dict = {}
        self.order: list = []
        self.stopped = False
        self.n_new = 0

    def add(self, xys):
        xys = [xy for xy in xys if xy not in self.futs]
        have = db.tiles_cached(self.provider, self.z, xys) if xys else set()
        for xy in xys:
            self.order.append(xy)
            self.futs[xy] = None if xy in have else self.ex.submit(self._get, xy)

    def _get(self, xy):
        if self.stopped:
            return None
        try:
            if self.checkpoint:
                self.checkpoint()   # blocks while the search is paused
            st = tiles.fetch_tile(self.provider, self.z, xy[0], xy[1])[0]
            self.n_new += 1
            return st
        except Exception:
            return None

    def wait(self, xy, timeout=180):
        f = self.futs.get(xy)
        if f is not None:
            try:
                f.result(timeout=timeout)
            except Exception:
                pass

    def pending(self) -> int:
        return sum(1 for f in self.futs.values() if f is not None and not f.done())

    def close(self):
        self.stopped = True
        self.ex.shutdown(wait=False, cancel_futures=True)


# ------------------------------------------------------------------ classical indices
def veg_tree_masks(img: np.ndarray):
    """Returns (vegetation mask, tree mask, luminance, snow_fraction) for an RGB uint8 image.

    Trees vs grass: both are green, but a tree canopy is strongly textured (crowns + shadows),
    grass/meadows are smooth. Water is dark but not green and not textured.
    """
    a = img.astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = (r + g + b) / 3.0
    exg = 2 * g - r - b
    veg = (exg > 12) | ((g > r) & (g > b) & (exg > 6))
    m1 = ndimage.uniform_filter(lum, 7)
    m2 = ndimage.uniform_filter(lum * lum, 7)
    std = np.sqrt(np.maximum(m2 - m1 * m1, 0))
    vegn = ndimage.uniform_filter(veg.astype(np.float32), 9)
    tree_px = (veg | (lum < 55)) & (std > 8) & (vegn > 0.4)
    tree = ndimage.uniform_filter(tree_px.astype(np.float32), 7) > 0.45
    sat = a.max(axis=2) - a.min(axis=2)
    snow = float(((lum > 200) & (sat < 25)).mean())
    return veg, tree, lum, snow


def block_mean(mask: np.ndarray, G: int) -> np.ndarray:
    k = mask.shape[0] // G
    return mask[:G * k, :G * k].reshape(G, k, G, k).mean(axis=(1, 3))


# ------------------------------------------------------------------ footprint raster
class FootprintRaster:
    def __init__(self, polys_ll, z):
        self.polys = [p for p in polys_ll if p is not None and not p.is_empty]
        self.tree = STRtree(self.polys) if self.polys else None
        self.z = z

    def tile_mask(self, tx, ty) -> np.ndarray:
        m = Image.new("L", (TILE, TILE), 0)
        if self.tree is None:
            return np.zeros((TILE, TILE), bool)
        w, s, e, n = tile_bounds(tx, ty, self.z)
        idx = self.tree.query(box(w, s, e, n))
        if len(idx) == 0:
            return np.zeros((TILE, TILE), bool)
        d = ImageDraw.Draw(m)
        ox, oy = tx * TILE, ty * TILE
        for i in idx:
            g = self.polys[i]
            for poly in (g.geoms if g.geom_type == "MultiPolygon" else [g]):
                if poly.geom_type != "Polygon":
                    continue
                pts = [(lambda p: (p[0] - ox, p[1] - oy))(lonlat_to_pixel(x, y, self.z)) for x, y in poly.exterior.coords]
                if len(pts) >= 3:
                    d.polygon(pts, fill=255)
        return np.asarray(m) > 0


class Scanner:
    def __init__(self, poly, lp, opts, job):
        self.poly = poly
        self.lp = lp
        self.opts = opts
        self.job = job
        self.provider = opts.get("imagery_provider", "esri")
        self.z = int(opts.get("scan_zoom", 17))
        self.tiles = tiles_for_polygon(poly, self.z)
        self.stats: dict = {"scan_tiles": len(self.tiles), "scan_zoom": self.z}
        from .models import torch_available
        self.use_models = bool(opts.get("use_models")) and torch_available()
        self.dino = None
        self.G = 16
        self.detector = None
        self.cand_emb: dict = {}
        xs = [t[0] for t in self.tiles] or [0]
        ys = [t[1] for t in self.tiles] or [0]
        self.tx0, self.ty0 = min(xs), min(ys)
        self.nx, self.ny = max(xs) - self.tx0 + 1, max(ys) - self.ty0 + 1
        self.mpp = meters_per_pixel(poly.centroid.y, self.z)
        self.scan_tiles = list(self.tiles)
        self.skipped: set = set()
        self.water: set = set()
        self.det_sample: list | None = None
        self.raster = None
        self.feeder = None

    # -------------------------------------------------------------- plan (fast mode) + background download
    def prepare(self, fps, job=None):
        """Before OSM: open-water overview, the detector training sample and background download of the tiles that
        are needed in any case (no known buildings: forest, fields)."""
        fast = self.opts.get("search_mode", "fast") == "fast"
        fp_tree = STRtree(list(fps)) if fps else None

        def has_b(t):
            w, s, e, n = tile_bounds(t[0], t[1], self.z)
            return fp_tree is not None and len(fp_tree.query(box(w, s, e, n))) > 0
        with_b = {t for t in self.tiles if has_b(t)}
        if fast:
            try:
                self.water = {t for t in open_water_tiles(self.provider, self.z, self.tiles, job) if t not in with_b}
            except Exception as e:
                from .jobs import Cancelled
                if isinstance(e, Cancelled):
                    raise
                log.warning("water overview failed: %s", e)
        rng = random.Random(42)
        from .models import accelerated, torch_available
        n_train = min(len(self.tiles), 500 if (torch_available() and accelerated()) else 220)
        wb = sorted(with_b)
        wo = [t for t in self.tiles if t not in with_b and t not in self.water]
        sample = rng.sample(wb, min(len(wb), int(n_train * 0.7)))
        sample += rng.sample(wo, min(len(wo), n_train - len(sample)))
        self.det_sample = sample
        self.feeder = TileFeeder(self.provider, self.z, checkpoint=self.job.checkpoint)
        if self.opts.get("use_models"):
            self.feeder.add(sample)
        self.feeder.add([t for t in self.tiles if t not in with_b and t not in self.water])
        self.stats["water_tiles_skipped"] = len(self.water)
        return len(self.feeder.order)

    def plan(self, cands):
        """After OSM: in the fast mode skip tiles where no candidate can ever become a reliable mark (dachas, dense
        settlements, garages, parks … without OSM lifecycle tags) and open water without buildings."""
        from .scoring import never_reliable
        skip = set(self.water)
        if self.opts.get("search_mode", "fast") == "fast":
            by_tile: dict = {}
            for c in cands:
                px, py = lonlat_to_pixel(c["lon"], c["lat"], self.z)
                by_tile.setdefault((int(px // TILE), int(py // TILE)), []).append(c)
            dense = {t for t, cl in by_tile.items() if all(never_reliable(c) for c in cl)}
            skip = (skip - set(by_tile)) | dense
            self.stats["dense_tiles_skipped"] = len(dense & set(self.tiles))
        self.skipped = skip & set(self.tiles)
        self.scan_tiles = [t for t in self.tiles if t not in self.skipped]
        self.stats["scan_tiles"] = len(self.scan_tiles)
        if self.feeder is None:
            self.feeder = TileFeeder(self.provider, self.z, checkpoint=self.job.checkpoint)
        self.feeder.add(self.scan_tiles)
        return len(self.skipped)

    def close(self):
        if self.feeder is not None:
            self.feeder.close()

    # -------------------------------------------------------------- download
    def download(self):
        """Blocking download of all scan tiles (old behaviour; the pipeline now streams tiles into the scan)."""
        t = time.time()
        res = tiles.prefetch(self.provider, self.z, self.tiles,
                             progress=lambda d, n: self.job.progress(d, n, f"Тайлы z{self.z}: {d}/{n}"),
                             checkpoint=self.job.checkpoint)
        self.stats["tiles_downloaded"] = len(res)
        self.job.info(f"Тайлов z{self.z}: {len(self.tiles)} (скачано новых {len(res)}, из кэша {len(self.tiles) - len(res)}) "
                      f"за {time.time() - t:.0f} с")

    # -------------------------------------------------------------- helpers
    def _grid_index(self, tx, ty):
        return (ty - self.ty0) * self.G, (tx - self.tx0) * self.G

    def cell_of(self, lon, lat):
        px, py = lonlat_to_pixel(lon, lat, self.z)
        k = TILE / self.G
        return int(py // k) - self.ty0 * self.G, int(px // k) - self.tx0 * self.G

    def cell_center_ll(self, r, c):
        k = TILE / self.G
        px = (c + self.tx0 * self.G + 0.5) * k
        py = (r + self.ty0 * self.G + 0.5) * k
        return pixel_to_lonlat(px, py, self.z)

    # -------------------------------------------------------------- main
    def run(self, cands, ctx, fps, osmdata):
        job = self.job
        if self.use_models:
            try:
                from .models import get_dino
                job.info("Загрузка DINOv2…")
                self.dino = get_dino()
                self.G = self.dino.grid
            except Exception as e:
                job.info(f"DINOv2 недоступен ({e}); скан только классическими индексами")
                self.use_models = False
        G = self.G
        H, W = self.ny * G, self.nx * G
        self.tree_g = np.zeros((H, W), np.uint8)
        self.veg_g = np.zeros((H, W), np.uint8)
        self.dark_g = np.zeros((H, W), np.uint8)
        self.bprob_g = np.zeros((H, W), np.uint8)
        self.known_g = np.zeros((H, W), np.uint8)
        self.valid_g = np.zeros((H, W), bool)
        known_polys = [b["geom"] for b in osmdata.buildings if b["geom"].geom_type in ("Polygon", "MultiPolygon")] + list(fps)
        self.raster = FootprintRaster(known_polys, self.z)
        if self.feeder is None:
            self.plan(cands)

        # candidates per tile (for embeddings)
        by_tile: dict = {}
        for c in cands:
            px, py = lonlat_to_pixel(c["lon"], c["lat"], self.z)
            by_tile.setdefault((int(px // TILE), int(py // TILE)), []).append(c)

        if self.use_models:
            self._train_detector()

        # ---- full pass (tiles stream in from the background downloader, in the order it fetches them)
        want = set(self.scan_tiles)
        order = [t for t in self.feeder.order if t in want]
        order += [t for t in self.scan_tiles if t not in set(order)]
        B = self.dino.batch if self.dino else 8
        t0 = time.time()
        snowy = 0
        for i in range(0, len(order), B):
            job.checkpoint()
            chunk = order[i:i + B]
            imgs, keep = [], []
            for (tx, ty) in chunk:
                self.feeder.wait((tx, ty))
                a = tiles.tile_array(self.provider, self.z, tx, ty, fetch=False)
                if a is None:
                    a = tiles.tile_array(self.provider, self.z, tx, ty, fetch=True)
                if a is None:
                    continue
                imgs.append(a)
                keep.append((tx, ty))
            if not imgs:
                continue
            arr = np.stack(imgs)
            toks = None
            if self.use_models:
                toks, _cls = self.dino.tokens(arr)
            for j, (tx, ty) in enumerate(keep):
                r0, c0 = self._grid_index(tx, ty)
                veg, tree, lum, snow = veg_tree_masks(arr[j])
                if snow > 0.3:
                    snowy += 1
                self.tree_g[r0:r0 + G, c0:c0 + G] = (block_mean(tree, G) * 255).astype(np.uint8)
                self.veg_g[r0:r0 + G, c0:c0 + G] = (block_mean(veg, G) * 255).astype(np.uint8)
                self.dark_g[r0:r0 + G, c0:c0 + G] = (block_mean(lum < 60, G) * 255).astype(np.uint8)
                self.known_g[r0:r0 + G, c0:c0 + G] = (block_mean(self.raster.tile_mask(tx, ty), G) * 255).astype(np.uint8)
                self.valid_g[r0:r0 + G, c0:c0 + G] = snow < 0.3
                if toks is not None:
                    tk = toks[j]
                    if self.detector is not None:
                        p = self._detect(tk.reshape(G * G, -1)).reshape(G, G)
                        self.bprob_g[r0:r0 + G, c0:c0 + G] = (p * 255).astype(np.uint8)
                    tile_mean = tk.reshape(G * G, -1).mean(axis=0)
                    for c in by_tile.get((tx, ty), []):
                        self.cand_emb[c["key"]] = self._pool(tk, tile_mean, c["lon"], c["lat"], tx, ty)
            done = min(i + B, len(order))
            el = time.time() - t0
            pend = self.feeder.pending()
            job.progress(done, len(order), f"Скан z{self.z}: {done}/{len(order)} тайлов, {done / max(el, 1e-3):.1f} т/с"
                         + (f" (ещё скачивается {pend})" if pend else ""))
        self.stats["snowy_tiles"] = snowy
        self.stats["tiles_downloaded"] = self.feeder.n_new
        if self.use_models:
            self._store_embeddings(cands)

        # ---- new candidates from imagery
        new = []
        if self.detector is not None:
            new += self._unmapped_buildings(ctx)
        new += self._clearings(ctx)
        self.stats["image_buildings"] = sum(1 for c in new if c["kind"] == "unmapped")
        self.stats["clearings"] = sum(1 for c in new if c["kind"] == "clearing")
        job.info(f"По снимкам: новых построек {self.stats['image_buildings']}, прогалин {self.stats['clearings']}")

        # ---- per-candidate features for existing candidates (tile order keeps the decoded-tile LRU warm)
        allc = sorted(cands, key=lambda c: (int(lonlat_to_pixel(c["lon"], c["lat"], self.z)[1] // TILE),
                                            int(lonlat_to_pixel(c["lon"], c["lat"], self.z)[0] // TILE)))
        from .scoring import never_reliable
        fast = self.opts.get("search_mode", "fast") == "fast"
        for i, c in enumerate(allc):
            if i % 200 == 0:
                job.checkpoint()
                job.progress(i, len(allc), f"Признаки кандидатов по снимку: {i}/{len(allc)}")
            px, py = lonlat_to_pixel(c["lon"], c["lat"], self.z)
            if (int(px // TILE), int(py // TILE)) in self.skipped:
                continue   # no imagery downloaded here on purpose (fast mode)
            c["f"].update(self.candidate_features(c, fetch=not (fast and never_reliable(c))))
        for c in new:
            c["f"].update(self.candidate_features(c))
        self.relative_overgrowth(allc + new)
        n_rf = 0
        for i, c in enumerate(allc + new):
            if c["kind"] in ("deadend", "clearing"):
                continue
            # only used outside settlements and dense dacha clusters (see scoring.road_overgrown)
            from .scoring import dense_cluster
            if c["f"].get("in_settlement") or dense_cluster(c["f"]):
                continue
            px, py = lonlat_to_pixel(c["lon"], c["lat"], self.z)
            if (int(px // TILE), int(py // TILE)) in self.skipped:
                continue
            if i % 200 == 0:
                job.checkpoint()
                job.progress(i, len(allc) + len(new), "Подъездные дороги на снимке")
            rf = self.road_features(c, ctx)
            if rf:
                c["f"].update(rf)
                n_rf += 1
        self.stats["access_roads_checked"] = n_rf
        if self.use_models and new:
            self._embed_new(new)
        return new

    # -------------------------------------------------------------- detector
    def _train_detector(self):
        job = self.job
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import roc_auc_score
        G = self.G
        rng = random.Random(42)
        with_b, without = [], []
        for t in self.tiles:
            w, s, e, n = tile_bounds(t[0], t[1], self.z)
            if self.raster.tree is not None and len(self.raster.tree.query(box(w, s, e, n))) > 0:
                with_b.append(t)
            else:
                without.append(t)
        from .models import accelerated
        n_train = min(len(self.tiles), 500 if accelerated() else 220)
        if self.det_sample:
            sample = list(self.det_sample)
            for t in sample:
                self.feeder.wait(t)
        else:
            sample = rng.sample(with_b, min(len(with_b), int(n_train * 0.7)))
            sample += rng.sample(without, min(len(without), n_train - len(sample)))
        if len(with_b) < 5:
            job.info("Слишком мало известных зданий для обучения детектора — детектор отключён")
            return
        X, Y, T = [], [], []
        for i in range(0, len(sample), 16):
            job.checkpoint()
            job.progress(i, len(sample), f"Детектор зданий: обучение на {len(sample)} тайлах")
            chunk = sample[i:i + 16]
            imgs, keep = [], []
            for (tx, ty) in chunk:
                a = tiles.tile_array(self.provider, self.z, tx, ty)
                if a is not None:
                    imgs.append(a)
                    keep.append((tx, ty))
            if not imgs:
                continue
            toks, _ = self.dino.tokens(np.stack(imgs))
            for j, (tx, ty) in enumerate(keep):
                cov = block_mean(self.raster.tile_mask(tx, ty), G)
                near = ndimage.maximum_filter(cov, size=3)
                tk = toks[j].reshape(G * G, -1)
                pos = cov.reshape(-1) >= 0.4
                neg = near.reshape(-1) == 0
                for k in np.nonzero(pos)[0]:
                    X.append(tk[k]); Y.append(1); T.append(tx * 100000 + ty)
                negs = np.nonzero(neg)[0]
                if len(negs) > 24:
                    negs = np.array(rng.sample(list(negs), 24))
                for k in negs:
                    X.append(tk[k]); Y.append(0); T.append(tx * 100000 + ty)
        X = np.asarray(X, np.float32)
        Y = np.asarray(Y)
        if Y.sum() < 20 or (1 - Y).sum() < 20:
            job.info("Мало данных для детектора зданий — отключён")
            return
        T = np.asarray(T)
        ut = np.unique(T)
        rs = np.random.RandomState(0)
        test_t = set(rs.choice(ut, size=max(1, len(ut) // 5), replace=False))
        te = np.array([t in test_t for t in T])
        self.mu = X[~te].mean(axis=0)
        self.sd = X[~te].std(axis=0) + 1e-4
        clf = LogisticRegression(C=0.05, class_weight="balanced", max_iter=1000)
        clf.fit((X[~te] - self.mu) / self.sd, Y[~te])
        auc = None
        if te.any() and len(set(Y[te])) == 2:
            auc = roc_auc_score(Y[te], clf.predict_proba((X[te] - self.mu) / self.sd)[:, 1])
        clf.fit((X - self.mu) / self.sd, Y)
        self.detector = clf
        self.stats["detector_samples"] = int(len(Y))
        self.stats["detector_auc"] = round(float(auc), 3) if auc is not None else None
        job.info(f"Детектор зданий обучен: {int(Y.sum())} токенов-зданий / {int((1 - Y).sum())} фоновых, "
                 f"AUC на отложенных тайлах = {auc:.3f}" if auc is not None else "Детектор зданий обучен")

    def _detect(self, tok2d):
        return self.detector.predict_proba((tok2d - self.mu) / self.sd)[:, 1]

    def _pool(self, tk, tile_mean, lon, lat, tx, ty):
        G = self.G
        px, py = lonlat_to_pixel(lon, lat, self.z)
        k = TILE / G
        r = int((py - ty * TILE) // k)
        c = int((px - tx * TILE) // k)
        rad = max(1, G // 16)
        local = tk[max(0, r - rad):r + rad + 1, max(0, c - rad):c + rad + 1].reshape(-1, tk.shape[-1]).mean(axis=0)
        return np.concatenate([local, tile_mean]).astype(np.float32)

    def emb_key(self, lat, lon):
        return f"A|{self.dino.name}|{self.dino.size}|{self.provider}|{self.z}|{lat:.6f},{lon:.6f}"

    def _store_embeddings(self, cands):
        items = {}
        for c in cands:
            e = self.cand_emb.get(c["key"])
            if e is not None:
                items[self.emb_key(c["lat"], c["lon"])] = e
        db.emb_put_many(items)

    def _embed_new(self, new):
        embs = embed_points_A([(c["lat"], c["lon"]) for c in new], self.provider, self.z)
        for c, e in zip(new, embs):
            if e is not None:
                self.cand_emb[c["key"]] = e

    def embedding(self, c):
        return self.cand_emb.get(c["key"])

    # -------------------------------------------------------------- new candidates
    def _settled(self, ctx, lon, lat):
        from shapely.geometry import Point
        pt = Point(*self.lp.fwd(lon, lat))
        lu = ctx.landuse_at(pt)
        if any(k in lu for k in ("residential", "industrial", "commercial", "retail", "garages", "place_area",
                                 "railway", "construction", "allotments")):
            return True
        st = ctx.settlement(pt)
        return bool(st and st[1] in ("city", "town", "suburb", "quarter", "neighbourhood"))

    def _unmapped_buildings(self, ctx):
        from .candidates import new_candidate
        G = self.G
        cell_m = TILE / G * self.mpp
        prob = self.bprob_g.astype(np.float32) / 255
        known = ndimage.maximum_filter(self.known_g, size=3) > 25
        det = (prob >= 0.75) & ~known & self.valid_g
        lab, n = ndimage.label(det)
        out = []
        if n == 0:
            return out
        objs = ndimage.find_objects(lab)
        tree = self.tree_g.astype(np.float32) / 255
        tree_ctx = ndimage.uniform_filter(tree, size=max(3, int(60 / cell_m)))
        for i, sl in enumerate(objs, start=1):
            comp = lab[sl] == i
            ncell = int(comp.sum())
            area = ncell * cell_m * cell_m
            if area > 4000:  # fields/roads detected as built-up
                continue
            pr = prob[sl][comp]
            if pr.max() < 0.88 and ncell < 2:
                continue
            rr, cc = np.nonzero(comp)
            r = rr.mean() + sl[0].start
            c = cc.mean() + sl[1].start
            lon, lat = self.cell_center_ll(r, c)
            if not self.poly.contains(box(lon - 1e-6, lat - 1e-6, lon + 1e-6, lat + 1e-6)):
                continue
            if self._settled(ctx, lon, lat) and tree_ctx[int(r), int(c)] < 0.5:
                continue  # inside towns/dachas OSM+MS are complete enough; keep only spots under tree cover
            cand = new_candidate(f"img:{lat:.6f},{lon:.6f}", lat, lon, "unmapped",
                                 "постройка по снимку (нет на картах)", None, [f"снимок z{self.z}"])
            cand["f"]["image_detected"] = True
            cand["f"]["bprob"] = round(float(pr.max()), 3)
            cand["f"]["detector_ok"] = True
            cand["f"]["det_area_m2"] = round(area, 1)
            out.append(cand)
        return out

    def _clearings(self, ctx):
        from .candidates import new_candidate
        G = self.G
        cell_m = TILE / G * self.mpp
        tree = self.tree_g.astype(np.float32) / 255
        forest = ndimage.binary_closing(tree >= 0.5, iterations=1)
        open_ = ~forest & self.valid_g
        dark = self.dark_g.astype(np.float32) / 255
        veg = self.veg_g.astype(np.float32) / 255
        lab, n = ndimage.label(open_)
        out = []
        if n == 0:
            return out
        min_cells = max(1, int(round(120 / (cell_m * cell_m))))
        max_cells = int(6000 / (cell_m * cell_m))
        objs = ndimage.find_objects(lab)
        for i, sl in enumerate(objs, start=1):
            h = sl[0].stop - sl[0].start
            w = sl[1].stop - sl[1].start
            if h * w > max_cells * 4:
                continue
            comp = lab[sl] == i
            ncell = int(comp.sum())
            if ncell < min_cells or ncell > max_cells:
                continue
            fill = ncell / float(h * w)
            if max(h, w) / max(1, min(h, w)) >= 4 and fill < 0.45:
                continue  # roads, power-line cuts
            r0, r1 = max(0, sl[0].start - 2), sl[0].stop + 2
            c0, c1 = max(0, sl[1].start - 2), sl[1].stop + 2
            big = lab[r0:r1, c0:c1] == i
            ring = ndimage.binary_dilation(big, iterations=2) & ~big
            if ring.sum() == 0:
                continue
            fr = forest[r0:r1, c0:c1][ring].mean()
            if fr < 0.7:
                continue
            if dark[sl][comp].mean() > 0.6 and veg[sl][comp].mean() < 0.2:
                continue  # water / deep shadow
            rr, cc = np.nonzero(comp)
            r = rr.mean() + sl[0].start
            c = cc.mean() + sl[1].start
            lon, lat = self.cell_center_ll(r, c)
            if not self.poly.contains(box(lon - 1e-6, lat - 1e-6, lon + 1e-6, lat + 1e-6)):
                continue
            if self._settled(ctx, lon, lat):
                continue
            cand = new_candidate(f"clear:{lat:.6f},{lon:.6f}", lat, lon, "clearing", "прогалина в лесу", None,
                                 [f"снимок z{self.z}"])
            cand["f"]["on_clearing"] = True
            cand["f"]["clearing_area_m2"] = round(ncell * cell_m * cell_m, 0)
            cand["f"]["forest_ring"] = round(float(fr), 2)
            if self.detector is not None:
                cand["f"]["bprob"] = round(float(self.bprob_g[sl][comp].max() / 255), 3)
            out.append(cand)
        return out

    # -------------------------------------------------------------- per candidate
    def candidate_features(self, c, fetch=True) -> dict:
        fp = c.get("footprint")
        f = crop_features(self.provider, self.z, c, self.mpp, fetch=fetch)
        if not f.get("img_valid") or f.get("snow"):
            return f
        rr, cc = self.cell_of(c["lon"], c["lat"])
        H, W = self.tree_g.shape
        if 0 <= rr < H and 0 <= cc < W:
            rad = max(1, int(100 / (TILE / self.G * self.mpp)))
            win = self.tree_g[max(0, rr - rad):rr + rad + 1, max(0, cc - rad):cc + rad + 1]
            f["forest_100m"] = round(float(win.mean() / 255), 3)
            if self.detector is not None:
                f["detector_ok"] = True
                # max detector probability over the footprint cells
                cells = [(rr, cc)]
                if fp is not None:
                    b = fp.bounds
                    r1, c1 = self.cell_of(b[0], b[3])
                    r2, c2 = self.cell_of(b[2], b[1])
                    cells = [(a, bb) for a in range(min(r1, r2), max(r1, r2) + 1) for bb in range(min(c1, c2), max(c1, c2) + 1)]
                vals = [self.bprob_g[a, bb] for a, bb in cells if 0 <= a < H and 0 <= bb < W]
                if vals:
                    f["bprob"] = round(float(max(vals)) / 255, 3)
        return f

    def road_features(self, c, ctx):
        """Is the nearest minor access road (track/path/service) overgrown on the image?"""
        from shapely.geometry import Point
        tr, geoms, items = ctx.highways
        if tr is None:
            return None
        x, y = self.lp.fwd(c["lon"], c["lat"])
        pt = Point(x, y)
        idx = tr.query(pt, predicate="dwithin", distance=120)
        best, bd = None, 1e9
        for i in idx:
            hw = items[i][1].get("highway")
            if hw not in ("track", "path", "service", "unclassified", "bridleway", "footway"):
                continue
            d = geoms[i].distance(pt)
            if d < bd:
                best, bd = i, d
        if best is None:
            return None
        seg = geoms[best].intersection(pt.buffer(min(80.0, bd + 50.0)))
        if seg.is_empty:
            return None
        size = 320
        img, valid = tiles.crop_lonlat(self.provider, self.z, c["lon"], c["lat"], size)
        if valid < 0.6:
            return None
        cx, cy = lonlat_to_pixel(c["lon"], c["lat"], self.z)
        m = Image.new("L", (size, size), 0)
        d = ImageDraw.Draw(m)
        width = max(3, int(round(3.5 / self.mpp)))
        lines = seg.geoms if hasattr(seg, "geoms") else [seg]
        for ln in lines:
            if ln.geom_type != "LineString":
                continue
            pts = []
            for xx, yy in ln.coords:
                lon, lat = self.lp.inv(xx, yy)
                px, py = lonlat_to_pixel(lon, lat, self.z)
                pts.append((px - cx + size / 2, py - cy + size / 2))
            if len(pts) >= 2:
                d.line(pts, fill=255, width=width)
        mask = np.asarray(m) > 0
        if mask.sum() < 20:
            return None
        veg, tree, lum, snow = veg_tree_masks(img)
        if snow > 0.3:
            return None
        return {"road_tree": round(float(tree[mask].mean()), 3), "road_veg": round(float(veg[mask].mean()), 3),
                "access_road": items[best][1].get("highway"), "access_road_dist": round(bd, 1)}

    def relative_overgrowth(self, cands):
        """Yard vegetation compared with buildings within 300 m (robust z-score)."""
        pts = [(c, *self.lp.fwd(c["lon"], c["lat"])) for c in cands
               if c["f"].get("veg_ring") is not None and c["kind"] not in ("deadend", "clearing")]
        if len(pts) < 5:
            return
        cell = 300.0
        grid: dict = {}
        for c, x, y in pts:
            grid.setdefault((int(x // cell), int(y // cell)), []).append((x, y, c["f"]["veg_ring"], c["f"].get("tree_on") or 0))
        for c, x, y in pts:
            gx, gy = int(x // cell), int(y // cell)
            vals, tvals = [], []
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for (x2, y2, v, t) in grid.get((gx + dx, gy + dy), ()):
                        if (x2 - x) ** 2 + (y2 - y) ** 2 <= cell * cell:
                            vals.append(v)
                            tvals.append(t)
            if len(vals) < 5:
                continue
            v = np.asarray(vals)
            med = float(np.median(v))
            mad = float(np.median(np.abs(v - med))) * 1.4826 + 0.05
            c["f"]["veg_rel"] = round((c["f"]["veg_ring"] - med) / mad, 2)
            c["f"]["veg_neigh_median"] = round(med, 3)
            c["f"]["n_neigh"] = len(vals)


def footprint_mask(c, z, size):
    cx, cy = lonlat_to_pixel(c["lon"], c["lat"], z)
    fpm = np.zeros((size, size), bool)
    fp = c.get("footprint")
    if fp is not None:
        m = Image.new("L", (size, size), 0)
        d = ImageDraw.Draw(m)
        for poly in (fp.geoms if fp.geom_type == "MultiPolygon" else [fp]):
            if poly.geom_type != "Polygon":
                continue
            pts = []
            for x, y in poly.exterior.coords:
                px, py = lonlat_to_pixel(x, y, z)
                pts.append((px - cx + size / 2, py - cy + size / 2))
            if len(pts) >= 3:
                d.polygon(pts, fill=255)
        fpm = np.asarray(m) > 0
    return fpm


def crop_features(provider, z, c, mpp, size=160, img=None, fetch=True) -> dict:
    """Pixel-level vegetation features around a candidate (footprint, yard ring)."""
    if img is None:
        img, valid = tiles.crop_lonlat(provider, z, c["lon"], c["lat"], size, fetch=fetch)
    else:
        valid = 1.0
    if valid < 0.5:
        return {"img_valid": round(valid, 2)}
    veg, tree, lum, snow = veg_tree_masks(img)
    if snow > 0.3:
        return {"img_valid": 0.0, "snow": round(snow, 2)}
    fpm = footprint_mask(c, z, size)
    if fpm.sum() < 6:
        yy, xx = np.mgrid[0:size, 0:size]
        rpx = max(3, 5.0 / mpp)
        fpm = (yy - size / 2) ** 2 + (xx - size / 2) ** 2 <= rpx ** 2
    inner = ndimage.binary_erosion(fpm, iterations=1) if fpm.sum() > 30 else fpm
    dist = ndimage.distance_transform_edt(~fpm) * mpp
    ring = (dist > 3) & (dist <= 40)
    near = (dist > 0) & (dist <= 12)
    return {
        "img_valid": round(valid, 2),
        "tree_on": round(float(tree[inner].mean()), 3) if inner.any() else None,
        "tree_ring": round(float(tree[ring].mean()), 3) if ring.any() else None,
        "veg_ring": round(float(veg[ring].mean()), 3) if ring.any() else None,
        "veg_yard": round(float(veg[near].mean()), 3) if near.any() else None,
        "roof_lum": round(float(lum[inner].mean()), 1) if inner.any() else None,
    }


# ------------------------------------------------------------------ standalone embedding A
def embed_points_A(points, provider, z, job=None) -> list:
    """Embedding A (same recipe as the dense scan) for arbitrary points; cached in the emb table."""
    from .models import get_dino
    dino = get_dino()
    keys = [f"A|{dino.name}|{dino.size}|{provider}|{z}|{lat:.6f},{lon:.6f}" for lat, lon in points]
    have = db.emb_get_many(keys)
    out = [have.get(k) for k in keys]
    todo: dict = {}
    for i, (lat, lon) in enumerate(points):
        if out[i] is None:
            px, py = lonlat_to_pixel(lon, lat, z)
            todo.setdefault((int(px // TILE), int(py // TILE)), []).append(i)
    if not todo:
        return out
    tl = list(todo)
    tiles.prefetch(provider, z, tl, checkpoint=job.checkpoint if job else None)
    G = dino.grid
    new = {}
    for s in range(0, len(tl), 16):
        if job:
            job.checkpoint()
            job.progress(s, len(tl), f"Эмбеддинги точек: {s}/{len(tl)} тайлов")
        chunk = tl[s:s + 16]
        imgs, keep = [], []
        for (tx, ty) in chunk:
            a = tiles.tile_array(provider, z, tx, ty)
            if a is not None:
                imgs.append(a)
                keep.append((tx, ty))
        if not imgs:
            continue
        toks, _ = dino.tokens(np.stack(imgs))
        for j, (tx, ty) in enumerate(keep):
            tk = toks[j]
            tile_mean = tk.reshape(G * G, -1).mean(axis=0)
            for i in todo[(tx, ty)]:
                lat, lon = points[i]
                px, py = lonlat_to_pixel(lon, lat, z)
                k = TILE / G
                r = int((py - ty * TILE) // k)
                c = int((px - tx * TILE) // k)
                rad = max(1, G // 16)
                local = tk[max(0, r - rad):r + rad + 1, max(0, c - rad):c + rad + 1].reshape(-1, tk.shape[-1]).mean(axis=0)
                e = np.concatenate([local, tile_mean]).astype(np.float32)
                out[i] = e
                new[keys[i]] = e
    db.emb_put_many(new)
    return out


def point_features(lat, lon, provider, z):
    """Classical image features for an arbitrary point (used for examples outside the scan)."""
    c = {"lat": lat, "lon": lon, "footprint": None, "kind": "building", "f": {}}
    return crop_features(provider, z, c, meters_per_pixel(lat, z))
