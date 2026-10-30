"""
Prepare the offline map package for OfflineAid (run ONCE while online).

Downloads real OpenStreetMap data for a bounding box from the Overpass API and writes:
  data/maps/osm_raw.json     - raw Overpass response (provenance)
  data/maps/pois.json        - emergency-relevant places (hospitals, police, fire, shelters...)
  data/maps/roadgraph.json   - routable road/path graph (nodes + edges with metre costs)
  data/maps/region.json      - region metadata (bbox, centre, attribution, build date)

The basemap tiles (data/maps/region.pmtiles) are extracted separately with the
pmtiles CLI - see README "Map package preparation".

Usage:
  python scripts/prepare_map.py --bbox 77.19,28.60,77.245,28.645 --name "Central New Delhi"
(bbox order: west,south,east,north)
"""
import argparse
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "maps"
OVERPASS = "https://overpass-api.de/api/interpreter"

ROUTABLE = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
    "living_street", "service", "road", "pedestrian", "footway", "path", "track", "steps",
}

CATEGORY_RULES = [
    ("hospital", lambda t: t.get("amenity") == "hospital" or t.get("healthcare") == "hospital"),
    ("clinic", lambda t: t.get("amenity") in ("clinic", "doctors") or t.get("healthcare") in ("clinic", "doctor")),
    ("pharmacy", lambda t: t.get("amenity") == "pharmacy"),
    ("police", lambda t: t.get("amenity") == "police"),
    ("fire_station", lambda t: t.get("amenity") == "fire_station"),
    # Only real emergency shelters/assembly points. amenity=shelter is excluded when it is a bus stop,
    # gazebo or sun shade (those are not disaster shelters).
    ("shelter", lambda t: t.get("emergency") == "assembly_point" or t.get("social_facility") == "shelter"
        or (t.get("amenity") == "shelter" and t.get("shelter_type") in ("basic_hut", "lean_to", "emergency"))),
    ("emergency_service", lambda t: t.get("emergency") in ("ambulance_station", "phone")
        or t.get("amenity") == "ambulance_station"),
]


def haversine(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def overpass(query):
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(OVERPASS, data=data, headers={"User-Agent": "OfflineAid-hackathon/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # network hiccups / rate limits
            print(f"Overpass attempt {attempt + 1} failed: {exc}")
            time.sleep(10)
    raise SystemExit("Overpass API unavailable. Try again later.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", default="77.19,28.60,77.245,28.645", help="west,south,east,north")
    ap.add_argument("--name", default="Central New Delhi")
    ap.add_argument("--from-raw", action="store_true", help="rebuild from data/maps/osm_raw.json without downloading")
    args = ap.parse_args()
    w, s, e, n = [float(x) for x in args.bbox.split(",")]
    bb = f"{s},{w},{n},{e}"
    OUT.mkdir(parents=True, exist_ok=True)

    query = f"""
[out:json][timeout:170];
(
  way["highway"]({bb});
  nwr["amenity"~"^(hospital|clinic|doctors|pharmacy|police|fire_station|shelter|ambulance_station)$"]({bb});
  nwr["healthcare"~"^(hospital|clinic|doctor)$"]({bb});
  nwr["emergency"~"^(assembly_point|ambulance_station)$"]({bb});
  nwr["social_facility"="shelter"]({bb});
);
out body center;
>;
out skel qt;
"""
    if args.from_raw:
        raw = json.loads((OUT / "osm_raw.json").read_text(encoding="utf-8"))
    else:
        print("Downloading OpenStreetMap data from Overpass...")
        raw = overpass(query)
        (OUT / "osm_raw.json").write_text(json.dumps(raw), encoding="utf-8")

    nodes = {}
    ways = []
    pois = []
    for el in raw["elements"]:
        if el["type"] == "node" and "lat" in el:
            nodes[el["id"]] = (el["lat"], el["lon"])
    for el in raw["elements"]:
        tags = el.get("tags") or {}
        if el["type"] == "way" and tags.get("highway") in ROUTABLE and tags.get("access") not in ("private", "no"):
            ways.append(el)
        category = next((c for c, rule in CATEGORY_RULES if rule(tags)), None)
        if not category:
            continue
        if el["type"] == "node":
            lat, lon = el["lat"], el["lon"]
        elif "center" in el:
            lat, lon = el["center"]["lat"], el["center"]["lon"]
        else:
            continue
        default = "Emergency assembly point" if tags.get("emergency") == "assembly_point" else f"Unnamed {category.replace('_', ' ')}"
        name = tags.get("name") or tags.get("name:en") or default
        pois.append({
            "id": f"osm-{el['type']}-{el['id']}", "name": name, "category": category,
            "lat": lat, "lon": lon,
            "address": ", ".join(v for v in (tags.get("addr:housenumber"), tags.get("addr:street"),
                                             tags.get("addr:suburb"), tags.get("addr:city")) if v),
            "phone": tags.get("phone") or tags.get("contact:phone") or "",
            "source": "OpenStreetMap",
        })

    # Build graph: keep every way node (small region), edges between consecutive nodes.
    used = {}
    node_list = []
    edges = []

    def idx(osm_id):
        if osm_id not in used:
            used[osm_id] = len(node_list)
            lat, lon = nodes[osm_id]
            node_list.append([round(lat, 7), round(lon, 7)])
        return used[osm_id]

    for way in ways:
        tags = way["tags"]
        oneway = tags.get("oneway") in ("yes", "1", "true") and tags["highway"] not in ("footway", "path", "pedestrian", "steps")
        refs = [r for r in way.get("nodes", []) if r in nodes]
        for a, b in zip(refs, refs[1:]):
            ia, ib = idx(a), idx(b)
            dist = haversine(*nodes[a], *nodes[b])
            edges.append([ia, ib, round(dist, 1), 1 if oneway else 0, way["id"], tags.get("name", ""), tags["highway"]])

    graph = {"nodes": node_list, "edges": edges,
             "edgeFormat": ["from", "to", "metres", "oneway", "osmWayId", "name", "highway"]}
    (OUT / "roadgraph.json").write_text(json.dumps(graph, separators=(",", ":")), encoding="utf-8")
    (OUT / "pois.json").write_text(json.dumps(pois, indent=1), encoding="utf-8")
    region = {
        "name": args.name, "bbox": [w, s, e, n], "center": [(s + n) / 2, (w + e) / 2],
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "attribution": "© OpenStreetMap contributors (ODbL). Basemap © Protomaps.",
        "counts": {"pois": len(pois), "graphNodes": len(node_list), "graphEdges": len(edges)},
    }
    (OUT / "region.json").write_text(json.dumps(region, indent=2), encoding="utf-8")
    print(json.dumps(region, indent=2))
    by_cat = {}
    for p in pois:
        by_cat[p["category"]] = by_cat.get(p["category"], 0) + 1
    print("POIs by category:", by_cat)


if __name__ == "__main__":
    main()
