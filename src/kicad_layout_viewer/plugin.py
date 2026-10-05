"""KiCad PCB Editor action plugin for exporting an offline layout viewer."""

from __future__ import annotations

import html
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import pcbnew
import wx


ASSET_DIR = Path(__file__).with_name("assets")
SVG_NS = "http://www.w3.org/2000/svg"
DRILL_HOLE_COLOR = "#d9dce0"
ET.register_namespace("", SVG_NS)
TOP_LEVEL_ZONE_RE = re.compile(r"\(\s*zone(?:\s|\))")


def _call(obj, names, default=None):
    """Try a few KiCad API spellings, returning a default for missing methods."""
    for name in names:
        method = getattr(obj, name, None)
        if method is not None:
            try:
                return method() if callable(method) else method
            except Exception:
                continue
    return default


def _as_text(value):
    return str(value) if value is not None else ""


def _layer_definitions(board_path):
    text = Path(board_path).read_text(encoding="utf-8", errors="replace")
    match = re.search(r"\(layers\s", text)
    if not match:
        raise RuntimeError("Could not find the board layer definitions.")
    start = match.start()
    depth = 0
    quoted = False
    escaped = False
    end = None
    for index in range(start, len(text)):
        char = text[index]
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            continue
        if char == '"':
            quoted = True
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                end = index + 1
                break
    if end is None:
        raise RuntimeError("The board layer definition block is incomplete.")
    block = text[start:end]
    definitions = []
    for item in re.finditer(r'\(\s*(\d+)\s+"((?:\\.|[^"\\])*)"\s+([^()\s]+)', block):
        number = int(item.group(1))
        name = bytes(item.group(2), "utf-8").decode("unicode_escape")
        definitions.append((number, name, item.group(3)))
    if not definitions:
        raise RuntimeError("No board layers were found in the layer definition block.")
    return sorted(definitions)


def _find_cli():
    executable = "kicad-cli.exe" if os.name == "nt" else "kicad-cli"
    located = shutil.which(executable) or shutil.which("kicad-cli")
    candidates = [Path(located)] if located else []
    candidates.extend([Path(sys.executable).parent / executable])
    candidates.extend([Path(sys.prefix) / "bin" / executable, Path(sys.prefix).parent / "bin" / executable])
    pcbnew_path = getattr(pcbnew, "__file__", None)
    if pcbnew_path:
        for parent in Path(pcbnew_path).resolve().parents:
            candidates.append(parent / "bin" / executable)
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    raise RuntimeError("Could not find kicad-cli. Add KiCad's bin folder to PATH and try again.")


def _export_svgs(cli, board_path, layers, output_dir):
    base = [cli, "pcb", "export", "svg", "--mode-multi", "--layers", ",".join(layers), "--output", output_dir]
    options = ["--fit-page-to-board", "--exclude-drawing-sheet"]
    command = base + options + [board_path]
    result = subprocess.run(command, capture_output=True, text=True, errors="replace")
    if result.returncode and "exclude-drawing-sheet" in (result.stderr + result.stdout):
        command = base + ["--fit-page-to-board", board_path]
        result = subprocess.run(command, capture_output=True, text=True, errors="replace")
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError("KiCad SVG export failed." + ("\n" + detail if detail else ""))
    files = list(Path(output_dir).glob("*.svg"))
    if not files:
        raise RuntimeError("KiCad completed SVG export but did not create any SVG files.")
    return files


def _sexpr_end(text, start):
    """Return the end offset of the S-expression beginning at start."""
    depth = 0
    quoted = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            continue
        if char == '"':
            quoted = True
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index + 1
    raise RuntimeError("Could not find the end of a zone in the PCB file.")


def _top_level_zone_spans(text):
    index = 0
    depth = 0
    quoted = False
    escaped = False
    while index < len(text):
        char = text[index]
        if not quoted and depth == 1 and char == "(":
            if TOP_LEVEL_ZONE_RE.match(text, index):
                end = _sexpr_end(text, index)
                yield index, end
                index = end
                continue
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        index += 1


def _zone_fills_from_board(board, layer_definitions):
    """Read KiCad's filled copper geometry, including clearance holes."""
    records = []
    net_names = {
        int(code): _as_text(_call(net, ("GetNetname", "GetNetName"), ""))
        for code, net in board.GetNetsByNetcode().items()
    }
    copper_layers = [(number, name) for number, name, _ in layer_definitions
                     if name.endswith(".Cu")]

    def chain_points(chain):
        return [_point(chain.CPoint(index)) for index in range(chain.PointCount())]

    for zone in board.Zones():
        net_code = int(_call(zone, ("GetNetCode",), 0) or 0)
        for layer_id, layer_name in copper_layers:
            has_fill = getattr(zone, "HasFilledPolysForLayer", None)
            if has_fill is not None:
                try:
                    if not has_fill(layer_id):
                        continue
                except Exception:
                    pass
            try:
                polyset = zone.GetFilledPolysList(layer_id)
            except Exception:
                continue
            if polyset is None:
                continue
            for outline_index in range(polyset.OutlineCount()):
                outer = chain_points(polyset.COutline(outline_index))
                if len(outer) < 3:
                    continue
                rings = [outer]
                for hole_index in range(polyset.HoleCount(outline_index)):
                    hole = chain_points(polyset.CHole(outline_index, hole_index))
                    if len(hole) >= 3:
                        rings.append(hole)
                records.append({"net": net_names.get(net_code, ""),
                                "layer": layer_name, "rings": rings})
    return records


def _write_zone_free_render_board(source_path, output_path, text=None):
    """Copy the PCB file without top-level zone items for base SVG artwork.

    Zone fills are exported separately from the loaded board so the viewer
    can control their opacity and route clicks to its net hit geometry.
    """
    if text is None:
        text = Path(source_path).read_text(encoding="utf-8", errors="replace")
    result = []
    cursor = 0
    for start, end in _top_level_zone_spans(text):
        result.append(text[cursor:start])
        cursor = end
    result.append(text[cursor:])
    Path(output_path).write_text("".join(result), encoding="utf-8")


def _normalize_layer(value):
    normalized = re.sub(r"[^a-z0-9]", "", value.lower())
    # KiCad's SVG exporter expands several abbreviated board layer names in
    # filenames: SilkS -> Silkscreen, Adhes -> Adhesive, CrtYd -> Courtyard,
    # Dwgs.User -> User_Drawings, Cmts.User -> User_Comments, and Eco[1-2].User
    # -> User_Eco[1-2]. Canonicalize both spellings for every standard layer.
    return (normalized
            .replace("silkscreen", "silks")
            .replace("adhesive", "adhes")
            .replace("courtyard", "crtyd")
            .replace("userdrawings", "dwgsuser")
            .replace("user9", "dwgsuser")
            .replace("usercomments", "cmtsuser")
            .replace("usereco1", "eco1user")
            .replace("usereco2", "eco2user"))


def _svg_file_layers(svg_files, board_stem, layer_names):
    by_normalized = {_normalize_layer(name): name for name in layer_names}
    results = {}
    prefix = _normalize_layer(board_stem)
    for path in svg_files:
        normalized_stem = _normalize_layer(path.stem)
        normalized = normalized_stem[len(prefix):] if normalized_stem.startswith(prefix) else normalized_stem
        candidates = [name for key, name in by_normalized.items() if key == normalized or normalized.endswith(key)]
        if len(candidates) == 1:
            results[candidates[0]] = path

    optional_layers = {"User.Drawings", "Dwgs.User", "User.9"}   # keep the historic name as well
    missing = [name for name in layer_names
               if name not in results and name not in optional_layers]
    if missing:
        files = ", ".join(path.name for path in svg_files)
        raise RuntimeError(
            "Could not match KiCad's SVG output to these layers: "
            + ", ".join(missing)
            + ". Exported files: " + files
        )
    return results


def _svg_root(path, layer_name, nonplated_pad_centers=()):
    root = ET.parse(str(path)).getroot()
    root.set("class", "layer-svg")
    root.set("data-layer", layer_name)
    root.set("width", "100%")
    root.set("height", "100%")
    root.set("preserveAspectRatio", "xMidYMid meet")
    layer_color = _color_for_layer(layer_name)
    # KiCad emits unstyled circles for round pads and vias. Give these the
    # layer color as a fill without an outline, which would enlarge the copper
    # diameter; drill openings are masked separately after SVG assembly.
    pad_circles = []
    for circle in root.iter("{%s}circle" % SVG_NS):
        if "style" not in circle.attrib and "fill" not in circle.attrib and "stroke" not in circle.attrib:
            pad_circles.append(circle)
            circle.set("fill", layer_color)
            circle.set("stroke", "none")
    for element in root.iter():
        for attribute in ("fill", "stroke"):
            value = element.get(attribute)
            if value and value.strip().lower() not in ("none", "transparent") and not value.strip().lower().startswith("url("):
                element.set(attribute, layer_color)
        style = element.get("style")
        if style:
            declarations = []
            for declaration in style.split(";"):
                property_name, separator, value = declaration.partition(":")
                if (separator and property_name.strip().lower() in ("fill", "stroke")
                        and value.strip().lower() not in ("none", "transparent")
                        and not value.strip().lower().startswith("url(")):
                    declaration = property_name + separator + layer_color
                declarations.append(declaration)
            element.set("style", ";".join(declarations))
    # Non-plated pads have no copper annulus. Suppress their exported pad
    # outline; the separate drill-hole group paints the actual drill size.
    for circle in pad_circles:
        try:
            center = (float(circle.get("cx")), float(circle.get("cy")))
        except (TypeError, ValueError):
            continue
        if any(abs(center[0] - x) < 0.01 and abs(center[1] - y) < 0.01
               for x, y in nonplated_pad_centers):
            circle.set("fill", "none")
            circle.set("stroke", "none")
            circle.set("class", (circle.get("class", "") + " nonplated-pad-mask").strip())
    return root


def _drill_hole_group(board, view_box, edge_bounds, svg_offset=(0, 0)):
    vx, vy, _, _ = view_box
    min_x, min_y, _, _ = edge_bounds
    offset_x, offset_y = svg_offset

    def map_point(point):
        x, y = _point(point)
        return vx + x - min_x + offset_x, vy + y - min_y + offset_y

    group = ET.Element("{%s}g" % SVG_NS, {
        "class": "drill-hole-mask",
        "fill": DRILL_HOLE_COLOR,
        "stroke": "none",
        "pointer-events": "none",
    })
    for footprint in board.GetFootprints():
        for pad in footprint.Pads():
            drill = _call(pad, ("GetDrillSize",), None)
            if drill is None:
                continue
            width, height = _mm(drill.x), _mm(drill.y)
            if width <= 0 or height <= 0:
                continue
            x, y = map_point(pad.GetPosition())
            attrs = {
                "cx": _xml_number(x), "cy": _xml_number(y),
                "rx": _xml_number(width / 2), "ry": _xml_number(height / 2),
            }
            angle = float(_call(pad, ("GetOrientationDegrees",), 0) or 0)
            if abs(width - height) > 0.001 and angle:
                attrs["transform"] = "rotate(%s %s %s)" % (_xml_number(-angle), _xml_number(x), _xml_number(y))
            ET.SubElement(group, "{%s}ellipse" % SVG_NS, attrs)

    for item in board.GetTracks():
        if "VIA" not in item.__class__.__name__.upper() and not (
                (hasattr(item, "GetTopLayer") and hasattr(item, "GetBottomLayer"))
                or (hasattr(item, "TopLayer") and hasattr(item, "BottomLayer"))):
            continue
        drill = _call(item, ("GetDrill",), 0)
        diameter = _mm(drill) if drill else 0
        if diameter <= 0:
            continue
        x, y = map_point(item.GetPosition())
        ET.SubElement(group, "{%s}circle" % SVG_NS, {
            "cx": _xml_number(x), "cy": _xml_number(y), "r": _xml_number(diameter / 2),
        })
    return group if len(group) else None


def _nonplated_pad_centers(board, view_box, edge_bounds, svg_offset=(0, 0)):
    vx, vy, _, _ = view_box
    min_x, min_y, _, _ = edge_bounds
    offset_x, offset_y = svg_offset
    npth_attribute = getattr(pcbnew, "PAD_ATTRIB_NPTH", None)
    if npth_attribute is None:
        return []
    centers = []
    for footprint in board.GetFootprints():
        for pad in footprint.Pads():
            if _call(pad, ("GetAttribute",), None) != npth_attribute:
                continue
            x, y = _point(pad.GetPosition())
            centers.append((vx + x - min_x + offset_x, vy + y - min_y + offset_y))
    return centers


def _svg_coordinate_offset(svg_root, board, edge_bounds):
    view_box = [float(number) for number in re.split(r"[ ,]+", svg_root.get("viewBox", "").strip()) if number]
    if len(view_box) != 4:
        return 0.0, 0.0
    vx, vy, _, _ = view_box
    min_x, min_y, _, _ = edge_bounds
    circle_centers = []
    for circle in svg_root.iter("{%s}circle" % SVG_NS):
        try:
            circle_centers.append((float(circle.get("cx")), float(circle.get("cy"))))
        except (TypeError, ValueError):
            continue
    if not circle_centers:
        return 0.0, 0.0

    candidates = []
    circle_shape = getattr(pcbnew, "PAD_SHAPE_CIRCLE", None)
    for footprint in board.GetFootprints():
        for pad in footprint.Pads():
            if _call(pad, ("GetShape",), None) != circle_shape:
                continue
            x, y = _point(pad.GetPosition())
            candidates.append((x, y))
    for item in board.GetTracks():
        if "VIA" in item.__class__.__name__.upper() or (
                (hasattr(item, "GetTopLayer") and hasattr(item, "GetBottomLayer"))
                or (hasattr(item, "TopLayer") and hasattr(item, "BottomLayer"))):
            candidates.append(_point(item.GetPosition()))

    deltas_x, deltas_y = [], []
    for x, y in candidates:
        expected = (vx + x - min_x, vy + y - min_y)
        nearest = min(circle_centers, key=lambda center: math.hypot(center[0] - expected[0], center[1] - expected[1]))
        dx, dy = nearest[0] - expected[0], nearest[1] - expected[1]
        if math.hypot(dx, dy) <= 0.15:
            deltas_x.append(dx)
            deltas_y.append(dy)
    if not deltas_x:
        return 0.0, 0.0
    deltas_x.sort()
    deltas_y.sort()
    middle = len(deltas_x) // 2
    return deltas_x[middle], deltas_y[middle]


def _color_for_layer(name):
    if name.endswith(".Cu"):
        # Keep layer swatches in a muted mineral palette so they stay distinct
        # from the brighter net-highlight colors used throughout the viewer.
        colors = {"F.Cu": "#b47754", "B.Cu": "#6586a6", "In1.Cu": "#668276", "In2.Cu": "#897395"}
        return colors.get(name, "#a68a60")
    if "SilkS" in name:
        return "#d5d0b6"
    if "Mask" in name:
        return "#526b5d"
    if "Paste" in name:
        return "#8e829b"
    if name == "Edge.Cuts":
        return "#c2b886"
    if "Fab" in name:
        return "#8793a3"
    if "CrtYd" in name:
        return "#a66f73"
    return "#718096"


def _initial_visibility(name):
    return name in ("F.Cu", "F.SilkS", "Edge.Cuts")


def _point(point):
    return _mm(point.x), _mm(point.y)


def _mm(iu):
    return float(pcbnew.ToMM(iu))


def _xml_number(value):
    return ("%.5f" % value).rstrip("0").rstrip(".") or "0"


def _part_viewer_data(board, copper, map_point):
    parts = []
    hit_boxes = []
    for index, footprint in enumerate(board.GetFootprints()):
        reference = _as_text(_call(footprint, ("GetReference",), ""))
        value = _as_text(_call(footprint, ("GetValue",), ""))

        try:
            # Exclude reference/value fields so their labels do not enlarge the
            # clickable body area for a footprint.
            bounds = footprint.GetBoundingBox(False)
        except (AttributeError, TypeError):
            # Keep compatibility with pcbnew builds that only expose the
            # no-argument overload.
            bounds = _call(footprint, ("GetBoundingBox",), None)
        if bounds is not None:
            left = _mm(_call(bounds, ("GetLeft",), 0))
            top = _mm(_call(bounds, ("GetTop",), 0))
            right = _mm(_call(bounds, ("GetRight",), 0))
            bottom = _mm(_call(bounds, ("GetBottom",), 0))
        else:
            position = _point(footprint.GetPosition())
            left = right = position[0]
            top = bottom = position[1]
        if right <= left or bottom <= top:
            center = _point(footprint.GetPosition())
            left, right = center[0] - 0.6, center[0] + 0.6
            top, bottom = center[1] - 0.6, center[1] + 0.6
        if right - left < 1.2:
            center_x = (left + right) / 2
            left, right = center_x - 0.6, center_x + 0.6
        if bottom - top < 1.2:
            center_y = (top + bottom) / 2
            top, bottom = center_y - 0.6, center_y + 0.6
        x, y = map_point((left, top))
        hit_right, hit_bottom = map_point((right, bottom))

        pads = []
        for pad in footprint.Pads():
            pad_x, pad_y = map_point(pad.GetPosition())
            size = pad.GetSize()
            shape = _call(pad, ("GetShape",), None)
            if shape == getattr(pcbnew, "PAD_SHAPE_CIRCLE", object()):
                shape_name = "circle"
            elif shape == getattr(pcbnew, "PAD_SHAPE_OVAL", object()):
                shape_name = "oval"
            else:
                shape_name = "rect"
            active_layers = []
            for layer_id, layer_name in copper.items():
                try:
                    if pad.IsOnLayer(layer_id):
                        active_layers.append(layer_name)
                except Exception:
                    continue
            pads.append({
                "number": _as_text(_call(pad, ("GetNumber",), "")),
                "x": pad_x,
                "y": pad_y,
                "width": max(_mm(size.x), 0.2),
                "height": max(_mm(size.y), 0.2),
                "shape": shape_name,
                "angle": float(_call(pad, ("GetOrientationDegrees",), 0) or 0),
                "layers": active_layers,
            })
        parts.append({
            "reference": reference,
            "value": value,
            "box": {"x": x, "y": y, "right": hit_right, "bottom": hit_bottom},
            "pads": pads,
        })
        hit_boxes.append((index, reference, value, x, y, hit_right, hit_bottom))
    return parts, hit_boxes


def _zone_fill_group(zone_fills, layer_name, view_box, edge_bounds, svg_offset=(0, 0)):
    vx, vy, _, _ = view_box
    min_x, min_y, _, _ = edge_bounds
    offset_x, offset_y = svg_offset
    group = ET.Element("{%s}g" % SVG_NS, {
        "class": "copper-zone-fill",
        "data-layer": layer_name,
        "fill": _color_for_layer(layer_name),
        "fill-rule": "evenodd",
        "stroke": "none",
    })

    for fill in zone_fills:
        if fill["layer"] != layer_name:
            continue
        commands = []
        for ring in fill["rings"]:
            if len(ring) < 3:
                continue
            points = [(vx + x - min_x + offset_x, vy + y - min_y + offset_y) for x, y in ring]
            commands.append("M " + " L ".join(
                "%s %s" % (_xml_number(x), _xml_number(y)) for x, y in points
            ) + " Z")
        if commands:
            ET.SubElement(group, "{%s}path" % SVG_NS, {
                "d": " ".join(commands),
                "fill-rule": "evenodd",
            })
    return group if len(group) else None


def _arc_points(item, map_point):
    center = _point(item.GetCenter())
    start = _point(item.GetStart())
    end = _point(item.GetEnd())
    middle = _point(item.GetMid())
    radius = math.hypot(start[0] - center[0], start[1] - center[1])
    if radius < 1:
        return [map_point(item.GetStart()), map_point(item.GetEnd())]
    angle_start = math.atan2(start[1] - center[1], start[0] - center[0])
    angle_end = math.atan2(end[1] - center[1], end[0] - center[0])
    angle_middle = math.atan2(middle[1] - center[1], middle[0] - center[0])
    positive_sweep = (angle_end - angle_start) % (2 * math.pi)
    middle_sweep = (angle_middle - angle_start) % (2 * math.pi)
    sweep = positive_sweep if middle_sweep <= positive_sweep else positive_sweep - 2 * math.pi
    segment_count = max(2, min(180, int(math.ceil(abs(sweep) / math.radians(4)))))
    points = []
    for index in range(segment_count + 1):
        angle = angle_start + sweep * index / segment_count
        point = (center[0] + radius * math.cos(angle), center[1] + radius * math.sin(angle))
        points.append(map_point(point))
    return points


def _make_overlay(board, layer_definitions, view_box, edge_bounds, zone_fills, svg_offset=(0, 0)):
    vx, vy, vw, vh = view_box
    min_x, min_y, max_x, max_y = edge_bounds
    offset_x, offset_y = svg_offset
    # KiCad's SVG coordinates are millimeters translated by the board edge
    # origin. Preserve that 1:1 transform for overlays and hit targets.
    scale_x = scale_y = 1.0

    def map_point(point):
        x, y = point if isinstance(point, tuple) else _point(point)
        return vx + x - min_x + offset_x, vy + y - min_y + offset_y

    copper = {number: name for number, name, _ in layer_definitions if name.endswith(".Cu")}
    net_map = board.GetNetsByNetcode()
    net_codes = {_as_text(_call(net, ("GetNetname", "GetNetName"), "")): int(code)
                 for code, net in net_map.items()}
    layer_ids_by_name = {name: number for number, name, _ in layer_definitions}
    groups = {}
    counts = {}
    for code, net in net_map.items():
        code = int(code)
        if code == 0:
            continue
        groups[code] = ET.Element("{%s}g" % SVG_NS, {"class": "net-group", "data-net-id": str(code)})
        counts[code] = {"pads": [], "track_count": 0, "via_count": 0}

    palette = ["#ffe066", "#59d8ff", "#ff8f70", "#b7f171", "#d2a6ff", "#ff83c5", "#78f0c7", "#ffb55e"]
    layer_groups = {}

    def group_for(code, layer_id):
        if code not in groups or layer_id not in copper:
            return None
        key = (code, layer_id)
        if key not in layer_groups:
            layer_groups[key] = ET.SubElement(groups[code], "{%s}g" % SVG_NS, {
                "data-layer": copper[layer_id],
                "class": "net-layer",
            })
        return layer_groups[key]

    net_order = sorted(groups)
    color_by_code = {code: palette[index % len(palette)] for index, code in enumerate(net_order)}
    for footprint in board.GetFootprints():
        reference = _as_text(_call(footprint, ("GetReference",), ""))
        for pad in footprint.Pads():
            code = int(_call(pad, ("GetNetCode",), 0) or 0)
            if code not in groups:
                continue
            counts[code]["pads"].append({"ref": reference, "pin": _as_text(_call(pad, ("GetNumber",), ""))})
            x, y = map_point(pad.GetPosition())
            size = pad.GetSize()
            width = max(_mm(size.x) * scale_x, 0.2)
            height = max(_mm(size.y) * scale_y, 0.2)
            shape = _call(pad, ("GetShape",), None)
            circle_shape = getattr(pcbnew, "PAD_SHAPE_CIRCLE", object())
            oval_shape = getattr(pcbnew, "PAD_SHAPE_OVAL", object())
            for layer_id, layer_name in copper.items():
                try:
                    applies = bool(pad.IsOnLayer(layer_id))
                except Exception:
                    applies = False
                if not applies:
                    continue
                parent = group_for(code, layer_id)
                if shape == circle_shape or shape == oval_shape:
                    attrs = {
                        "class": "pad-highlight", "cx": _xml_number(x), "cy": _xml_number(y),
                        "rx": _xml_number(width / 2), "ry": _xml_number(height / 2),
                    }
                    if shape == oval_shape and abs(width - height) > 0.001:
                        angle = float(_call(pad, ("GetOrientationDegrees",), 0) or 0)
                        if angle:
                            attrs["transform"] = "rotate(%s %s %s)" % (
                                _xml_number(-angle), _xml_number(x), _xml_number(y))
                    ET.SubElement(parent, "{%s}ellipse" % SVG_NS, attrs)
                else:
                    angle = float(_call(pad, ("GetOrientationDegrees",), 0) or 0)
                    ET.SubElement(parent, "{%s}rect" % SVG_NS, {
                        "class": "pad-highlight", "x": _xml_number(x - width / 2), "y": _xml_number(y - height / 2),
                        "width": _xml_number(width), "height": _xml_number(height),
                        "rx": _xml_number(min(width, height) * 0.18),
                        "transform": "rotate(%s %s %s)" % (_xml_number(-angle), _xml_number(x), _xml_number(y)),
                    })

    for item in board.GetTracks():
        code = int(_call(item, ("GetNetCode",), 0) or 0)
        if code not in groups:
            continue
        layer_id = int(_call(item, ("GetLayer",), -1))
        class_name = item.__class__.__name__.upper()
        is_via = "VIA" in class_name or (
            (hasattr(item, "GetTopLayer") and hasattr(item, "GetBottomLayer"))
            or (hasattr(item, "TopLayer") and hasattr(item, "BottomLayer")))
        if is_via:
            top = int(_call(item, ("GetTopLayer", "TopLayer"), layer_id))
            bottom = int(_call(item, ("GetBottomLayer", "BottomLayer"), layer_id))
            active_layers = [number for number in copper if min(top, bottom) <= number <= max(top, bottom)]
            x, y = map_point(item.GetPosition())
            try:
                via_width = item.GetWidth(top)
            except Exception:
                via_width = _call(item, ("GetFrontWidth",), 0)
            diameter = _mm(via_width) * (scale_x + scale_y) / 2
            for active_layer in active_layers:
                parent = group_for(code, active_layer)
                ET.SubElement(parent, "{%s}circle" % SVG_NS, {
                    "class": "net-highlight via-highlight", "cx": _xml_number(x), "cy": _xml_number(y),
                    "r": _xml_number(diameter / 2),
                })
            counts[code]["via_count"] += 1
            continue
        parent = group_for(code, layer_id)
        if parent is None:
            continue
        width = _mm(_call(item, ("GetWidth",), 0)) * (scale_x + scale_y) / 2
        if "ARC" in class_name and hasattr(item, "GetMid"):
            points = _arc_points(item, map_point)
            path = "M " + " L ".join("%s %s" % (_xml_number(x), _xml_number(y)) for x, y in points)
            ET.SubElement(parent, "{%s}path" % SVG_NS, {
                "class": "net-highlight track-highlight", "d": path, "stroke-width": _xml_number(max(width, 0.15)),
            })
        else:
            start = map_point(item.GetStart())
            end = map_point(item.GetEnd())
            ET.SubElement(parent, "{%s}line" % SVG_NS, {
                "class": "net-highlight track-highlight", "x1": _xml_number(start[0]), "y1": _xml_number(start[1]),
                "x2": _xml_number(end[0]), "y2": _xml_number(end[1]), "stroke-width": _xml_number(max(width, 0.15)),
            })
        counts[code]["track_count"] += 1

    for fill in zone_fills:
        code = net_codes.get(fill["net"])
        layer_id = layer_ids_by_name.get(fill["layer"])
        if code not in groups or layer_id not in copper:
            continue
        parent = group_for(code, layer_id)
        commands = []
        for ring in fill["rings"]:
            if len(ring) < 3:
                continue
            points = [map_point(point) for point in ring]
            commands.append("M " + " L ".join(
                "%s %s" % (_xml_number(x), _xml_number(y)) for x, y in points
            ) + " Z")
        if commands:
            ET.SubElement(parent, "{%s}path" % SVG_NS, {
                "class": "zone-highlight",
                "d": " ".join(commands),
                "fill-rule": "evenodd",
            })

    root = ET.Element("{%s}svg" % SVG_NS, {
        "class": "net-overlay", "viewBox": " ".join(_xml_number(value) for value in view_box),
        "preserveAspectRatio": "xMidYMid meet", "aria-label": "Clickable net highlight overlay",
    })
    # Organize the hit geometry by board layer first so SVG hit testing follows
    # the same stacking order as the rendered layer artwork. This lets clicks
    # pass through areas with no geometry on an upper layer to lower layers.
    for layer_id, layer_name in copper.items():
        layer_root = ET.SubElement(root, "{%s}g" % SVG_NS, {
            "data-layer": layer_name,
            "class": "net-layer",
        })
        for code in net_order:
            source_group = layer_groups.get((code, layer_id))
            if source_group is None or len(source_group) == 0:
                continue
            group = ET.SubElement(layer_root, "{%s}g" % SVG_NS, {
                "class": "net-group",
                "data-net-id": str(code),
                "style": "--net-color:%s;--highlight-width:%s" % (color_by_code[code], _xml_number(max(vw, vh) / 360)),
            })
            for shape in list(source_group):
                group.append(shape)
    parts, hit_boxes = _part_viewer_data(board, copper, map_point)
    hit_layer = ET.SubElement(root, "{%s}g" % SVG_NS, {"class": "part-hit-layer"})
    for index, reference, value, left, top, right, bottom in hit_boxes:
        label = reference + (" · " + value if value else "")
        hit_box = ET.SubElement(hit_layer, "{%s}rect" % SVG_NS, {
            "class": "part-hit",
            "data-part-id": str(index),
            "x": _xml_number(left), "y": _xml_number(top),
            "width": _xml_number(right - left), "height": _xml_number(bottom - top),
            "role": "button", "tabindex": "0", "aria-label": "Select part " + label,
        })
        ET.SubElement(hit_box, "{%s}title" % SVG_NS).text = label
    return root, counts, parts


def _net_data(board, counts):
    nets = []
    palette = ["#ffe066", "#59d8ff", "#ff8f70", "#b7f171", "#d2a6ff", "#ff83c5", "#78f0c7", "#ffb55e"]
    for code, net in sorted(board.GetNetsByNetcode().items(), key=lambda item: int(item[0])):
        code = int(code)
        if code == 0:
            continue
        summary = counts.get(code, {"pads": [], "track_count": 0, "via_count": 0})
        summary["pads"].sort(key=lambda pad: (pad["ref"], pad["pin"]))
        nets.append({
            "code": code,
            "name": _as_text(_call(net, ("GetNetname", "GetNetName"), "")),
            "color": palette[len(nets) % len(palette)],
            "pads": summary["pads"],
            "track_count": summary["track_count"],
            "via_count": summary["via_count"],
        })
    return nets


def _document(board_name, revision, issue_date, layer_data, nets, parts, svg_roots, overlay, edge_bounds, drill_origin_svg):
    template = (ASSET_DIR / "viewer.html").read_text(encoding="utf-8")
    css = (ASSET_DIR / "viewer.css").read_text(encoding="utf-8")
    js = (ASSET_DIR / "viewer.js").read_text(encoding="utf-8")
    board_label = html.escape(board_name)
    metadata = []
    if revision:
        metadata.append("Revision " + html.escape(revision))
    if issue_date:
        metadata.append("Issue date " + html.escape(issue_date))
    board_meta = " · ".join(metadata)
    left, top, right, bottom = edge_bounds
    board_bounds_mm = {"left": left, "top": top, "right": right, "bottom": bottom}
    data = json.dumps({"board": board_name, "layers": layer_data, "nets": nets, "parts": parts,
                       "board_bounds_mm": board_bounds_mm,
                       "drill_origin_svg": drill_origin_svg}, ensure_ascii=False, separators=(",", ":"))
    data = data.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
    layer_markup = "\n".join(ET.tostring(root, encoding="unicode") for root in svg_roots)
    overlay_markup = ET.tostring(overlay, encoding="unicode")
    summary = "%d layers · %d nets" % (len(layer_data), len(nets))
    replacements = {
        "{{TITLE}}": html.escape(board_name + " — KiCad Layout Viewer"),
        "{{BOARD_NAME}}": board_label,
        "{{BOARD_META}}": board_meta,
        "{{SUMMARY}}": summary,
        "{{SVG_LAYERS}}": layer_markup,
        "{{NET_OVERLAY}}": overlay_markup,
        "{{DATA}}": data,
        "{{CSS}}": css,
        "{{JS}}": js,
    }
    for key, value in replacements.items():
        template = template.replace(key, value)
    return template


def export_board(board, board_path, output_path):
    board_text = Path(board_path).read_text(encoding="utf-8", errors="replace")
    layers = _layer_definitions(board_path)
    zone_fills = _zone_fills_from_board(board, layers)
    # Fabrication layers add labels and assembly dimensions that are not useful
    # in the interactive layout view. Keep them out of both the SVG export and
    # the viewer's layer controls.
    layer_names = [name for _, name, _ in layers if name not in ("F.Fab", "B.Fab")]
    title_block = _call(board, ("GetTitleBlock",), None)
    revision = _as_text(_call(title_block, ("GetRevision",), "")).strip() if title_block else ""
    issue_date = _as_text(_call(title_block, ("GetDate",), "")).strip() if title_block else ""
    cli = _find_cli()
    with tempfile.TemporaryDirectory(prefix="kicad-layout-viewer-") as temp_dir:
        svg_dir = os.path.join(temp_dir, "svg")
        os.mkdir(svg_dir)
        render_board_path = Path(temp_dir) / (Path(board_path).stem + "-viewer-base.kicad_pcb")
        _write_zone_free_render_board(board_path, render_board_path, board_text)
        svg_files = _export_svgs(cli, str(render_board_path), layer_names, svg_dir)

        # -----------------------------------------------------------------
        # Get the mapping from layer name → SVG file.  The mechanical‑drawing
        # layer (User.Drawings / Dwgs.User / User.9) may be missing if it
        # contains only text or is empty, so we must not assume every name
        # in `layer_names` has a corresponding SVG file.
        # -----------------------------------------------------------------
        matched = _svg_file_layers(svg_files, render_board_path.stem, layer_names)

        # Choose the first layer that actually has an SVG file.  This file is
        # only needed to read the generic SVG metadata (viewBox, etc.).
        available_layers = [name for name in layer_names if name in matched]
        if not available_layers:
            raise RuntimeError("No SVG files were generated for any board layer.")
        raw_root = ET.parse(str(matched[available_layers[0]])).getroot()

        view_box = [float(number) for number in re.split(r"[ ,]+", raw_root.get("viewBox", "").strip()) if number]
        if len(view_box) != 4:
            raise RuntimeError("KiCad's SVG is missing a valid viewBox.")
        bounds = board.GetBoardEdgesBoundingBox()
        edge_bounds = (_mm(bounds.GetLeft()), _mm(bounds.GetTop()),
                       _mm(bounds.GetRight()), _mm(bounds.GetBottom()))
        svg_offset = _svg_coordinate_offset(raw_root, board, edge_bounds)
        design_settings = _call(board, ("GetDesignSettings",), None)
        drill_origin = _call(design_settings, ("GetAuxOrigin",), None)
        drill_origin_mm = _point(drill_origin) if drill_origin is not None else (0.0, 0.0)
        drill_origin_svg = {
            "x": view_box[0] + drill_origin_mm[0] - edge_bounds[0] + svg_offset[0],
            "y": view_box[1] + drill_origin_mm[1] - edge_bounds[1] + svg_offset[1],
        }
        nonplated_centers = _nonplated_pad_centers(board, view_box, edge_bounds, svg_offset)

        # Build SVG roots only for layers that really have a file.  Missing
        # mechanical‑drawing layers are simply omitted – the viewer will still
        # display the toggle for them, but they will be invisible when empty.
        svg_roots = [_svg_root(matched[name], name, nonplated_centers)
                    for name in layer_names if name in matched]
        
        for svg_root, name in zip(svg_roots, layer_names):
            if name.endswith(".Cu"):
                zone_group = _zone_fill_group(zone_fills, name, view_box, edge_bounds, svg_offset)
                if zone_group is not None:
                    first_drawing = next((index for index, child in enumerate(svg_root)
                                          if child.tag == "{%s}g" % SVG_NS), len(svg_root))
                    svg_root.insert(first_drawing, zone_group)
            drill_mask = _drill_hole_group(board, view_box, edge_bounds, svg_offset)
            if drill_mask is not None:
                svg_root.append(drill_mask)
        overlay, counts, parts = _make_overlay(board, layers, view_box, edge_bounds, zone_fills, svg_offset)
        nets = _net_data(board, counts)
        layer_data = [{"name": name, "color": _color_for_layer(name), "visible": _initial_visibility(name)} for name in layer_names]
        document = _document(Path(board_path).stem, revision, issue_date, layer_data, nets, parts,
                             svg_roots, overlay, edge_bounds, drill_origin_svg)
        Path(output_path).write_text(document, encoding="utf-8")


class ExportInteractiveLayout(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Export interactive HTML layout"
        self.category = "KiCad Layout Viewer"
        self.description = "Export all PCB layers with clickable parts and net highlights to one offline HTML file"
        self.show_toolbar_button = False

    def Run(self):
        board = pcbnew.GetBoard()
        board_path = _as_text(_call(board, ("GetFileName",), ""))
        if not board_path or not Path(board_path).is_file():
            wx.MessageBox("Save the board before exporting the layout viewer.", "KiCad Layout Viewer", wx.OK | wx.ICON_INFORMATION)
            return
        output = Path(board_path).with_suffix(".html")
        dialog = wx.FileDialog(None, "Export interactive HTML layout", defaultDir=str(output.parent),
                               defaultFile=output.name, wildcard="HTML files (*.html)|*.html",
                               style=wx.FD_SAVE | wx.FD_OVERWRITE_PROMPT)
        try:
            if dialog.ShowModal() != wx.ID_OK:
                return
            output = Path(dialog.GetPath())
        finally:
            dialog.Destroy()
        if not output.suffix:
            output = output.with_suffix(".html")
        try:
            export_board(board, board_path, str(output))
        except Exception as error:
            wx.MessageBox(str(error), "KiCad Layout Viewer export failed", wx.OK | wx.ICON_ERROR)
            return
        wx.MessageBox("Exported %s" % output, "KiCad Layout Viewer", wx.OK | wx.ICON_INFORMATION)


ExportInteractiveLayout().register()
