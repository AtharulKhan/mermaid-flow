# Mermaid Flow

Mermaid Flow is a client-only visual Mermaid editor: paste Mermaid code, preview it in a sandboxed iframe, click rendered elements, patch labels, and export.

## What is implemented

- Split interface: code editor + rendered preview + quick tools/properties.
- Sandboxed iframe rendering via Mermaid JS (`postMessage` bridge).
- Parse + diagram-type detection from Mermaid parse result.
- Diagram-aware quick snippets (Flowchart, Sequence, Gantt, ER, Class, State).
- Starter templates for many Mermaid types (Flowchart, Sequence, Gantt, ER, Journey, Mindmap, Timeline, Pie, GitGraph, Requirement, C4, Sankey, XY, Block, Architecture, Treemap, Packet, Radar).
- Selection flow: click an element in preview, then patch its label in code.
- Export actions: copy Mermaid code, copy iframe embed snippet, download SVG, download PNG.
- Theme/security/layout controls (`theme`, `securityLevel`, `dagre`/`elk` for flowcharts).

## Run locally

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

## Notes

- This is intentionally backend-free and account-free.
- For untrusted Mermaid input, keep `securityLevel` on `strict` or `sandbox`.
- Visual drag-to-manual-layout is not supported in v1 (Mermaid layout engines control positioning).
