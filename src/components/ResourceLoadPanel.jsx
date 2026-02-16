import { useMemo, useState } from "react";
import { computeResourceLoad } from "../ganttUtils";

export default function ResourceLoadPanel({ tasks, onClose }) {
  const [expandedPerson, setExpandedPerson] = useState(null);

  const resourceData = useMemo(() => computeResourceLoad(tasks), [tasks]);

  const hasAnyAssignees = resourceData.length > 0;
  const overloadedCount = resourceData.filter(
    (r) => r.overloadedWeeks.length > 0
  ).length;

  const formatWeekLabel = (weekStart) => {
    const d = new Date(weekStart + "T00:00:00Z");
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  };

  return (
    <div className="resource-panel">
      <div className="resource-panel-header">
        <h3>Resource Load</h3>
        <button className="saved-item-delete" onClick={onClose}>
          &times;
        </button>
      </div>

      {!hasAnyAssignees && (
        <p className="resource-empty">
          No assignees found. Add <code>%% assignee: Name</code> metadata below
          tasks to track resource load.
        </p>
      )}

      {hasAnyAssignees && (
        <>
          <div className="resource-summary">
            {overloadedCount === 0 ? (
              <span className="resource-badge ok">No overloads detected</span>
            ) : (
              <span className="resource-badge warn">
                {overloadedCount}{" "}
                {overloadedCount === 1 ? "person" : "people"} overloaded
              </span>
            )}
          </div>

          <div className="resource-list">
            {resourceData.map((person) => {
              const isOverloaded = person.overloadedWeeks.length > 0;
              const isExpanded = expandedPerson === person.name;

              return (
                <div
                  key={person.name}
                  className={`resource-item ${isOverloaded ? "overloaded" : ""}`}
                >
                  <div
                    className="resource-item-header"
                    onClick={() =>
                      isOverloaded &&
                      setExpandedPerson(isExpanded ? null : person.name)
                    }
                    style={{ cursor: isOverloaded ? "pointer" : "default" }}
                  >
                    <span className="resource-name">{person.name}</span>
                    <span className="resource-stats">
                      <span className="resource-task-count">
                        {person.totalTasks}{" "}
                        {person.totalTasks === 1 ? "task" : "tasks"}
                      </span>
                      {isOverloaded && (
                        <span className="resource-overload-count">
                          {person.overloadedWeeks.length}{" "}
                          {person.overloadedWeeks.length === 1
                            ? "week"
                            : "weeks"}{" "}
                          overloaded
                        </span>
                      )}
                    </span>
                    {isOverloaded && (
                      <span className="resource-chevron">
                        {isExpanded ? "\u25B4" : "\u25BE"}
                      </span>
                    )}
                  </div>

                  {isExpanded && isOverloaded && (
                    <div className="resource-weeks">
                      {person.overloadedWeeks.map((wk) => (
                        <div key={wk.weekKey} className="resource-week-row">
                          <span className="resource-week-label">
                            Week of {formatWeekLabel(wk.weekStart)}
                          </span>
                          <ul className="resource-week-tasks">
                            {wk.tasks.map((taskLabel) => (
                              <li key={taskLabel}>{taskLabel}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
