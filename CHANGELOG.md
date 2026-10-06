# Changelog

## Unreleased

### Added

- Added a **Clear highlights** control to clear selected nets and parts together.
- Added part-side metadata to exports so part hit testing and pad highlights can follow the viewed side of the board.
- Added a version label to the viewer credit and replaced the text mark with a custom circuit-style logo.
- Added full net names on hover and sorted nets by name, with unconnected nets at the end.
- Added dragging to move comment markers, while keeping their size consistent on screen as the board is zoomed.

### Changed

- Updated bottom-side viewing so selected part pads remain visible and use a distinct blue shade. Hidden-side parts no longer take priority over visible board objects; opposite-side parts remain selectable when no visible object is hit.
- Made the initial view use the same fitted framing as **Fit** and **Reset**, with a small margin. Zooming now derives its anchor through the SVG screen transform for more accurate cursor-centered zoom.
- Corrected comment coordinate conversions to account for the exported SVG coordinate offset; exported comment coordinates remain relative to the drill origin with Y positive upwards.
- Increased board name and revision/date prominence, set status-bar text to 14px, and inverted the marker visibility button's pressed state.
- Shifted the front copper layer color toward orange and added a different highlight color for selected bottom-side parts.
- Removed the light-theme option.
- Updated the README to describe the net sorting, bottom-side part selection, clearing highlights, and draggable comments.

### Export data

- Added viewer version, SVG coordinate offset, part side, and unconnected-pad data to generated viewer documents.
