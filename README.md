# KiCad Layout Viewer

KiCad PCB Editor action plugin that exports a board to one self-contained HTML file. The page includes each layer as KiCad-rendered SVG, independent layer visibility controls, and a searchable net list. Selecting a net highlights its pads, tracks, and vias on the visible copper layers. The HTML opens locally in a current desktop browser without a server or external assets.

## Requirements

- KiCad 9 or 10, including PCB Editor and `kicad-cli`
- A saved `.kicad_pcb` board

## Install

1. Copy the complete `src/kicad_layout_viewer` folder into KiCad's plugin directory. Keep `__init__.py`, `plugin.py`, and `assets` together.
2. On Windows with KiCad 10, one valid location is `%USERPROFILE%\Documents\KiCad\10.0\3rdparty\plugins\kicad_layout_viewer`. The documented user scripting path is `%USERPROFILE%\Documents\KiCad\10.0\scripting\plugins\kicad_layout_viewer`.
3. For KiCad 9, replace `10.0` with `9.0`.
4. Restart PCB Editor, open a saved board, and choose **Tools > External Plugins > Export interactive HTML layout**.
5. Choose the output `.html` path.

Common scripting plugin locations:

- Windows: `%USERPROFILE%\Documents\KiCad\<version>\scripting\plugins`
- Linux: `~/.local/share/kicad/<version>/scripting/plugins`
- macOS: `~/Documents/KiCad/<version>/scripting/plugins`

KiCad also searches its configured third-party plugin directory at `$KICAD_3RD_PARTY/plugins` (on Windows this is commonly under `%USERPROFILE%\Documents\KiCad\<version>\3rdparty\plugins`). Each plugin should be installed as its own folder containing `__init__.py`.

If `kicad-cli` is not on `PATH`, the plugin also checks the KiCad installation's `bin` folder.

## Viewer features

- Independent show/hide controls for exported board layers, including copper, mask, paste, silkscreen, courtyard, and user layers. F.Fab and B.Fab are omitted from the viewer.
- Artwork on each layer uses the matching color shown in the layer list.
- Displays the board's KiCad title-block revision and issue date in the top bar when those fields are set.
- Searchable net list sorted by name, with unconnected pads last; long net names show in full on hover.
- Multi-select nets from the list or by clicking highlighted pads, tracks, and zones; each selected net uses its own color across visible copper pads, tracks, vias, and filled zones.
- Sensible default drawing order, with silkscreen and board outlines above copper; drag layer rows to change the order. The first row draws on top.
- Bottom-side viewing that mirrors the board, swaps front/back layer visibility, flips the layer order list, and keeps part pad highlights on the viewed side.
- Part hitboxes only participate on the viewed board side, so hidden-side parts do not intercept zones.
- **Clear highlights** clears selected nets and parts together.
- A scrollable comments panel on the right, toggled by **Comments**, with coordinate-anchored notes that can be added, edited, deleted, hidden, imported, and exported as JSON.
- Click **Comments > Add comment**, then click a board location to place a note. Press Esc or click Cancel to stop. Drag a numbered marker to move it; click a marker or panel entry to edit or delete it.
- Import and export comments through the panel. The JSON file uses PCB millimeters and imports merge by comment ID, so repeated imports do not duplicate notes.
- Transparent drill holes on non-copper layers, so holes do not render as black disks.
- Pan, zoom, fit, and reset controls.

KiCad SVG artwork is retained for each layer. Net highlights cover pads, vias, straight tracks, routed arcs, and filled copper zones. The viewer is an inspection aid and does not replace KiCad connectivity or design-rule checks.

## Repository layout

```text
src/kicad_layout_viewer/
  __init__.py
  plugin.py
  assets/
    viewer.html
    viewer.css
    viewer.js
```
