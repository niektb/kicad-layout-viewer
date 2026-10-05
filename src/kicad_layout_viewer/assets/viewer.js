(() => {
  "use strict";
  const data = JSON.parse(document.getElementById("viewer-data").textContent);
  const layers = data.layers;
  const nets = data.nets;
  const parts = data.parts || [];
  const $ = (selector) => document.querySelector(selector);
  const themeButton = $("#toggle-theme");
  const themeStorageKey = "kicad-layout-viewer:theme:v1";
  let lightTheme = false;
  try {
    lightTheme = window.localStorage.getItem(themeStorageKey) === "light";
  } catch {}
  function applyViewerTheme(isLight, savePreference = false) {
    lightTheme = isLight;
    document.body.classList.toggle("light-theme", lightTheme);
    themeButton.textContent = lightTheme ? "Dark mode" : "Light mode";
    themeButton.setAttribute("aria-pressed", String(lightTheme));
    themeButton.title = lightTheme ? "Switch to dark mode" : "Switch to light mode";
    updateBoardPalette(lightTheme);
    if (savePreference) {
      try {
        window.localStorage.setItem(themeStorageKey, lightTheme ? "light" : "dark");
      } catch {}
    }
  }
  themeButton.addEventListener("click", () => applyViewerTheme(!lightTheme, true));
  const layerList = $("#layer-list");
  const netList = $("#net-list");
  const partList = $("#part-list");
  const stack = $("#board-stack");
  const canvas = $("#canvas");
  const commentTooltip = document.createElement("div");
  commentTooltip.className = "comment-tooltip";
  commentTooltip.hidden = true;
  commentTooltip.setAttribute("role", "tooltip");
  canvas.append(commentTooltip);
  const rowByLayer = new Map();
  const inputByLayer = new Map();
  const layerSvgs = [...document.querySelectorAll(".layer-svg")];
  const svgByLayer = new Map(layerSvgs.map((svg) => [svg.dataset.layer, svg]));
  const layerByName = new Map(layers.map((layer) => [layer.name, layer]));
  const overlay = $(".net-overlay");
  const originalLayerPaint = new WeakMap();
  const lightNetPalette = ["#945f00", "#006783", "#a83f2b", "#4d7018", "#70509a", "#923a69", "#17634e", "#92500e"];
  const netById = new Map(nets.map((net, index) => [String(net.code), { net, index }]));
  function zoneRings(geometry) {
    if (geometry.zoneRings) return geometry.zoneRings;
    const tokens = (geometry.getAttribute("d") || "").match(/[MLZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || [];
    const rings = [];
    let ring = null;
    for (let index = 0; index < tokens.length;) {
      const command = tokens[index++];
      if (command === "M" || command === "L") {
        const point = [Number(tokens[index++]), Number(tokens[index++])];
        if (command === "M") {
          if (ring?.length >= 3) rings.push(ring);
          ring = [point];
        } else if (ring) {
          ring.push(point);
        }
      } else if (command === "Z") {
        if (ring?.length >= 3) rings.push(ring);
        ring = null;
      }
    }
    if (ring?.length >= 3) rings.push(ring);
    geometry.zoneRings = rings;
    return rings;
  }
  function pointInRing(point, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [x1, y1] = ring[previous];
      const [x2, y2] = ring[index];
      const cross = (point.x - x1) * (y2 - y1) - (point.y - y1) * (x2 - x1);
      if (Math.abs(cross) < 1e-7
          && point.x >= Math.min(x1, x2) - 1e-7 && point.x <= Math.max(x1, x2) + 1e-7
          && point.y >= Math.min(y1, y2) - 1e-7 && point.y <= Math.max(y1, y2) + 1e-7) return true;
      if ((y1 > point.y) !== (y2 > point.y)
          && point.x < (x2 - x1) * (point.y - y1) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
  }
  function pointInZoneCopper(geometry, point) {
    const rings = zoneRings(geometry);
    return rings.reduce((inside, ring) => inside !== pointInRing(point, ring), false);
  }
  function geometryHitAtScreenPoint(geometry, screenPoint) {
    const matrix = geometry.getScreenCTM();
    if (!matrix) return false;
    const point = screenPoint.matrixTransform(matrix.inverse());
    if (geometry.matches(".zone-highlight")) return pointInZoneCopper(geometry, point);
    if (geometry.matches(".via-highlight")) {
      const cx = Number(geometry.getAttribute("cx"));
      const cy = Number(geometry.getAttribute("cy"));
      const radius = Number(geometry.getAttribute("r"));
      const center = new DOMPoint(cx, cy).matrixTransform(matrix);
      const edgeX = new DOMPoint(cx + radius, cy).matrixTransform(matrix);
      const edgeY = new DOMPoint(cx, cy + radius).matrixTransform(matrix);
      const radiusOnScreen = Math.max(
        Math.hypot(edgeX.x - center.x, edgeX.y - center.y),
        Math.hypot(edgeY.x - center.x, edgeY.y - center.y)
      );
      const strokeWidth = Number.parseFloat(getComputedStyle(geometry).strokeWidth) || 0;
      const clickRadius = radiusOnScreen + strokeWidth / 2;
      if (Math.hypot(screenPoint.x - center.x, screenPoint.y - center.y) <= clickRadius) return true;
    }
    const fillHit = geometry.matches(".pad-highlight, .via-highlight") && geometry.isPointInFill(point);
    const strokeHit = geometry.matches(".net-highlight, .pad-highlight") && geometry.isPointInStroke(point);
    return fillHit || strokeHit;
  }
  function choosePartAtPoint(partTarget, screenPoint) {
    const matrix = overlay.getScreenCTM();
    if (!matrix) {
      choosePart(partTarget.dataset.partId);
      return true;
    }
    const point = screenPoint.matrixTransform(matrix.inverse());
    const candidates = parts.map((part, id) => ({ part, id })).filter(({ part }) =>
      point.x >= part.box.x && point.x <= part.box.right
      && point.y >= part.box.y && point.y <= part.box.bottom
    ).sort((a, b) =>
      (a.part.box.right - a.part.box.x) * (a.part.box.bottom - a.part.box.y)
      - (b.part.box.right - b.part.box.x) * (b.part.box.bottom - b.part.box.y)
    );
    if (!candidates.length) return false;
    choosePart(candidates[0].id);
    return true;
  }
  function resolveZoneClickStack(event, zoneTarget, screenPoint) {
    const visited = new Set();
    const candidates = document.elementsFromPoint(event.clientX, event.clientY);
    let partTarget = null;
    let zoneGroup = null;
    for (const element of candidates) {
      const target = element.closest?.(".part-hit, .zone-highlight, .pad-highlight, .via-highlight, .net-highlight");
      if (!target || !overlay.contains(target) || visited.has(target)) continue;
      visited.add(target);
      if (target.matches(".part-hit")) {
        partTarget ||= target;
        continue;
      }
      if (target.matches(".zone-highlight")) {
        if (Number(zoneTransparencyInput.value) < 100 && geometryHitAtScreenPoint(target, screenPoint)) {
          zoneGroup ||= target.closest("[data-net-id]");
        }
        continue;
      }
      if (!geometryHitAtScreenPoint(target, screenPoint)) continue;
      const netGroup = target.closest("[data-net-id]");
      if (netGroup) {
        chooseNet(netGroup.dataset.netId);
        return true;
      }
    }
    if (partTarget && choosePartAtPoint(partTarget, screenPoint)) {
      return true;
    }
    if (!zoneGroup && Number(zoneTransparencyInput.value) < 100
        && geometryHitAtScreenPoint(zoneTarget, screenPoint)) {
      zoneGroup = zoneTarget.closest("[data-net-id]");
    }
    if (zoneGroup) {
      chooseNet(zoneGroup.dataset.netId);
      return true;
    }
    return false;
  }
  function lightLayerColor(name) {
    if (name.endsWith(".SilkS")) return "#51482f";
    if (name.endsWith(".Cu")) {
      return ({ "F.Cu": "#864526", "B.Cu": "#3d5b76", "In1.Cu": "#405f4e", "In2.Cu": "#614a70" })[name] || "#705c37";
    }
    if (name.includes("Mask")) return "#405849";
    if (name.includes("Paste")) return "#62566d";
    if (name === "Edge.Cuts") return "#756a3d";
    if (name.includes("Fab")) return "#4b5c6c";
    if (name.includes("CrtYd")) return "#75494d";
    return "#4b5662";
  }
  function isVisiblePaint(value) {
    const normalized = (value || "").trim().toLowerCase();
    return normalized && normalized !== "none" && normalized !== "transparent" && !normalized.startsWith("url(");
  }
  function recolorLayerSvg(svg, color, isLight) {
    svg.querySelectorAll("*").forEach((element) => {
      if (element.closest(".drill-hole-mask") || element.classList.contains("nonplated-pad-mask")
          || element.classList.contains("nonplated-hole")
          || element.matches('circle[fill="#ffffff"]')) return;
      let original = originalLayerPaint.get(element);
      if (!original) {
        original = {
          fill: element.getAttribute("fill"),
          stroke: element.getAttribute("stroke"),
          style: element.getAttribute("style"),
        };
        originalLayerPaint.set(element, original);
      }
      if (!isLight) {
        for (const property of ["fill", "stroke"]) {
          if (original[property] === null) element.removeAttribute(property);
          else element.setAttribute(property, original[property]);
        }
        if (original.style === null) element.removeAttribute("style");
        else element.setAttribute("style", original.style);
        return;
      }
      for (const property of ["fill", "stroke"]) {
        if (isVisiblePaint(original[property])) element.setAttribute(property, color);
      }
      if (original.style !== null) {
        element.setAttribute("style", original.style);
        for (const property of ["fill", "stroke"]) {
          if (isVisiblePaint(element.style.getPropertyValue(property))) element.style.setProperty(property, color);
        }
      }
    });
  }
  function updateBoardPalette(isLight) {
    if (typeof layerSvgs === "undefined") return;
    layerSvgs.forEach((svg) => {
      const layer = layerByName.get(svg.dataset.layer);
      if (!layer) return;
      const color = isLight ? lightLayerColor(layer.name) : layer.color;
      recolorLayerSvg(svg, color, isLight);
      const swatch = rowByLayer.get(layer.name)?.querySelector(".layer-swatch");
      if (swatch) swatch.style.background = color;
    });
    overlay.querySelectorAll(".net-group").forEach((group) => {
      const entry = netById.get(group.dataset.netId);
      if (entry) group.style.setProperty("--net-color", isLight ? lightNetPalette[entry.index % lightNetPalette.length] : entry.net.color);
    });
    netList.querySelectorAll(".net-row").forEach((row) => {
      const entry = netById.get(row.dataset.netId);
      const dot = row.querySelector(".net-dot");
      if (entry && dot) dot.style.background = isLight ? lightNetPalette[entry.index % lightNetPalette.length] : entry.net.color;
    });
  }
  const zoneTransparencyInput = $("#zone-transparency");
  const zoneTransparencyValue = $("#zone-transparency-value");
  const initialZoneTransparency = Number(zoneTransparencyInput.value);
  const commentOverlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  commentOverlay.setAttribute("class", "comment-overlay");
  commentOverlay.setAttribute("aria-label", "Board comments");
  commentOverlay.setAttribute("preserveAspectRatio", "xMidYMid meet");
  stack.append(commentOverlay);
  const selectedNets = new Set();
  const selectedPartIds = new Set();
  function updateZoneTransparency() {
    const transparencyPercent = Number(zoneTransparencyInput.value);
    const transparency = transparencyPercent / 100;
    const opacity = 1 - transparency;
    layerSvgs.forEach((svg) => {
      svg.querySelectorAll(".copper-zone-fill").forEach((zone) => {
        zone.style.opacity = String(opacity);
      });
    });
    overlay.classList.toggle("zones-transparent", transparencyPercent >= 100);
    zoneTransparencyValue.textContent = `${zoneTransparencyInput.value}%`;
  }
  function defaultLayerPriority(name) {
    if (name.endsWith(".SilkS")) return 0;
    if (name === "Edge.Cuts") return 1;
    if (name.endsWith(".Cu")) return 3;
    return 2;
  }
  const initialLayerOrder = layers
    .map((layer, index) => ({ name: layer.name, index }))
    .sort((a, b) => defaultLayerPriority(a.name) - defaultLayerPriority(b.name) || a.index - b.index)
    .map((layer) => layer.name); // First row is drawn on top.
  const layerOrder = [...initialLayerOrder];
  const initialLayerVisibility = new Map(layers.map((layer) => [layer.name, !!layer.visible]));
  const commentsStorageKey = `kicad-layout-viewer:comments:v1:${encodeURIComponent(`${window.location.pathname}|${data.board}`)}`;
  function loadSavedComments() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(commentsStorageKey) || "null");
      if (!Array.isArray(saved)) return [];
      return saved.slice(0, 2000).map((raw) => {
        if (!raw || typeof raw !== "object") return null;
        const x = Number(raw.x);
        const y = Number(raw.y);
        const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 4000) : "";
        if (!Number.isFinite(x) || !Number.isFinite(y) || !text) return null;
        return {
          id: typeof raw.id === "string" && raw.id ? raw.id : makeId(),
          x,
          y,
          text,
          status: raw.status === "completed" || raw.status === "rejected" ? raw.status : "open",
          created_at: typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString(),
          updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
        };
      }).filter(Boolean);
    } catch {
      return [];
    }
  }
  function saveComments() {
    try {
      window.localStorage.setItem(commentsStorageKey, JSON.stringify(comments));
    } catch {
      $("#selection-status").textContent = "Comments could not be saved by this browser";
    }
  }
  const comments = loadSavedComments();
  const commentMarkerById = new Map();
  const boardBounds = data.board_bounds_mm;
  const drillOriginSvg = data.drill_origin_svg || { x: 0, y: 0 };
  let commentsVisible = true;
  let placingComment = false;
  let draftPoint = null;
  let editingCommentId = null;
  let bottomView = false;
  let originalViewBox = (layerSvgs[0] || overlay).getAttribute("viewBox").split(/[ ,]+/).map(Number);
  let viewBox = [...originalViewBox];
  // Comment storage remains in board coordinates internally; present and
  // exchange coordinates relative to KiCad's drill origin with Y positive up.
  const drillOriginBoard = {
    x: boardBounds.left + drillOriginSvg.x - originalViewBox[0],
    y: boardBounds.top + drillOriginSvg.y - originalViewBox[1],
  };
  let pointer = null;

  function syncViewBox() {
    const value = viewBox.join(" ");
    [...layerSvgs, overlay, commentOverlay].forEach((svg) => svg.setAttribute("viewBox", value));
  }

  function boardToSvg(point) {
    const [vx, vy] = originalViewBox;
    return {
      x: vx + point.x - boardBounds.left,
      y: vy + point.y - boardBounds.top,
    };
  }

  function screenToBoard(clientX, clientY) {
    const screenPoint = commentOverlay.createSVGPoint();
    screenPoint.x = clientX;
    screenPoint.y = clientY;
    const local = screenPoint.matrixTransform(commentOverlay.getScreenCTM().inverse());
    const [vx, vy] = originalViewBox;
    return {
      x: boardBounds.left + local.x - vx,
      y: boardBounds.top + local.y - vy,
    };
  }

  function formatCoordinate(point) {
    const x = point.x - drillOriginBoard.x;
    const y = drillOriginBoard.y - point.y;
    return `X ${x.toFixed(3)} mm · Y ${y.toFixed(3)} mm`;
  }

  function makeId() {
    return globalThis.crypto?.randomUUID?.() || `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function renderComments() {
    renderCommentList();
    renderCommentMarkers();
  }

  function renderCommentMarkers() {
    commentOverlay.replaceChildren();
    commentMarkerById.clear();
    commentOverlay.style.visibility = commentsVisible ? "visible" : "hidden";
    const markerRadius = Math.max(originalViewBox[2], originalViewBox[3]) / 72;
    comments.forEach((comment, index) => {
      if (comment.status === "completed" || comment.status === "rejected") return;
      const point = boardToSvg(comment);
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "g");
      marker.classList.add("comment-marker");
      marker.dataset.commentId = comment.id;
      marker.setAttribute("transform", `translate(${point.x} ${point.y})`);
      marker.setAttribute("role", "button");
      marker.setAttribute("tabindex", "0");
      marker.setAttribute("aria-label", `Comment ${index + 1}: ${comment.text}`);
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", String(markerRadius));
      const number = document.createElementNS("http://www.w3.org/2000/svg", "text");
      number.setAttribute("y", "0.02");
      number.setAttribute("font-size", String(markerRadius * 1.1));
      number.textContent = String(index + 1);
      marker.append(circle, number);
      marker.addEventListener("pointerenter", () => showCommentTooltip(comment, marker));
      marker.addEventListener("pointerleave", hideCommentTooltip);
      marker.addEventListener("focus", () => showCommentTooltip(comment, marker));
      marker.addEventListener("blur", hideCommentTooltip);
      commentOverlay.append(marker);
      commentMarkerById.set(comment.id, marker);
    });
    syncCommentMarkerText();
  }

  function syncCommentMarkerText() {
    commentOverlay.querySelectorAll(".comment-marker text").forEach((number) => {
      if (bottomView) number.setAttribute("transform", "scale(-1 1)");
      else number.removeAttribute("transform");
    });
  }

  function setCommentHighlight(commentId, highlighted) {
    const marker = commentMarkerById.get(commentId);
    if (marker) marker.classList.toggle("is-highlighted", highlighted);
  }

  function showCommentTooltip(comment, marker) {
    commentTooltip.textContent = comment.text;
    commentTooltip.hidden = false;
    const markerRect = marker.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const padding = 10;
    const centerX = markerRect.left + markerRect.width / 2 - canvasRect.left;
    let top = markerRect.top - canvasRect.top - 8;
    commentTooltip.style.left = `${centerX}px`;
    commentTooltip.style.top = `${top}px`;

    const halfWidth = commentTooltip.offsetWidth / 2;
    const x = Math.max(halfWidth + padding, Math.min(canvasRect.width - halfWidth - padding, centerX));
    const height = commentTooltip.offsetHeight;
    const placeBelow = top < height + padding;
    if (placeBelow) top = markerRect.bottom - canvasRect.top + 8;
    top = Math.min(top, canvasRect.height - height - padding);
    commentTooltip.classList.toggle("is-below", placeBelow);
    commentTooltip.style.left = `${x}px`;
    commentTooltip.style.top = `${Math.max(padding, top)}px`;
  }

  function hideCommentTooltip() {
    commentTooltip.hidden = true;
  }

  function renderCommentList() {
    const list = $("#comment-list");
    list.replaceChildren();
    $("#comment-count").textContent = String(comments.length);
    if (!comments.length) {
      const empty = document.createElement("p");
      empty.className = "comment-empty";
      empty.textContent = "No comments yet. Add one to mark a board location.";
      list.append(empty);
      return;
    }
    comments.forEach((comment, index) => {
      const row = document.createElement("div");
      row.className = "comment-row";
      row.dataset.commentId = comment.id;
      row.classList.toggle("is-completed", comment.status === "completed");
      row.classList.toggle("is-rejected", comment.status === "rejected");
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "comment-row-open";
      openButton.setAttribute("aria-label", `Edit comment ${index + 1}`);
      const number = document.createElement("span");
      number.className = "comment-row-number";
      number.textContent = String(index + 1);
      const body = document.createElement("span");
      body.className = "comment-row-body";
      const text = document.createElement("span");
      text.className = "comment-row-text";
      text.textContent = comment.text;
      const coordinate = document.createElement("span");
      coordinate.className = "comment-row-coordinate";
      coordinate.textContent = formatCoordinate(comment);
      body.append(text, coordinate);
      openButton.append(number, body);
      const statuses = document.createElement("div");
      statuses.className = "comment-row-statuses";
      const statusInputs = new Map();
      [["completed", "Completed"], ["rejected", "Rejected"]].forEach(([status, labelText]) => {
        const label = document.createElement("label");
        label.className = `comment-row-status comment-row-status-${status}`;
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = comment.status === status;
        input.setAttribute("aria-label", `${labelText} comment ${index + 1}`);
        input.addEventListener("change", () => {
          comment.status = input.checked ? status : "open";
          statusInputs.forEach((otherInput, otherStatus) => {
            otherInput.checked = comment.status === otherStatus;
          });
          row.classList.toggle("is-completed", comment.status === "completed");
          row.classList.toggle("is-rejected", comment.status === "rejected");
          saveComments();
          renderCommentMarkers();
        });
        statusInputs.set(status, input);
        const caption = document.createElement("span");
        caption.textContent = labelText;
        label.append(input, caption);
        statuses.append(label);
      });
      row.append(openButton, statuses);
      row.addEventListener("pointerenter", () => setCommentHighlight(comment.id, true));
      row.addEventListener("pointerleave", () => setCommentHighlight(comment.id, false));
      row.addEventListener("focusin", () => setCommentHighlight(comment.id, true));
      row.addEventListener("focusout", (event) => {
        if (!row.contains(event.relatedTarget)) setCommentHighlight(comment.id, false);
      });
      openButton.addEventListener("click", () => openCommentDialog(null, comment));
      list.append(row);
    });
  }

  function openCommentDialog(point, comment = null) {
    editingCommentId = comment?.id || null;
    draftPoint = comment ? { x: comment.x, y: comment.y } : point;
    $("#comment-dialog-title").textContent = comment ? `Edit comment ${comments.indexOf(comment) + 1}` : "Add comment";
    $("#comment-coordinate").textContent = formatCoordinate(draftPoint);
    $("#comment-text").value = comment?.text || "";
    $("#delete-comment").hidden = !comment;
    $("#comment-dialog").showModal();
    $("#comment-text").focus();
  }

  function setPlacementMode(active) {
    placingComment = active;
    const button = $("#add-comment");
    button.setAttribute("aria-pressed", String(active));
    button.textContent = active ? "Cancel placement" : "Add comment";
    $("#placement-banner").hidden = !active;
    document.body.classList.toggle("is-placing-comment", active);
    $("#canvas").classList.toggle("is-placing-comment", active);
    $("#interaction-hint").textContent = active
      ? "Click a board coordinate to add a comment · Press Esc to cancel"
      : "Export comments to save · Scroll to zoom · Right-drag to pan · Click nets to highlight · Click parts to select pads";
  }

  function oppositeSideLayer(name) {
    const match = name.match(/^([FB])\.(.+)$/);
    if (!match) return name;
    const other = `${match[1] === "F" ? "B" : "F"}.${match[2]}`;
    return layerByName.has(other) ? other : name;
  }

  function syncStackOrder() {
    [...layerOrder].reverse().forEach((name) => {
      const svg = svgByLayer.get(name);
      if (svg) stack.insertBefore(svg, overlay);
    });
    const partHitLayer = overlay.querySelector(":scope > .part-hit-layer");
    if (partHitLayer) overlay.insertBefore(partHitLayer, overlay.firstChild);
    [...layerOrder].reverse().forEach((name) => {
      const netLayer = [...overlay.children].find((group) => group.dataset.layer === name);
      if (netLayer) overlay.append(netLayer);
    });
    const selectedPartPads = overlay.querySelector(":scope > .selected-part-pads");
    if (selectedPartPads) overlay.append(selectedPartPads);
  }

  function layerVisible(name) {
    const input = inputByLayer.get(name);
    return !!input && input.checked;
  }

  function updateLayers() {
    layerSvgs.forEach((svg) => {
      const visible = layerVisible(svg.dataset.layer);
      svg.classList.toggle("is-visible", visible);
      svg.setAttribute("aria-hidden", String(!visible));
    });
    overlay.querySelectorAll("[data-layer]").forEach((group) => {
      group.classList.toggle("layer-hidden", !layerVisible(group.dataset.layer));
    });
    syncStackOrder();
    $("#empty-state").hidden = layerSvgs.some((svg) => svg.classList.contains("is-visible"));
  }

  function reorderLayer(sourceName, targetName, afterTarget) {
    const sourceIndex = layerOrder.indexOf(sourceName);
    const targetIndex = layerOrder.indexOf(targetName);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    let insertionIndex = targetIndex + (afterTarget ? 1 : 0);
    const [moved] = layerOrder.splice(sourceIndex, 1);
    if (sourceIndex < insertionIndex) insertionIndex -= 1;
    layerOrder.splice(insertionIndex, 0, moved);
    layerOrder.forEach((layerName) => layerList.append(rowByLayer.get(layerName)));
    updateLayers();
  }

  let draggedLayer = null;
  function clearLayerDropIndicators() {
    layerList.querySelectorAll(".is-drop-before, .is-drop-after").forEach((row) => {
      row.classList.remove("is-drop-before", "is-drop-after");
    });
  }

  layers.forEach((layer) => {
    const label = document.createElement("label");
    label.className = "layer-row";
    label.dataset.rowLayer = layer.name;
    label.draggable = true;
    label.title = "Drag this row to change its drawing order";
    label.addEventListener("dragstart", (event) => {
      draggedLayer = layer.name;
      label.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", layer.name);
    });
    label.addEventListener("dragover", (event) => {
      if (!draggedLayer || draggedLayer === layer.name) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearLayerDropIndicators();
      const afterTarget = event.clientY > label.getBoundingClientRect().top + label.offsetHeight / 2;
      label.classList.add(afterTarget ? "is-drop-after" : "is-drop-before");
    });
    label.addEventListener("drop", (event) => {
      event.preventDefault();
      const sourceName = draggedLayer || event.dataTransfer.getData("text/plain");
      const afterTarget = event.clientY > label.getBoundingClientRect().top + label.offsetHeight / 2;
      reorderLayer(sourceName, layer.name, afterTarget);
      clearLayerDropIndicators();
    });
    label.addEventListener("dragend", () => {
      draggedLayer = null;
      label.classList.remove("is-dragging");
      clearLayerDropIndicators();
    });
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.layer = layer.name;
    input.checked = layer.visible;
    input.addEventListener("change", updateLayers);
    inputByLayer.set(layer.name, input);
    const swatch = document.createElement("span");
    swatch.className = "layer-swatch";
    swatch.style.background = layer.color;
    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = layer.name;
    label.append(input, swatch, name);
    layerList.append(label);
    rowByLayer.set(layer.name, label);
  });

  function renderSelection() {
    overlay.querySelectorAll(".net-group").forEach((group) => {
      group.classList.toggle("is-active", selectedNets.has(group.dataset.netId));
    });
    netList.querySelectorAll(".net-row").forEach((row) => {
      row.setAttribute("aria-pressed", String(selectedNets.has(row.dataset.netId)));
    });
    partList.querySelectorAll(".part-row").forEach((row) => {
      row.setAttribute("aria-pressed", String(selectedPartIds.has(row.dataset.partId)));
    });
    const selected = nets.filter((net) => selectedNets.has(String(net.code)));
    const selectedParts = [...selectedPartIds].map((id) => parts[Number(id)]).filter(Boolean);
    if (selectedParts.length) {
      const references = selectedParts.map((part) => part.reference);
      const padCount = selectedParts.reduce((total, part) => total + part.pads.length, 0);
      const label = selectedParts.length === 1
        ? `Selected ${references[0]} · ${padCount} pads`
        : `Selected ${selectedParts.length} parts · ${padCount} pads`;
      $("#selection-status").textContent = label;
      $("#selection-status").title = references.join(", ");
      return;
    }
    if (!selected.length) {
      $("#selection-status").textContent = "No net selected";
      $("#selection-status").removeAttribute("title");
      return;
    }
    const pads = selected.reduce((total, net) => total + net.pads.length, 0);
    const tracks = selected.reduce((total, net) => total + net.track_count, 0);
    const vias = selected.reduce((total, net) => total + net.via_count, 0);
    const names = selected.map((net) => net.name).join(", ");
    $("#selection-status").textContent = `${selected.length} net${selected.length === 1 ? "" : "s"} selected · ${pads} pads · ${tracks} tracks · ${vias} vias`;
    $("#selection-status").title = names;
  }

  function renderSelectedPartPads() {
    overlay.querySelector(":scope > .selected-part-pads")?.remove();
    const selectedParts = [...selectedPartIds].map((id) => parts[Number(id)]).filter(Boolean);
    if (!selectedParts.length) return;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "selected-part-pads");
    const layerGroups = new Map();
    selectedParts.forEach((part) => {
      const partBox = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      partBox.setAttribute("class", "selected-part-box");
      partBox.setAttribute("x", part.box.x);
      partBox.setAttribute("y", part.box.y);
      partBox.setAttribute("width", part.box.right - part.box.x);
      partBox.setAttribute("height", part.box.bottom - part.box.y);
      partBox.setAttribute("rx", "0.5");
      group.append(partBox);
    });
    selectedParts.forEach((part) => {
      part.pads.forEach((pad) => {
        pad.layers.forEach((layerName) => {
          let layerGroup = layerGroups.get(layerName);
          if (!layerGroup) {
            layerGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
            layerGroup.setAttribute("class", "selected-part-pad-layer");
            layerGroup.dataset.layer = layerName;
            layerGroups.set(layerName, layerGroup);
            group.append(layerGroup);
          }
          const width = pad.width;
          const height = pad.height;
          let shape;
          if (pad.shape === "circle" || pad.shape === "oval") {
            shape = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
            shape.setAttribute("cx", pad.x);
            shape.setAttribute("cy", pad.y);
            shape.setAttribute("rx", width / 2);
            shape.setAttribute("ry", height / 2);
            if (pad.shape === "oval" && Math.abs(width - height) > 0.001 && pad.angle) {
              shape.setAttribute("transform", `rotate(${-pad.angle} ${pad.x} ${pad.y})`);
            }
          } else {
            shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            shape.setAttribute("x", pad.x - width / 2);
            shape.setAttribute("y", pad.y - height / 2);
            shape.setAttribute("width", width);
            shape.setAttribute("height", height);
            shape.setAttribute("rx", Math.min(width, height) * 0.18);
            shape.setAttribute("transform", `rotate(${-pad.angle} ${pad.x} ${pad.y})`);
          }
          shape.setAttribute("class", "selected-part-pad");
          layerGroup.append(shape);
        });
      });
    });
    overlay.append(group);
    syncStackOrder();
  }

  function choosePart(partId) {
    const id = String(partId);
    if (selectedPartIds.has(id)) selectedPartIds.delete(id);
    else selectedPartIds.add(id);
    renderSelectedPartPads();
    renderSelection();
  }

  function chooseNet(netId) {
    if (selectedNets.has(netId)) selectedNets.delete(netId);
    else selectedNets.add(netId);
    renderSelection();
  }

  function renderNets(filter = "") {
    netList.replaceChildren();
    const query = filter.trim().toLocaleLowerCase();
    const matching = nets.filter((net) => net.name.toLocaleLowerCase().includes(query));
    $("#net-count").textContent = `${matching.length} / ${nets.length}`;
    matching.forEach((net, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "net-row";
      row.dataset.netId = String(net.code);
      row.setAttribute("aria-pressed", String(selectedNets.has(String(net.code))));
      const dot = document.createElement("span");
      dot.className = "net-dot";
      dot.style.background = net.color || ["#ffe066", "#59d8ff", "#ff8f70", "#b7f171", "#d2a6ff", "#ff83c5", "#78f0c7", "#ffb55e"][index % 8];
      const name = document.createElement("span");
      name.className = "net-label";
      name.textContent = net.name || "(unnamed)";
      const meta = document.createElement("span");
      meta.className = "net-meta";
      meta.textContent = `${net.pads.length} pads`;
      row.append(dot, name, meta);
      row.addEventListener("click", () => chooseNet(String(net.code)));
      netList.append(row);
    });
  }

  const partReferenceOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  function renderParts(filter = "") {
    partList.replaceChildren();
    const query = filter.trim().toLocaleLowerCase();
    const matching = parts.map((part, id) => ({ part, id })).filter(({ part }) =>
      part.reference.toLocaleLowerCase().includes(query)
    );
    matching.sort((a, b) => partReferenceOrder.compare(a.part.reference, b.part.reference) || a.id - b.id);
    $("#part-count").textContent = `${matching.length} / ${parts.length}`;
    const rows = document.createDocumentFragment();
    matching.forEach(({ part, id }) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "part-row";
      row.dataset.partId = String(id);
      row.setAttribute("aria-pressed", String(selectedPartIds.has(String(id))));
      row.setAttribute("aria-label", `Select part ${part.reference}${part.value ? `, ${part.value}` : ""}`);
      const reference = document.createElement("span");
      reference.className = "part-reference";
      reference.textContent = part.reference;
      const value = document.createElement("span");
      value.className = "part-value";
      value.textContent = part.value || "";
      row.append(reference, value);
      row.addEventListener("click", () => choosePart(String(id)));
      rows.append(row);
    });
    partList.append(rows);
  }

  updateZoneTransparency();
  zoneTransparencyInput.addEventListener("input", updateZoneTransparency);
  renderNets();
  renderParts();
  layerOrder.forEach((layerName) => layerList.append(rowByLayer.get(layerName)));
  $("#net-search").addEventListener("input", (event) => renderNets(event.target.value));
  $("#part-search").addEventListener("input", (event) => renderParts(event.target.value));
  $("#show-all-layers").addEventListener("click", () => {
    layerList.querySelectorAll("input").forEach((input) => { input.checked = true; });
    updateLayers();
  });
  $("#hide-all-layers").addEventListener("click", () => {
    layerList.querySelectorAll("input").forEach((input) => { input.checked = false; });
    updateLayers();
  });
  $("#add-comment").addEventListener("click", () => {
    setPlacementMode(!placingComment);
  });
  $("#toggle-comment-panel").addEventListener("click", (event) => {
    const panel = $("#comments-panel");
    const open = panel.hidden;
    panel.hidden = !open;
    document.querySelector(".app").classList.toggle("has-comment-panel", open);
    event.currentTarget.setAttribute("aria-expanded", String(open));
    event.currentTarget.setAttribute("aria-pressed", String(open));
  });
  $("#toggle-comments").addEventListener("click", (event) => {
    commentsVisible = !commentsVisible;
    event.currentTarget.textContent = commentsVisible ? "Hide markers" : "Show markers";
    event.currentTarget.setAttribute("aria-pressed", String(commentsVisible));
    renderComments();
  });
  $("#import-comments").addEventListener("click", () => $("#comments-file").click());
  $("#comments-file").addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (imported.format !== "kicad-layout-viewer-comments" || imported.version !== 1 || !Array.isArray(imported.comments)) {
        throw new Error("This file is not a supported KiCad Layout Viewer comments file.");
      }
      if (imported.coordinate_origin && imported.coordinate_origin !== "drill" && imported.coordinate_origin !== "board") {
        throw new Error("This comments file uses an unsupported coordinate origin.");
      }
      if (imported.coordinate_y_axis && imported.coordinate_y_axis !== "up" && imported.coordinate_y_axis !== "down") {
        throw new Error("This comments file uses an unsupported Y axis direction.");
      }
      if (imported.board && imported.board !== data.board && !window.confirm(`This file is for ${imported.board}, while the current board is ${data.board}. Import comments using their millimeter coordinates anyway?`)) return;
      const usesDrillOrigin = imported.coordinate_origin === "drill";
      const yAxisIsUp = imported.coordinate_y_axis === "up";
      const byId = new Map(comments.map((comment) => [comment.id, comment]));
      let skipped = Math.max(0, imported.comments.length - 2000);
      imported.comments.slice(0, 2000).forEach((raw) => {
        if (!raw || typeof raw !== "object") { skipped += 1; return; }
        const x = Number(raw.x);
        const y = Number(raw.y);
        const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 4000) : "";
        if (!Number.isFinite(x) || !Number.isFinite(y) || !text) { skipped += 1; return; }
        const id = typeof raw.id === "string" && raw.id ? raw.id : makeId();
        const status = raw.status === "completed" || raw.status === "rejected" ? raw.status : "open";
        byId.set(id, {
          id,
          x: x + (usesDrillOrigin ? drillOriginBoard.x : 0),
          y: (yAxisIsUp ? -y : y) + (usesDrillOrigin ? drillOriginBoard.y : 0),
          text,
          status,
          created_at: raw.created_at || new Date().toISOString(),
          updated_at: raw.updated_at || null,
        });
      });
      comments.splice(0, comments.length, ...byId.values());
      saveComments();
      renderComments();
      const importedCount = imported.comments.length - skipped;
      $("#selection-status").textContent = `Imported ${importedCount} comment${importedCount === 1 ? "" : "s"}${skipped ? ` · skipped ${skipped} invalid` : ""}`;
    } catch (error) {
      window.alert(error.message || "Could not import comments.");
    }
  });
  $("#export-comments").addEventListener("click", () => {
    const payload = {
      format: "kicad-layout-viewer-comments",
      version: 1,
      board: data.board,
      units: "mm",
      coordinate_origin: "drill",
      coordinate_y_axis: "up",
      comments: comments.map(({ id, x, y, text, status, created_at, updated_at }) => ({
        id,
        x: Number((x - drillOriginBoard.x).toFixed(4)),
        y: Number((drillOriginBoard.y - y).toFixed(4)),
        text,
        status: status || "open",
        created_at,
        updated_at,
      })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${data.board.replace(/[^\w.-]+/g, "_")}.comments.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("#comment-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = $("#comment-text").value.trim();
    if (!text || !draftPoint) return;
    const timestamp = new Date().toISOString();
    if (editingCommentId) {
      const current = comments.find((comment) => comment.id === editingCommentId);
      if (current) Object.assign(current, { text, updated_at: timestamp });
    } else {
      comments.push({ id: makeId(), x: draftPoint.x, y: draftPoint.y, text, status: "open", created_at: timestamp, updated_at: null });
    }
    saveComments();
    $("#comment-dialog").close();
    renderComments();
  });
  $("#cancel-comment").addEventListener("click", () => $("#comment-dialog").close());
  $("#cancel-placement").addEventListener("click", () => setPlacementMode(false));
  $("#delete-comment").addEventListener("click", () => {
    if (!editingCommentId || !window.confirm("Delete this comment?")) return;
    const index = comments.findIndex((comment) => comment.id === editingCommentId);
    if (index >= 0) comments.splice(index, 1);
    saveComments();
    $("#comment-dialog").close();
    renderComments();
  });
  commentOverlay.addEventListener("click", (event) => {
    const marker = event.target.closest("[data-comment-id]");
    if (!marker) return;
    event.stopPropagation();
    const comment = comments.find((item) => item.id === marker.dataset.commentId);
    if (comment) openCommentDialog(null, comment);
  });
  commentOverlay.addEventListener("keydown", (event) => {
    const marker = event.target.closest("[data-comment-id]");
    if (!marker || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    const comment = comments.find((item) => item.id === marker.dataset.commentId);
    if (comment) openCommentDialog(null, comment);
  });
  $("#canvas").addEventListener("click", (event) => {
    if (!placingComment) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = screenToBoard(event.clientX, event.clientY);
    if (point.x < boardBounds.left || point.x > boardBounds.right || point.y < boardBounds.top || point.y > boardBounds.bottom) {
      $("#interaction-hint").textContent = "Place comments within the board outline";
      return;
    }
    setPlacementMode(false);
    openCommentDialog(point);
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && placingComment) setPlacementMode(false);
  });
  $("#flip-board").addEventListener("click", (event) => {
    const inputs = inputByLayer;
    const seen = new Set();
    inputs.forEach((input, name) => {
      const match = name.match(/^([FB])\.(.+)$/);
      if (!match || seen.has(name)) return;
      const otherName = `${match[1] === "F" ? "B" : "F"}.${match[2]}`;
      const other = inputs.get(otherName);
      if (!other) return;
      const checked = input.checked;
      input.checked = other.checked;
      other.checked = checked;
      seen.add(name);
      seen.add(otherName);
    });
    bottomView = !bottomView;
    const flippedOrder = layerOrder.map(oppositeSideLayer);
    layerOrder.splice(0, layerOrder.length, ...flippedOrder);
    layerOrder.forEach((layerName) => layerList.append(rowByLayer.get(layerName)));
    stack.classList.toggle("is-bottom-view", bottomView);
    syncCommentMarkerText();
    event.currentTarget.setAttribute("aria-pressed", String(bottomView));
    event.currentTarget.textContent = bottomView ? "View top" : "View bottom";
    event.currentTarget.title = bottomView ? "Return to the top side" : "Flip the board to view from the bottom";
    updateLayers();
  });
  overlay.addEventListener("click", (event) => {
    // Give an already selected net first chance across all visible copper
    // layers. A filled zone on an upper layer can otherwise intercept clicks
    // meant to clear a selected track underneath it.
    const screenPoint = new DOMPoint(event.clientX, event.clientY);
    const selectedGroups = [...overlay.querySelectorAll(".net-group.is-active")].reverse();
    for (const selectedGroup of selectedGroups) {
      const layer = selectedGroup.closest(".net-layer");
      if (layer?.classList.contains("layer-hidden")) continue;
      const geometries = [...selectedGroup.querySelectorAll(".net-highlight, .pad-highlight")].reverse();
      for (const geometry of geometries) {
        if (geometryHitAtScreenPoint(geometry, screenPoint)) {
          chooseNet(selectedGroup.dataset.netId);
          return;
        }
      }
    }
    const partTarget = event.target.closest(".part-hit");
    if (partTarget && choosePartAtPoint(partTarget, screenPoint)) {
      return;
    }
    const zoneTarget = event.target.closest(".zone-highlight");
    if (zoneTarget) {
      resolveZoneClickStack(event, zoneTarget, screenPoint);
      return;
    }
    const group = event.target.closest("[data-net-id]");
    if (group) chooseNet(group.dataset.netId);
  });
  overlay.addEventListener("keydown", (event) => {
    const partTarget = event.target.closest(".part-hit");
    if (!partTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    choosePart(partTarget.dataset.partId);
  });

  $("#fit-board").addEventListener("click", () => { viewBox = [...originalViewBox]; syncViewBox(); });
  $("#reset-view").addEventListener("click", () => {
    viewBox = [...originalViewBox];
    syncViewBox();
    setPlacementMode(false);
    bottomView = false;
    stack.classList.remove("is-bottom-view");
    const flipButton = $("#flip-board");
    flipButton.setAttribute("aria-pressed", "false");
    flipButton.textContent = "View bottom";
    flipButton.title = "Flip the board to view from the bottom";
    inputByLayer.forEach((input, name) => { input.checked = initialLayerVisibility.get(name) || false; });
    layerOrder.splice(0, layerOrder.length, ...initialLayerOrder);
    layerOrder.forEach((layerName) => layerList.append(rowByLayer.get(layerName)));
    selectedNets.clear();
    selectedPartIds.clear();
    renderSelectedPartPads();
    renderSelection();
    zoneTransparencyInput.value = String(initialZoneTransparency);
    updateZoneTransparency();
    updateLayers();
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const screenX = (event.clientX - rect.left) / rect.width;
    // Bottom view mirrors the board stack, so map the cursor back to board-space X.
    const px = bottomView ? 1 - screenX : screenX;
    const py = (event.clientY - rect.top) / rect.height;
    const factor = event.deltaY < 0 ? 0.86 : 1.16;
    const nextWidth = viewBox[2] * factor;
    const nextHeight = viewBox[3] * factor;
    viewBox[0] += (viewBox[2] - nextWidth) * px;
    viewBox[1] += (viewBox[3] - nextHeight) * py;
    viewBox[2] = nextWidth;
    viewBox[3] = nextHeight;
    syncViewBox();
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    if (placingComment) return;
    if (event.button !== 2) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const rect = stack.getBoundingClientRect();
    const scale = Math.min(rect.width / viewBox[2], rect.height / viewBox[3]);
    if (!scale) return;
    const deltaX = event.clientX - pointer.x;
    const deltaY = event.clientY - pointer.y;
    viewBox[0] += (bottomView ? 1 : -1) * deltaX / scale;
    viewBox[1] -= deltaY / scale;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    syncViewBox();
  });
  canvas.addEventListener("pointerup", () => { pointer = null; });
  canvas.addEventListener("pointercancel", () => { pointer = null; });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  syncViewBox();
  renderComments();
  updateLayers();
  applyViewerTheme(lightTheme);
})();
