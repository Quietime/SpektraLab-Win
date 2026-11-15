# Light table

The LightTable is a local, non-destructive photo board. It stores photo paths and layout metadata only; it does not change source photographs or duplicate their pixels. A selected frame uses the editor canvas output, including its crop and colour work. Other frames are marked as camera previews until opened in the editor.

Open it from the compact grid button in the desktop top bar or the LightTable button in the Android bottom bar. The full-screen board supports multiple named trays, a pending-photo shelf, card placement, drag movement, two-finger move/scale/rotate, stage-aware tiling, lamp brightness, sleeves, loupe magnification, slideshow, and fullscreen. Escape or Android Back exits the slideshow first, then closes the board. F11 toggles fullscreen.

Each tray holds up to 2,000 photo references, with 48 cards placed on the stage at once. The shelf pages through 60 pending photos at a time, and the document holds up to 32 trays. Tiling uses the stage's current pixel dimensions and keeps each card inside its grid cell.

Persistence is handled by `model.ts`: a compact index references bounded metadata chunks in the `LightTable` store. A write error remains visible in the board and can be retried. Chunk cleanup uses the narrow `store_delete` adapter; only generated `tray-…-photos|cards-…-N.json` names in the LightTable area are accepted. The index and chunks contain no image bytes or edit recipes.

The current editor output is rendered at up to 4,096 pixels on its long edge while the board is open. The board retains at most six processed output object URLs; camera previews continue through the existing bounded-concurrency thumbnail service. Drag writes are coalesced with `requestAnimationFrame` and the model's persistence debounce.
