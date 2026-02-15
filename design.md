# Design Document: Custom HTML/CSS Gantt Renderer

## Overview

MermaidFlow uses Mermaid.js as the source of truth for diagram definitions. Users write and edit Mermaid syntax in a code editor, and the app renders the visual output. For most diagram types (flowchart, ER, sequence, class, state), Mermaid's built-in SVG renderer works well. For Gantt charts, we bypass Mermaid's SVG renderer entirely and use a custom HTML/CSS renderer instead.

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

## File Structure

| File | Role |
|------|------|
| `src/App.jsx` | React component + iframe HTML/CSS/JS (single file architecture) |
| `src/ganttUtils.js` | Mermaid Gantt parsing and code mutation utilities |
| `src/diagramData.js` | Diagram templates and type classification |
| `src/styles.css` | React app styles (not iframe styles) |
