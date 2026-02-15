# Design Document: Custom HTML/CSS Diagram Renderers

## Overview

MermaidFlow uses Mermaid.js as the source of truth for diagram definitions. Users write and edit Mermaid syntax in a code editor, and the app renders the visual output. For some diagram types (ER, sequence, class, state), Mermaid's built-in SVG renderer works well. For **Gantt charts** and **Flowcharts**, we bypass Mermaid's SVG renderer entirely and use custom HTML/CSS renderers instead.

## Why Not Mermaid's Gantt SVG?

Mermaid renders Gantt charts as flat SVG with absolute-positioned `<rect>` and `<text>` elements. This creates several problems for an interactive editor:

1. **No sticky headers or columns.** SVG has no equivalent of `position: sticky`. Scrolling a large Gantt chart loses context immediately because the timeline header and role labels scroll off-screen.

2. **Alignment fragility.** Mermaid's SVG layout uses internal heuristics to position bars, section labels, and axis ticks. Layering interactive HTML overlays (role column, month/week headers, tooltips) on top of the SVG requires pixel-perfect reverse engineering of those heuristics, which breaks across Mermaid versions and edge cases.

3. **Bar sizing issues.** Mermaid's SVG bars often render as tiny squares or inconsistent shapes when tasks have short durations or when the overall date range is large. The SVG viewBox scaling compounds this.

4. **Section label overlap.** Mermaid renders section names as large rotated text that overlaps bar content in the SVG. There's no clean way to suppress or relocate these without forking Mermaid.

5. **Limited interactivity.** SVG elements don't support CSS hover states, overflow handling, or drag behavior as cleanly as HTML `<div>` elements.

## Architecture

### Data Flow

```
Mermaid Code (source of truth)
        |
        v
mermaid.parse()       -- syntax validation only, no SVG output
        |
        v
parseGanttTasks()     -- extracts structured task objects from Mermaid syntax
        |
        v
renderCustomGantt()   -- builds HTML/CSS grid layout inside the iframe
        |
        v
Interactive HTML Gantt -- click, drag, right-click handlers send messages to React
        |
        v
React handlers        -- update Mermaid code using ganttUtils mutation functions
        |
        v
Re-render             -- code change triggers postRender() -> renderCustomGantt()
```

### Key Principle: Mermaid Code Stays the Source of Truth

All user interactions (dragging bars, editing in the modal, inserting tasks, toggling status) modify the **Mermaid code string**. The code editor reflects the changes. The renderer reads the code, parses it, and rebuilds the visual. There is no separate data model. This means:

- Copy-pasting the Mermaid code into any Mermaid renderer produces the same chart
- Undo/redo works at the code level
- The code editor and the visual chart are always in sync

## Parsing: `ganttUtils.js`

The `parseGanttTasks(code)` function handles all Mermaid Gantt syntax variants:

- **Sections**: `section Phase 1 - Infrastructure` becomes the section/category grouping
- **Status tokens**: `done`, `active`, `crit` (and combinations) are parsed into `statusTokens[]`
- **Task IDs**: Optional identifier tokens before the date
- **Dates**: ISO format (`2026-02-15`), supports both start date and explicit end date
- **Durations**: `3d`, `2w`, `1m` format, converted to days
- **Metadata comments**: `%% assignee: John` and `%% notes: ...` on lines after a task

The parser returns an array of task objects with all positional indices needed for mutation. This means `updateGanttTask()`, `deleteGanttTask()`, and `insertGanttTaskAfter()` can reconstruct valid Mermaid syntax after any edit.

## Rendering: Custom HTML/CSS

### Layout: CSS Grid

The Gantt chart uses a CSS grid with two column tracks:

```
grid-template-columns: [role-column] [timeline]
```

- **Role column** (left, sticky): Shows section/category names. Uses `position: sticky; left: 0` so it stays visible during horizontal scrolling.
- **Timeline** (right, scrollable): Contains the timeline header rows and task bar tracks.

### Headers: Sticky Month/Week Rows

The timeline header uses `position: sticky; top: 0` with two sub-rows:

1. **Month row**: Each cell spans the number of days in that month, proportionally sized
2. **Week row** (visible in week scale): Each cell spans 7 days

A corner cell sits at the top-left intersection, sticky in both axes (`left: 0; top: 0`), labeled "Category / Phase".

### Bars: Absolute Positioning

Within each section's track `<div>`, bars are absolutely positioned:

- `left`: `(taskStartMs - timelineStartMs) / dayMs * pxPerDay`
- `width`: `durationDays * pxPerDay`
- `top`: `rowIndex * rowHeight + gap`

This gives pixel-precise alignment with the header grid without relying on any SVG layout engine.

### Scale Modes

- **Week scale**: `pxPerDay = 22` -- higher density, shows week labels, good for 1-3 month views
- **Month scale**: `pxPerDay = 12` -- lower density, hides week row, good for 3-12 month views

### Bar Colors

Bars are colored by their Mermaid status tokens:

| Status | Class | Color |
|--------|-------|-------|
| (default) | `mf-bar-default` | Indigo `#6366f1` |
| `active` | `mf-bar-active` | Blue `#3b82f6` |
| `done` | `mf-bar-done` | Green `#22c55e` |
| `crit` | `mf-bar-crit` | Red `#ef4444` |
| `active, crit` | `mf-bar-activeCrit` | Dark red `#dc2626` |
| `done, crit` | `mf-bar-doneCrit` | Dark green `#16a34a` |

### Narrow Bars

Bars narrower than 70px receive the `mf-bar-narrow` class. These bars show their label text overflowing to the right of the bar with a dark color and white text shadow, ensuring readability even for very short-duration tasks.

### Interactive Behaviors

All interactions communicate via `postMessage` between the iframe and the React parent:

- **Click bar**: `element:selected` with label, section, task data
- **Right-click bar**: `element:context` with coordinates and task data
- **Drag bar**: `gantt:dragged` with deltaX, bar width, drag mode (move/resize-start/resize-end)
- **Insert button (+)**: `gantt:add-between` with position and section context

## Design Decisions

### Why an iframe?

Mermaid's CSS can conflict with the app's styles. The iframe provides complete style isolation. The custom Gantt renderer lives inside the same iframe, reusing its style block and message channel.

### Why not a React component for the Gantt?

The Gantt renderer runs inside the iframe's vanilla JS context. Using React inside the iframe would require bundling React twice and adding complexity. The vanilla DOM approach is simple, fast, and avoids framework overhead for what is essentially a drawing operation.

### Why CSS Grid over HTML `<table>`?

CSS Grid provides sticky positioning that `<table>` doesn't support without hacks. Grid also allows the role column and timeline to be independently sized and scrolled.

### Why parse Mermaid ourselves instead of using Mermaid's API?

Mermaid's `ganttDb` API is internal and undocumented. It changes between versions without notice. Our parser (`parseGanttTasks`) reads the raw Mermaid syntax directly, which is stable because it's the user-facing format. We also need line indices and token positions for code mutation, which Mermaid's API doesn't expose.

---

# Custom HTML/CSS Flowchart Renderer

## Why Not Mermaid's Flowchart SVG?

Mermaid renders flowcharts as SVG with absolute-positioned `<g>` groups containing `<rect>`, `<polygon>`, and `<text>` elements. For an interactive editor this has limitations:

1. **Limited styling control.** SVG elements don't support CSS `box-shadow`, `backdrop-filter`, complex `border-radius` variants, or `clip-path` as cleanly as HTML divs. Getting a "modern card-like" appearance for nodes requires extensive SVG attribute manipulation.

2. **Interaction complexity.** SVG click/drag handlers require coordinate transforms through nested `<g>` transforms. HTML pointer events on absolutely-positioned divs are simpler and more predictable.

3. **Text layout.** SVG `<text>` doesn't support word-wrap, text-overflow, or inline HTML. Mermaid pre-computes text layout, but we lose control over how multi-line labels render.

4. **Tight coupling.** Layering custom HTML overlays (edge labels, port indicators, toolbars) on top of Mermaid's SVG requires reverse-engineering its coordinate system, which breaks across versions.

## Architecture

### Data Flow

```
Mermaid Code (source of truth)
        |
        v
mermaid.parse()             -- syntax validation only, no SVG output
        |
        v
parseFlowchart()            -- extracts { direction, nodes[], edges[], subgraphs[] }
parseClassDefs()            -- extracts classDef name → { fill, stroke, color }
parseClassAssignments()     -- maps nodeId → className
        |
        v
dagre.layout()              -- graph layout engine (loaded via CDN)
        |
        v
renderCustomFlowchart()     -- builds HTML nodes + SVG edge paths
        |
        v
Interactive HTML Flowchart  -- click, drag, right-click, connect handlers → postMessage
        |
        v
React handlers              -- update Mermaid code using flowchartUtils mutation functions
        |
        v
Re-render                   -- code change triggers postRender() → renderCustomFlowchart()
```

### Layout Engine: dagre

Flowcharts require a directed graph layout algorithm (unlike Gantt charts, where layout is just a timeline). We use **dagre** (`@dagrejs/dagre`), the same engine Mermaid uses internally, loaded via CDN (`esm.sh`).

dagre computes:
- **Node positions** (x, y center coordinates) based on rank direction and spacing
- **Edge control points** for routing paths between nodes
- **Compound graph support** for subgraphs (dagre groups child nodes within a parent bounding box)

Configuration: `rankdir` from Mermaid's direction (TB, LR, RL, BT), `nodesep: 50`, `ranksep: 60`.

### Node Measurement

dagre needs node dimensions before layout. We measure each node's content by:
1. Creating a hidden DOM element with the node's CSS class and label content
2. Reading `offsetWidth`/`offsetHeight`
3. Adjusting for shape-specific padding (diamonds need diagonal, circles need square, hexagons need extra width)

### Node Rendering: HTML Divs

Each node is an absolutely-positioned `<div>` with a shape-specific CSS class:

| Mermaid Shape | CSS Class | Technique |
|---|---|---|
| `[text]` rect | `.mf-shape-rect` | `border-radius: 4px` |
| `(text)` rounded | `.mf-shape-rounded` | `border-radius: 12px` |
| `([text])` stadium | `.mf-shape-stadium` | `border-radius: 9999px` |
| `{text}` diamond | `.mf-shape-diamond` | `clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)` |
| `((text))` circle | `.mf-shape-circle` | `border-radius: 50%` |
| `{{text}}` hexagon | `.mf-shape-hexagon` | `clip-path: polygon(...)` |
| `[[text]]` subroutine | `.mf-shape-subroutine` | `box-shadow: inset` for double borders |
| `[(text)]` cylinder | `.mf-shape-cylinder` | Elliptical `border-radius: 50%/12%` |
| `[/text/]` parallelogram | `.mf-shape-parallelogram` | `transform: skewX(-10deg)` |
| `[/text\]` trapezoid | `.mf-shape-trapezoid` | `clip-path: polygon(...)` |

For clip-path shapes (diamond, hexagon, trapezoid), CSS `border` is invisible. A background border layer div provides the visual border effect.

### Edge Rendering: SVG Overlay

Edges render as SVG `<path>` elements in a transparent overlay `<svg>` positioned on top of the HTML container. This is standard practice for HTML-based graph libraries (React Flow, Cytoscape).

- **Path computation**: dagre provides edge control points; we render them as line segments or cubic bezier curves during drag updates
- **Arrow markers**: SVG `<marker>` elements with triangular arrowheads
- **Edge styles**: Solid (`-->`), dashed (` -.-> `), thick (`==>`), no-arrow (`---`)
- **Edge labels**: SVG `<text>` at the midpoint with a rounded background `<rect>`
- **Hit area**: Invisible wide `<path>` (14px stroke) for easier click targeting

### Node Colors: classDef

Mermaid's `classDef` directive defines custom styles:
```
classDef monthlyClass fill:#fef3c7,stroke:#f59e0b,stroke-width:3px,color:#000
```

The parser extracts these into `{ fill, stroke, strokeWidth, color }` objects. The renderer applies them as inline styles on the HTML div, overriding the default white background.

### Subgraphs

dagre supports compound graphs. Subgraph nodes are rendered as dashed-border background divs behind their child nodes, with a floating label positioned above.

### Interactive Behaviors

All interactions send the same `postMessage` payloads as the SVG-based renderer, so the React parent's handlers require zero changes:

- **Click node** → `element:selected` with `{ label, nodeId, elementType: "node", screenBox }`
- **Right-click node** → `element:context` with coordinates
- **Click edge** → `element:selected` with `{ elementType: "edge", edgeSource, edgeTarget }`
- **Drag node** → updates position live, recomputes connected edge paths, sends `element:dragged`
- **Port indicators** → `+` circles appear on hover at node edges, click sends `port:clicked`
- **Connect mode** → crosshair cursor, click target node sends `connect:complete`

### Position Overrides

When a user drags a node, the delta is stored in `positionOverrides[nodeId] = { dx, dy }`. On re-render, the renderer applies these offsets to dagre's computed positions, preserving the user's manual adjustments.

## Shared Design Language

Both the Gantt and Flowchart renderers share a consistent visual language:

- **Font**: Manrope, system-ui, sans-serif at 13px
- **Node elevation**: `box-shadow: 0 2px 8px rgba(0,0,0,0.08)`
- **Border radius**: 12px on containers, 4-12px on nodes (shape-dependent)
- **Selection**: `outline: 2.5px solid #2563eb; outline-offset: 2px` with blue glow
- **Hover**: Enhanced shadow + brightness filter
- **Transitions**: 0.12s ease on shadows and filters
- **Colors**: Tailwind CSS palette (slate, indigo, blue, green, red)

---

## File Structure

| File | Role |
|------|------|
| `src/App.jsx` | React component + iframe HTML/CSS/JS (single file architecture) |
| `src/flowchartUtils.js` | Mermaid flowchart parsing and node/edge mutation utilities |
| `src/ganttUtils.js` | Mermaid Gantt parsing and code mutation utilities |
| `src/diagramData.js` | Diagram templates and type classification |
| `src/styles.css` | React app styles (not iframe styles) |
