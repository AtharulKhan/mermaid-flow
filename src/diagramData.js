export const DEFAULT_CODE = `flowchart LR
    A[Brief] --> B{Scope}
    B -->|V1| C[Prototype]
    B -->|V2| D[Milestone Plan]
    C --> E((Review))
    D --> E
`;

export const DIAGRAM_LIBRARY = [
  {
    id: "flowchart",
    label: "Flowchart",
    keyword: "flowchart",
    starter: `flowchart LR
    Start([Start]) --> Input[/Capture Input/]
    Input --> Decision{Valid?}
    Decision -- Yes --> Action[Process]
    Decision -- No --> Retry[Fix Input]
    Retry --> Input
    Action --> End((Done))
`,
    quickTools: [
      { label: "Add node", snippet: '\n    N1["New Node"]\n' },
      { label: "Add decision", snippet: "\n    Gate{Decision}\n" },
      { label: "Add edge", snippet: "\n    N1 --> N2\n" },
      { label: "Add subgraph", snippet: "\n    subgraph Stage\n      X[Task]\n    end\n" },
    ],
  },
  {
    id: "sequenceDiagram",
    label: "Sequence",
    keyword: "sequenceDiagram",
    starter: `sequenceDiagram
    participant User
    participant App
    participant API
    User->>App: Submit change
    App->>API: Validate + persist
    API-->>App: Success
    App-->>User: Updated preview
`,
    quickTools: [
      { label: "Add participant", snippet: "\n    participant Service\n" },
      { label: "Send message", snippet: "\n    App->>Service: Request\n" },
      { label: "Add alt block", snippet: "\n    alt Valid\n      App-->>User: Continue\n    else Invalid\n      App-->>User: Error\n    end\n" },
    ],
  },
  {
    id: "gantt",
    label: "Gantt",
    keyword: "gantt",
    starter: `gantt
    title Product Launch Sprint
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d

    section Build
    Setup editor shell      :done, setup, 2026-02-10, 2d
    Node + edge controls    :active, controls, after setup, 3d

    section QA
    Internal review         :qa, after controls, 2d
    Ship                    :milestone, ship, after qa, 0d
`,
    quickTools: [
      { label: "Add section", snippet: "\n    section New Section\n" },
      { label: "Add task", snippet: "\n    New Task :task1, 2026-02-15, 3d\n" },
      { label: "Add milestone", snippet: "\n    Launch :milestone, launch, 2026-02-20, 0d\n" },
    ],
  },
  {
    id: "erDiagram",
    label: "ER Diagram",
    keyword: "erDiagram",
    starter: `erDiagram
    USER ||--o{ PROJECT : owns
    PROJECT ||--o{ TASK : contains
    USER {
      string id
      string email
    }
    TASK {
      string id
      string title
      string status
    }
`,
    quickTools: [
      { label: "Add entity", snippet: "\n    TEAM {\n      string id\n      string name\n    }\n" },
      { label: "Add relationship", snippet: "\n    TEAM ||--o{ USER : includes\n" },
    ],
  },
  {
    id: "classDiagram",
    label: "Class Diagram",
    keyword: "classDiagram",
    starter: `classDiagram
    class DiagramDoc {
      +String id
      +String title
      +render()
    }
    class ElementPatcher {
      +apply()
    }
    DiagramDoc --> ElementPatcher
`,
    quickTools: [
      { label: "Add class", snippet: "\n    class NewClass {\n      +String id\n    }\n" },
      { label: "Add relationship", snippet: "\n    NewClass <|-- DiagramDoc\n" },
    ],
  },
  {
    id: "stateDiagram",
    label: "State Diagram",
    keyword: "stateDiagram-v2",
    starter: `stateDiagram-v2
    [*] --> Idle
    Idle --> Editing : paste
    Editing --> Rendering : render
    Rendering --> Idle : success
    Rendering --> Error : failure
    Error --> Editing : retry
`,
    quickTools: [
      { label: "Add state", snippet: "\n    Review --> Published\n" },
      { label: "Add note", snippet: "\n    note right of Error\n      Show parser diagnostics\n    end note\n" },
    ],
  },
  { id: "journey", label: "User Journey", keyword: "journey", starter: `journey
    title Visual edit flow
    section Authoring
      Paste Mermaid: 5: User
      Use quick tools: 4: User
    section Output
      Download SVG: 5: User
      Share embed: 3: User
` },
  { id: "mindmap", label: "Mindmap", keyword: "mindmap", starter: `mindmap
  root((Mermaid Flow))
    Input
      Paste Code
      Quick Tools
    Output
      SVG
      PNG
` },
  { id: "timeline", label: "Timeline", keyword: "timeline", starter: `timeline
    title Mermaid Flow Milestones
    2026 Q1 : Editor shell
            : Quick tools
    2026 Q2 : Expanded diagram support
` },
  { id: "pie", label: "Pie", keyword: "pie", starter: `pie title Diagram Mix
    "Flowchart" : 40
    "Sequence" : 30
    "Gantt" : 15
    "Other" : 15
` },
  { id: "gitGraph", label: "Git Graph", keyword: "gitGraph", starter: `gitGraph
    commit id: "Init"
    branch feature/editor
    checkout feature/editor
    commit id: "Build preview"
    checkout main
    merge feature/editor
` },
  { id: "requirementDiagram", label: "Requirement", keyword: "requirementDiagram", starter: `requirementDiagram
    requirement req1 {
      id: 1
      text: Editor must render quickly
      risk: medium
      verifymethod: test
    }
` },
  { id: "C4", label: "C4", keyword: "C4Context", starter: `C4Context
    title Mermaid Flow Context
    Person(dev, "Diagram Author")
    System(app, "Mermaid Flow", "Visual editor for Mermaid syntax")
    Rel(dev, app, "Uses")
` },
  { id: "sankey", label: "Sankey", keyword: "sankey-beta", starter: `sankey-beta
    Source,Editor,8
    Editor,SVG,5
    Editor,PNG,3
` },
  { id: "quadrantChart", label: "Quadrant", keyword: "quadrantChart", starter: `quadrantChart
    title Feature Prioritization
    x-axis Low effort --> High effort
    y-axis Low impact --> High impact
    quadrant-1 Fast Wins
    quadrant-2 Strategic Bets
    quadrant-3 Ignore
    quadrant-4 Expensive Low Value
    "Quick Tools": [0.18, 0.86]
    "All-diagram drag-drop": [0.92, 0.42]
` },
  { id: "xychart", label: "XY Chart", keyword: "xychart-beta", starter: `xychart-beta
    title "Render Latency"
    x-axis [Mon, Tue, Wed, Thu, Fri]
    y-axis "ms" 0 --> 800
    line [720, 560, 430, 410, 380]
` },
  { id: "block", label: "Block Diagram", keyword: "block-beta", starter: `block-beta
    columns 3
    A["Code"]
    B["Parser"]
    C["Renderer"]
` },
  { id: "architecture", label: "Architecture", keyword: "architecture-beta", starter: `architecture-beta
    group app(cloud)[Mermaid Flow]
    service editor(server)[Editor] in app
    service preview(server)[Renderer] in app
    editor:R --> L:preview
` },
  { id: "treemap", label: "Treemap", keyword: "treemap-beta", starter: `treemap-beta
    root[Diagram Types]
      Flowchart[40]
      Sequence[30]
      Gantt[10]
      Other[20]
` },
  { id: "packet", label: "Packet", keyword: "packet-beta", starter: `packet-beta
    0-3: version
    4-7: flags
    8-15: payload_length
` },
  { id: "radar", label: "Radar", keyword: "radar-beta", starter: `radar-beta
    title Capability Coverage
    axis Render
    axis Parse
    axis Tools
    axis Export
    curve Product [9, 8, 7, 8]
` },
];

export function classifyDiagramType(rawType = "") {
  const normalized = rawType.toLowerCase();
  if (normalized.includes("flow") || normalized === "graph") return "flowchart";
  if (normalized.includes("sequence") || normalized.includes("zenuml")) return "sequenceDiagram";
  if (normalized.includes("gantt")) return "gantt";
  if (normalized.includes("requirement")) return "requirementDiagram";
  if (normalized.includes("erdiagram") || normalized === "er") return "erDiagram";
  if (normalized.includes("class")) return "classDiagram";
  if (normalized.includes("state")) return "stateDiagram";
  if (normalized.includes("mindmap")) return "mindmap";
  if (normalized.includes("pie")) return "pie";
  if (normalized.includes("timeline")) return "timeline";
  if (normalized.includes("journey")) return "journey";
  if (normalized.includes("git")) return "gitGraph";
  if (normalized.includes("c4")) return "C4";
  if (normalized.includes("sankey")) return "sankey";
  if (normalized.includes("quadrant")) return "quadrantChart";
  if (normalized.includes("xy")) return "xychart";
  if (normalized.includes("block")) return "block";
  if (normalized.includes("architecture")) return "architecture";
  if (normalized.includes("treemap")) return "treemap";
  if (normalized.includes("packet")) return "packet";
  if (normalized.includes("radar")) return "radar";
  return "generic";
}
