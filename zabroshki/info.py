"""Object descriptions and photos from open sources (on demand, cached).

Sources (free, no keys, open licences):
* OSM tags of the object (name, old/Finnish names, dates, description, heritage …)
* Wikidata (SPARQL around the point + the object's own wikidata tag): history facts, heritage status,
  state of conservation, image, Wikipedia links
* Wikipedia (ru / en / fi): summary + sentences about condition / abandonment / security from the article text
* Wikimedia Commons: geotagged photos near the object (with author and licence)
* Panoramax: open street-level photos near the object (CC-BY-SA), marked when the camera looks at the object
* the program's own evidence turned into a readable description
* search links (Yandex/Google/urban3p via search engine, Wikimapia, Yandex Maps) — opened by the user

Deliberately NOT collected: instructions for getting past fences, guards or cameras. Security-related notes from
sources are shown as they are (for safety and legality), with a link to the source.
"""
from __future__ import annotations

import json
import logging
import math
import re
import time
from urllib.parse import quote

from . import db, net, osm

log = logging.getLogger(__name__)
CACHE_DAYS = 30
VERSION = "v1"

KEYWORDS = {
    "condition": ["заброш", "разруш", "руин", "аварийн", "обвал", "обруш", "пожар", "сгорел", "не используется",
                  "пустует", "расселен", "законсерв", "снес", "демонтир", "бесхоз", "в запустении", "полуразруш",
                  "abandoned", "ruin", "derelict", "demolish", "collapsed", "burned", "disused"],
    "security": ["охраня", "охранник", "охрана объекта", "под охраной чоп", "сторож", "чоп ", "собак", "видеокамер",
                 "камеры наблюдения", "видеонаблюд", "огорожен", "забор", "закрыт для посещ", "закрыта для посещ",
                 "закрыто для посещ", "доступ закрыт", "вход закрыт", "частная территор", "частной территор",
                 "частная собственн", "частной собственн", "режимн", "пропускн", "вход свободн", "свободный доступ",
                 "доступ свободн", "открыт для посещ", "открыта для посещ", "вход запрещ", "проход запрещ",
                 "guarded", "security guard", "fenced", "private property", "closed to the public",
                 "open to the public"],
}
# heritage protection ("под охраной государства", "объект культурного наследия") is not physical security
NOT_SECURITY = ("наслед", "памятник", "охраной государства", "охранный статус", "heritage")

WD_PROPS = """
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?item wdt:P571 ?inception }
  OPTIONAL { ?item wdt:P576 ?dissolved }
  OPTIONAL { ?item wdt:P3999 ?closed }
  OPTIONAL { ?item wdt:P1435 ?heritage }
  OPTIONAL { ?item wdt:P5817 ?state }
  OPTIONAL { ?item wdt:P84 ?architect }
  OPTIONAL { ?item wdt:P31 ?instance }
  OPTIONAL { ?ru schema:about ?item ; schema:isPartOf <https://ru.wikipedia.org/> }
  OPTIONAL { ?en schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  OPTIONAL { ?fi schema:about ?item ; schema:isPartOf <https://fi.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,fi,en". }
"""


def _dist_m(lat1, lon1, lat2, lon2):
    return math.hypot((lat2 - lat1) * 110574, (lon2 - lon1) * 111320 * math.cos(math.radians(lat1)))


def _bearing(lat1, lon1, lat2, lon2):
    y = (lon2 - lon1) * math.cos(math.radians(lat1))
    x = lat2 - lat1
    return (math.degrees(math.atan2(y, x)) + 360) % 360


class SourceError(Exception):
    pass


def _get_json(url, params=None, timeout=15):
    r = net.get(url, params=params, timeout=timeout, retries=1, ok_statuses=(200, 404))
    if r.status_code != 200:
        return {}
    d = r.json()
    if isinstance(d, dict) and "error" in d and "query" not in d and "results" not in d and "features" not in d:
        raise SourceError(str(d.get("error"))[:120])  # e.g. Wikimedia rate limit wrapped in a 200 answer
    return d


def _date(s):
    """'2013-09-24 12:00' -> '2013-09-24'; free text like 'Taken on 7 …' -> year if present, else ''."""
    m = re.search(r"(1[89]\d\d|20\d\d)-\d\d-\d\d", s or "")
    if m:
        return m.group(0)
    m = re.search(r"\b(1[89]\d\d|20\d\d)\b", s or "")
    return m.group(1) if m else ""


def _file_key(url):
    """Same picture from different services (Special:FilePath, thumb URLs) -> one key."""
    from urllib.parse import unquote
    u = unquote(url or "").split("?")[0]
    name = u.rsplit("/", 1)[-1]
    name = re.sub(r"^\d+px-", "", name)
    return name.replace(" ", "_").lower()


def _clean(s, n=None):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if n is None or len(s) <= n else s[:n].rsplit(" ", 1)[0] + "…"


# ------------------------------------------------------------------ OSM
OSM_FIELDS = [("name", "Название"), ("old_name", "Прежнее название"), ("name:fi", "Название по-фински"),
              ("name:sv", "Название по-шведски"), ("was:name", "Прежнее название"), ("start_date", "Построено"),
              ("construction_date", "Построено"), ("building:levels", "Этажей"), ("architect", "Архитектор"),
              ("heritage", "Охранный статус (heritage)"), ("historic", "historic"), ("description", "Описание (OSM)"),
              ("note", "Примечание (OSM)"), ("operator", "Владелец/оператор"), ("access", "Доступ (OSM)"),
              ("website", "Сайт"), ("wikipedia", "Википедия"), ("wikidata", "Wikidata")]


def osm_facts(tags: dict) -> list:
    out = []
    for k, title in OSM_FIELDS:
        if tags.get(k):
            out.append({"k": title, "v": _clean(tags[k], 400)})
    lc = [f"{k}={v}" for k, v in tags.items() if osm.is_lifecycle({k: v})]
    if lc:
        out.append({"k": "Отметки заброшенности в OSM", "v": ", ".join(lc[:6])})
    return out


# ------------------------------------------------------------------ Wikidata
def wikidata_near(lat, lon, radius_km=0.25, qid=None, limit=6) -> list:
    if qid:
        where = f"VALUES ?item {{ wd:{qid} }} OPTIONAL {{ ?item wdt:P625 ?loc }}"
    else:
        where = (f'SERVICE wikibase:around {{ ?item wdt:P625 ?loc . '
                 f'bd:serviceParam wikibase:center "Point({lon} {lat})"^^geo:wktLiteral . '
                 f'bd:serviceParam wikibase:radius "{radius_km}" . }}')
    q = ("SELECT ?item ?itemLabel ?itemDescription ?loc ?image ?inception ?dissolved ?closed ?heritageLabel "
         "?stateLabel ?architectLabel ?instanceLabel ?ru ?en ?fi WHERE { " + where + WD_PROPS + f"}} LIMIT {limit * 4}")
    d = _get_json("https://query.wikidata.org/sparql", {"query": q, "format": "json"}, timeout=25)
    return parse_wikidata(d, lat, lon, limit)


def parse_wikidata(d, lat, lon, limit=6) -> list:
    items: dict = {}
    for b in d.get("results", {}).get("bindings", []):
        v = {k: x.get("value") for k, x in b.items()}
        qid = v["item"].rsplit("/", 1)[-1]
        it = items.setdefault(qid, {"qid": qid, "label": v.get("itemLabel"), "description": v.get("itemDescription"),
                                    "url": f"https://www.wikidata.org/wiki/{qid}", "facts": {}, "wiki": {}})
        m = re.match(r"Point\(([-\d.]+) ([-\d.]+)\)", v.get("loc") or "")
        if m:
            it["dist_m"] = round(_dist_m(lat, lon, float(m.group(2)), float(m.group(1))))
        for key, title in (("inception", "Основано/построено"), ("dissolved", "Прекратило существование"),
                           ("closed", "Закрыто"), ("heritageLabel", "Охранный статус"),
                           ("stateLabel", "Состояние"), ("architectLabel", "Архитектор"), ("instanceLabel", "Что это")):
            val = v.get(key)
            if val and not re.match(r"^Q\d+$", val):
                if key in ("inception", "dissolved", "closed"):
                    val = val[:4].lstrip("+") if val[:4].lstrip("+-").isdigit() else val[:10]
                cur = it["facts"].setdefault(title, [])
                if val not in cur:
                    cur.append(val)
        if v.get("image") and not it.get("image"):
            it["image"] = v["image"]
        for lang in ("ru", "en", "fi"):
            if v.get(lang):
                it["wiki"][lang] = v[lang]
    out = sorted(items.values(), key=lambda x: x.get("dist_m", 0))[:limit]
    for it in out:
        it["facts"] = {k: ", ".join(vs[:3]) for k, vs in it["facts"].items()}
        if it.get("image"):
            it["image"] = it["image"].replace("http://", "https://", 1)
            it["image_thumb"] = it["image"] + ("&" if "?" in it["image"] else "?") + "width=420"
    return out


# ------------------------------------------------------------------ Wikipedia
def wiki_title_from_url(url):
    m = re.match(r"https?://(\w+)\.wikipedia\.org/wiki/(.+)$", url or "")
    if not m:
        return None, None
    from urllib.parse import unquote
    return m.group(1), unquote(m.group(2)).replace("_", " ")


def wikipedia_summary(lang, title) -> dict | None:
    d = _get_json(f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{quote(title.replace(' ', '_'), safe='')}")
    if not d or d.get("type") == "https://mediawiki.org/wiki/HyperSwitch/errors/not_found":
        return None
    return {"lang": lang, "title": d.get("title") or title, "extract": _clean(d.get("extract"), 1200),
            "thumb": (d.get("thumbnail") or {}).get("source"),
            "url": ((d.get("content_urls") or {}).get("desktop") or {}).get("page")
            or f"https://{lang}.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"}


def wikipedia_text(lang, title, max_chars=40000) -> str:
    d = _get_json(f"https://{lang}.wikipedia.org/w/api.php",
                  {"action": "query", "prop": "extracts", "explaintext": 1, "titles": title, "format": "json",
                   "formatversion": 2, "redirects": 1})
    pages = (d.get("query") or {}).get("pages") or []
    return (pages[0].get("extract") or "")[:max_chars] if pages else ""


def wikipedia_geosearch(lang, lat, lon, radius=150, limit=5) -> list:
    d = _get_json(f"https://{lang}.wikipedia.org/w/api.php",
                  {"action": "query", "list": "geosearch", "gscoord": f"{lat}|{lon}", "gsradius": radius,
                   "gslimit": limit, "format": "json"})
    return [{"lang": lang, "title": g["title"], "dist_m": round(g.get("dist", 0))}
            for g in (d.get("query") or {}).get("geosearch", [])]


def notes_from_text(text: str, source: str, url: str, max_per_cat=4) -> list:
    """Sentences mentioning condition/abandonment or security/access."""
    out = []
    if not text:
        return out
    sents = re.split(r"(?<=[.!?…])\s+", re.sub(r"\s+", " ", text))
    counts = {"condition": 0, "security": 0}
    for s in sents:
        low = s.lower()
        for cat, kws in KEYWORDS.items():
            if counts[cat] >= max_per_cat:
                continue
            if cat == "security" and any(x in low for x in NOT_SECURITY):
                continue
            if any(k in low for k in kws) and 25 <= len(s) <= 600:
                out.append({"cat": cat, "text": _clean(s, 400), "source": source, "url": url})
                counts[cat] += 1
                break
    return out


# ------------------------------------------------------------------ photos
def commons_photos(lat, lon, radius=150, limit=8) -> list:
    d = _get_json("https://commons.wikimedia.org/w/api.php",
                  {"action": "query", "generator": "geosearch", "ggsnamespace": 6, "ggscoord": f"{lat}|{lon}",
                   "ggsradius": radius, "ggslimit": limit, "prop": "imageinfo|coordinates",
                   "iiprop": "url|extmetadata", "iiurlwidth": 420, "format": "json", "formatversion": 2})
    return parse_commons(d, lat, lon)


def parse_commons(d, lat, lon) -> list:
    out = []
    for p in (d.get("query") or {}).get("pages", []):
        ii = (p.get("imageinfo") or [{}])[0]
        md = ii.get("extmetadata") or {}

        def m(k):
            return re.sub(r"<[^>]+>", "", (md.get(k) or {}).get("value", "") or "").strip()
        co = (p.get("coordinates") or [{}])[0]
        dist = round(_dist_m(lat, lon, co["lat"], co["lon"])) if co.get("lat") is not None else None
        out.append({"source": "Wikimedia Commons", "thumb": ii.get("thumburl"), "url": ii.get("descriptionurl"),
                    "full": ii.get("url"), "author": _clean(m("Artist"), 80), "license": m("LicenseShortName"),
                    "date": _date(m("DateTimeOriginal")), "title": _clean(p.get("title", "").replace("File:", ""), 90),
                    "dist_m": dist})
    out.sort(key=lambda x: x["dist_m"] if x["dist_m"] is not None else 9999)
    return out


def panoramax_photos(lat, lon, radius=70, limit=6) -> list:
    dlat = radius / 110574
    dlon = radius / (111320 * math.cos(math.radians(lat)))
    d = _get_json("https://api.panoramax.xyz/api/search",
                  {"bbox": f"{lon - dlon},{lat - dlat},{lon + dlon},{lat + dlat}", "limit": 40})
    return parse_panoramax(d, lat, lon, limit)


def parse_panoramax(d, lat, lon, limit=6) -> list:
    out = []
    for f in d.get("features", []):
        try:
            plon, plat = f["geometry"]["coordinates"][:2]
        except Exception:
            continue
        pr = f.get("properties") or {}
        a = f.get("assets") or {}
        dist = _dist_m(lat, lon, plat, plon)
        az = pr.get("view:azimuth")
        looks = None
        try:
            if az is not None and dist > 3:
                diff = abs((float(az) - _bearing(plat, plon, lat, lon) + 180) % 360 - 180)
                looks = diff <= 50
        except (TypeError, ValueError):
            pass
        out.append({"source": "Panoramax", "thumb": (a.get("sd") or a.get("thumb") or {}).get("href"),
                    "full": (a.get("hd") or {}).get("href"),
                    "url": f"https://api.panoramax.xyz/#focus=pic&pic={f.get('id')}",
                    "author": pr.get("geovisio:producer"), "license": pr.get("license"),
                    "date": str(pr.get("datetime") or "")[:10], "dist_m": round(dist), "looks_at": looks})
    out.sort(key=lambda x: (x["looks_at"] is False, x["dist_m"]))
    return out[:limit]


# ------------------------------------------------------------------ own description
def auto_description(r: dict, f: dict, tags: dict) -> list:
    """Plain-language summary of what the program itself knows about the object."""
    TYPE = {"house": "дом/дача", "industrial": "промышленное здание", "farm": "сельхоз-постройка", "ruins": "руины",
            "military": "военный объект", "building": "постройка", "unmapped": "постройка, которой нет на картах",
            "clearing": "прогалина в лесу", "deadend": "конец тупиковой дороги", "area": "территория",
            "complex": "территория из нескольких зданий"}
    out = []
    s = TYPE.get(r["kind"], r["kind"])
    if f.get("area_m2"):
        s += f", площадь ~{f['area_m2']:.0f} м²"
    if tags.get("building:levels"):
        s += f", этажей: {tags['building:levels']}"
    out.append(s[0].upper() + s[1:] + ".")
    where = []
    if f.get("in_settlement"):
        where.append("в населённом пункте" + (f" ({f['near_place_name']})" if f.get("near_place_name") else ""))
    elif f.get("in_dacha"):
        where.append("в садоводстве")
    elif f.get("outside_settlement"):
        where.append("вне населённых пунктов")
    if f.get("in_military"):
        where.append("на " + ("бывшей " if f.get("military_disused") else "") + "военной территории")
    if f.get("forest_100m") is not None:
        where.append(f"лес вокруг ~{f['forest_100m'] * 100:.0f}%")
    if f.get("road_dist") is not None and f["road_dist"] < 999:
        where.append(f"ближайшая дорога ~{f['road_dist']:.0f} м ({f.get('road_class') or '?'})")
    if where:
        out.append("Расположение: " + ", ".join(where) + ".")
    look = []
    if f.get("bprob") is not None:
        look.append("крыша хорошо читается на снимке" if f["bprob"] >= 0.6 else
                    "крыша плохо читается (разрушена или скрыта деревьями)")
    if f.get("tree_on") is not None and f["tree_on"] >= 0.3:
        look.append(f"растительность поверх контура ~{f['tree_on'] * 100:.0f}%")
    if f.get("veg_rel") is not None and f["veg_rel"] >= 1:
        look.append("участок заметно заросший по сравнению с соседями")
    if look:
        out.append("На снимке: " + ", ".join(look) + ".")
    if f.get("wb_from") and f.get("wb_to"):
        h = []
        if (f.get("wb_bprob_drop") or 0) >= 0.3:
            h.append("крыша была видна, а теперь читается хуже")
        if (f.get("wb_veg_delta") or 0) >= 0.08:
            h.append("участок зарос")
        if (f.get("wb_veg_delta") or 0) <= -0.12:
            h.append("участок расчищен")
        out.append(f"Снимки {f['wb_from']} → {f['wb_to']}: " + (", ".join(h) if h else "заметных изменений нет") + ".")
    vlm = f.get("vlm") if isinstance(f.get("vlm"), dict) else {}
    if vlm.get("explanation"):
        out.append("VLM о снимке: " + _clean(vlm["explanation"], 300))
    return out


# ------------------------------------------------------------------ main
def get_info(cid: int, refresh=False) -> dict | None:
    r = db.app_con().execute("SELECT * FROM candidates WHERE id=?", (cid,)).fetchone()
    if r is None:
        return None
    r = dict(r)
    lat, lon = r["lat"], r["lon"]
    tags = db.loads(r["tags"], {})
    f = db.loads(r["features"], {})
    res = {"auto": auto_description(r, f, tags), "osm": osm_facts(tags)}
    key = f"info:{VERSION}:{lat:.5f},{lon:.5f}"
    raw = None
    if not refresh:  # complete answers are kept for a month, partial ones (a source failed) for a day
        raw = db.http_cache_get(key, CACHE_DAYS * 86400) or db.http_cache_get(key + ":partial", 86400)
    if raw is not None:
        res.update(json.loads(raw))
    else:
        ext = fetch_external(lat, lon, tags, r.get("title") or "", f)
        ext["fetched"] = time.strftime("%Y-%m-%d")
        db.http_cache_put(key + (":partial" if ext["errors"] else ""), json.dumps(ext, ensure_ascii=False).encode())
        res.update(ext)
    res["links"] = links(lat, lon, tags, r["kind"], f.get("near_place_name"))
    return res


def fetch_external(lat, lon, tags, title, f) -> dict:
    out = {"wikidata": [], "wikipedia": [], "photos": [], "notes": [], "errors": []}
    area = f.get("area_m2") or 0
    radius_km = 0.12 if area < 2000 else 0.3

    def attempt(name, fn):
        try:
            return fn()
        except Exception as e:  # each source is optional
            out["errors"].append(f"{name}: {type(e).__name__}")
            log.info("info %s failed: %s", name, e)
            return None
    qid = tags.get("wikidata") if re.match(r"^Q\d+$", tags.get("wikidata") or "") else None
    wd = []
    if qid:
        wd += attempt("Wikidata", lambda: wikidata_near(lat, lon, qid=qid, limit=1)) or []
    near = attempt("Wikidata", lambda: wikidata_near(lat, lon, radius_km=radius_km)) or []
    seen = {w["qid"] for w in wd}
    wd += [w for w in near if w["qid"] not in seen]
    out["wikidata"] = wd[:5]
    # Wikipedia articles: the object's own tag, then Wikidata sitelinks, then geosearch
    arts = []
    if tags.get("wikipedia") and ":" in tags["wikipedia"]:
        lang, t = tags["wikipedia"].split(":", 1)
        arts.append((lang, t, 0))
    for w in wd[:3]:
        for lang in ("ru", "en", "fi"):
            if w["wiki"].get(lang):
                lg, t = wiki_title_from_url(w["wiki"][lang])
                if t:
                    arts.append((lg, t, w.get("dist_m", 0)))
                break
    if not arts:
        for lang in ("ru", "fi"):
            gs = attempt(f"Wikipedia {lang}", lambda lang=lang: wikipedia_geosearch(lang, lat, lon, 150)) or []
            arts += [(g["lang"], g["title"], g["dist_m"]) for g in gs[:2]]
            if arts:
                break
    seen_t = set()
    for lang, t, dist in arts[:3]:
        if (lang, t) in seen_t:
            continue
        seen_t.add((lang, t))
        sm = attempt(f"Wikipedia {lang}", lambda lang=lang, t=t: wikipedia_summary(lang, t))
        if sm:
            sm["dist_m"] = dist
            out["wikipedia"].append(sm)
            text = attempt(f"Wikipedia {lang}", lambda lang=lang, t=t: wikipedia_text(lang, t)) or ""
            out["notes"] += notes_from_text(text, f"Википедия ({lang}): {sm['title']}", sm["url"])
    for w in wd:
        if w.get("description"):
            out["notes"] += notes_from_text(w["description"], f"Wikidata: {w.get('label')}", w["url"])
        st = w["facts"].get("Состояние")
        if st:
            out["notes"].append({"cat": "condition", "text": f"Состояние по Wikidata: {st}",
                                 "source": f"Wikidata: {w.get('label')}", "url": w["url"]})
    for k in ("description", "note", "access", "abandoned:note"):
        if tags.get(k):
            out["notes"] += notes_from_text(str(tags[k]) + ".", f"OSM: {k}", "")
    # photos
    photos = []
    for w in wd[:3]:
        if w.get("image_thumb"):
            photos.append({"source": "Wikidata/Commons", "thumb": w["image_thumb"], "url": w["image"],
                           "full": w["image"], "title": w.get("label"), "author": "", "license": "см. страницу файла",
                           "dist_m": w.get("dist_m")})
    for sm in out["wikipedia"]:
        if sm.get("thumb") and all(sm["thumb"] != p["thumb"] for p in photos):
            photos.append({"source": "Википедия", "thumb": sm["thumb"], "url": sm["url"], "full": sm["thumb"],
                           "title": sm["title"], "author": "", "license": "см. статью", "dist_m": sm.get("dist_m")})
    photos += attempt("Commons", lambda: commons_photos(lat, lon, 150 if area < 2000 else 300)) or []
    photos += attempt("Panoramax", lambda: panoramax_photos(lat, lon, 70 if area < 2000 else 140)) or []
    uniq, seen_f = [], set()
    for p in photos:
        k = _file_key(p.get("full") or p.get("thumb"))
        if k and k in seen_f:
            continue
        seen_f.add(k)
        uniq.append(p)
    out["photos"] = uniq[:16]
    return out


def links(lat, lon, tags, kind, place=None) -> list:
    name = tags.get("name") or tags.get("old_name") or tags.get("name:fi") or ""
    what = {"military": "военная часть", "farm": "ферма", "industrial": "завод", "ruins": "руины",
            "house": "дом", "clearing": "урочище"}.get(kind, "")
    in_vyborg = 60.4 < lat < 61.0 and 28.2 < lon < 29.4
    where = place or ("Выборгский район" if in_vyborg else "")
    q = " ".join(x for x in (name or what, where, "заброшенный") if x)
    return [
        {"title": "Wikimapia (описания мест)", "url": f"https://wikimapia.org/#lang=ru&lat={lat:.6f}&lon={lon:.6f}&z=18&m=w"},
        {"title": "Яндекс Карты (спутник, панорамы)", "url": f"https://yandex.ru/maps/?ll={lon:.6f}%2C{lat:.6f}&z=18&l=sat"},
        {"title": "Поиск: Яндекс", "url": "https://yandex.ru/search/?text=" + quote(q)},
        {"title": "Поиск: Google", "url": "https://www.google.com/search?q=" + quote(q)},
        {"title": "Поиск на urban3p.ru (через Яндекс)",
         "url": "https://yandex.ru/search/?text=" + quote(" ".join(x for x in ("site:urban3p.ru", name, where) if x))},
    ]
