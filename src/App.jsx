import { useEffect, useMemo, useRef, useState } from "react";

const RUNTIME_CONFIG = globalThis.NOTION_CONFIG ?? {};
const ENV =
  typeof process !== "undefined" && process.env ? process.env : {};

const NOTION_CONFIG = {
  tasksDatabaseId:
    RUNTIME_CONFIG.tasksDatabaseId ?? "46fa31f3653148d69d08c1a23b0bd597",
  projectsDatabaseId:
    RUNTIME_CONFIG.projectsDatabaseId ?? "b2ba63e381ee4c15bbcf4a301de56773",
  tasksDataSourceId:
    RUNTIME_CONFIG.tasksDataSourceId ??
    ENV.REACT_APP_NOTION_TASKS_DATA_SOURCE_ID ??
    ENV.VITE_NOTION_TASKS_DATA_SOURCE_ID ??
    "",
  projectsDataSourceId:
    RUNTIME_CONFIG.projectsDataSourceId ??
    ENV.REACT_APP_NOTION_PROJECTS_DATA_SOURCE_ID ??
    ENV.VITE_NOTION_PROJECTS_DATA_SOURCE_ID ??
    "",
};

const THEME = {
  bg: "#0b1020",
  panel: "#0e1429",
  panelAlt: "#131a31",
  panelSoft: "#111931",
  border: "#20304f",
  text: "#d8e4ff",
  muted: "#87a0d0",
  primary: "#6ea8ff",
  primaryStrong: "#3d7bff",
  primarySoft: "#90b8ff",
  accent: "#72e5d0",
  accentStrong: "#1fc9ad",
};

const TASK_STATUSES = [
  { id: "Inbox", label: "Inbox", icon: "⬇", color: "#94A3B8" },
  { id: "Next", label: "Next", icon: "▶", color: "#60A5FA" },
  { id: "Waiting", label: "Waiting", icon: "⏳", color: "#FBBF24" },
  { id: "Someday", label: "Someday", icon: "☁", color: "#A78BFA" },
  { id: "Done", label: "Done", icon: "✓", color: "#34D399" },
];

const SECTIONS = [
  { id: "Focus", label: "Focus", icon: "★", color: "#F59E0B" },
  ...TASK_STATUSES,
];

const PROJECT_STATUSES = [
  "Active",
  "On Hold",
  "Done",
];

const ENERGIES = ["", "Low", "Medium", "High"];
const E_DOTS = { Low: "●○○", Medium: "●●○", High: "●●●" };
const DEFAULT_CTX = ["дом", "звонки", "деревня", "компьютер"];

const TASK_FIELD_CANDIDATES = {
  title: ["Task name", "Name"],
  status: ["Status"],
  focus: ["Focus", "Focused", "Starred", "Important", "Urgent"],
  projectId: ["Project"],
  contexts: ["Context", "Contexts"],
  energy: ["Energy"],
  due: ["Due date", "Due"],
  waitingFor: ["Waiting for"],
  notes: ["Notes"],
};

const PROJECT_FIELD_CANDIDATES = {
  title: ["Project name", "Name"],
  status: ["Status"],
  notes: ["Notes", "Description"],
};

function alpha(hex, opacity) {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value;
  const bigint = Number.parseInt(full, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

const fieldInput = {
  width: "100%",
  background: alpha(THEME.primary, 0.08),
  border: `1px solid ${alpha(THEME.primary, 0.22)}`,
  borderRadius: 10,
  padding: "8px 10px",
  color: THEME.text,
  fontSize: 13,
  outline: "none",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

function itemKey(item) {
  return item ? `${item.type}:${item.id}` : "";
}

async function notionFetch(path, { method = "GET", body } = {}) {
  const url = `https://gtd-worker.snerh6.workers.dev/api${path}`;
  //const res = await fetch(url, {
  //  method,
  //  ...(body ? { body: JSON.stringify(body) } : {}),
  //});
  const res = await fetch(encodeURIComponent(url), {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${res.status}: ${text.slice(0, 400)}`);
  }

  if (res.status === 204) {
    return null;
  }

  return res.json();
  //return res;
}

async function getDatabase(databaseId) {
  return notionFetch(`/v1/databases/${databaseId}`);
}

async function getDataSource(dataSourceId) {
  return notionFetch(`/v1/data_sources/${dataSourceId}`);
}

function pickPrimaryDataSource(database, preferredId) {
  const sources = database.data_sources ?? [];
  if (preferredId) {
    const preferred = sources.find((source) => source.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }
  if (!sources.length) {
    throw new Error(`У базы ${database.id} нет data source.`);
  }
  return sources[0];
}

async function queryDataSource(dataSourceId, sorts = null) {
  const results = [];
  let nextCursor;

  do {
    const body = {
      page_size: 100,
      ...(sorts ? { sorts } : {}),
      ...(nextCursor ? { start_cursor: nextCursor } : {}),
    };
    const data = await notionFetch(`/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body,
    });
    results.push(...(data.results ?? []));
    nextCursor = data.has_more ? data.next_cursor : undefined;
  } while (nextCursor);

  return results.filter((page) => !page.in_trash);
}

async function createPage(dataSourceId, properties) {
  return notionFetch("/v1/pages", {
    method: "POST",
    body: {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties,
    },
  });
}

async function updatePage(pageId, properties) {
  return notionFetch(`/v1/pages/${pageId}`, {
    method: "PATCH",
    body: { properties },
  });
}

async function trashPage(pageId) {
  return notionFetch(`/v1/pages/${pageId}`, {
    method: "PATCH",
    body: { in_trash: true },
  });
}

function normalizeName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase();
}

function findSchemaProperty(schema, candidates, allowedTypes) {
  const entries = Object.entries(schema ?? {});
  for (const candidate of candidates) {
    const found = entries.find(([name, value]) => {
      return (
        normalizeName(name) === normalizeName(candidate) &&
        allowedTypes.includes(value.type)
      );
    });
    if (found) {
      return found[0];
    }
  }

  return (
    entries.find(([, value]) => allowedTypes.includes(value.type))?.[0] ?? null
  );
}

function buildPropertyMap(schema, candidates, kind) {
  const propertyMap = {
    title: findSchemaProperty(schema, candidates.title, ["title"]),
  };

  if (!propertyMap.title) {
    throw new Error(`В ${kind} data source не найдено title-поле.`);
  }

  if ("status" in candidates) {
    propertyMap.status = findSchemaProperty(schema, candidates.status, [
      "status",
      "select",
    ]);
  }
  if ("focus" in candidates) {
    propertyMap.focus = findSchemaProperty(schema, candidates.focus, ["checkbox"]);
  }
  if ("projectId" in candidates) {
    propertyMap.projectId = findSchemaProperty(schema, candidates.projectId, [
      "relation",
    ]);
  }
  if ("contexts" in candidates) {
    propertyMap.contexts = findSchemaProperty(schema, candidates.contexts, [
      "multi_select",
    ]);
  }
  if ("energy" in candidates) {
    propertyMap.energy = findSchemaProperty(schema, candidates.energy, [
      "select",
      "status",
    ]);
  }
  if ("due" in candidates) {
    propertyMap.due = findSchemaProperty(schema, candidates.due, ["date"]);
  }
  if ("waitingFor" in candidates) {
    propertyMap.waitingFor = findSchemaProperty(schema, candidates.waitingFor, [
      "rich_text",
    ]);
  }
  if ("notes" in candidates) {
    propertyMap.notes = findSchemaProperty(schema, candidates.notes, [
      "rich_text",
    ]);
  }
  return propertyMap;
}

function getSchemaOptionNames(schema, propertyName) {
  const property = propertyName ? schema?.[propertyName] : null;
  if (property?.status?.options) {
    return property.status.options.map((option) => option.name);
  }
  if (property?.select?.options) {
    return property.select.options.map((option) => option.name);
  }
  return [];
}

function getDynamicProjectTextFields(schema, propertyMap) {
  const mapped = new Set(Object.values(propertyMap).filter(Boolean));
  return Object.entries(schema ?? {})
    .filter(([name, value]) => value.type === "rich_text" && !mapped.has(name))
    .map(([name]) => name);
}

async function resolveCollectionConfig({
  databaseId,
  preferredDataSourceId,
  candidates,
  kind,
}) {
  const database = await getDatabase(databaseId);
  const dataSourceRef = pickPrimaryDataSource(database, preferredDataSourceId);
  const dataSource = await getDataSource(dataSourceRef.id);
  const propertyMap = buildPropertyMap(dataSource.properties, candidates, kind);

  return {
    databaseId,
    dataSourceId: dataSource.id,
    propertyMap,
    schema: dataSource.properties,
    dynamicProjectTextFields:
      kind === "projects"
        ? getDynamicProjectTextFields(dataSource.properties, propertyMap)
        : [],
  };
}

function getTitleValue(field) {
  return field?.title?.map((part) => part.plain_text).join("") ?? "";
}

function getRichTextValue(field) {
  return field?.rich_text?.map((part) => part.plain_text).join("") ?? "";
}

function getSelectValue(field) {
  return field?.status?.name ?? field?.select?.name ?? "";
}

function getMultiSelectValue(field) {
  return (field?.multi_select ?? []).map((item) => item.name);
}

function getDateValue(field) {
  return field?.date?.start ?? null;
}

function getRelationValue(field) {
  return field?.relation?.[0]?.id ?? null;
}

function getCheckboxValue(field) {
  return Boolean(field?.checkbox);
}

function readProperty(page, key, propertyMap) {
  const propertyName = propertyMap[key];
  return propertyName ? page.properties?.[propertyName] : undefined;
}

function parseTask(page, propertyMap) {
  return {
    id: page.id,
    createdTime: page.created_time ?? null,
    title: getTitleValue(readProperty(page, "title", propertyMap)) || "Без названия",
    status: getSelectValue(readProperty(page, "status", propertyMap)) || "Inbox",
    focus: getCheckboxValue(readProperty(page, "focus", propertyMap)),
    projectId: getRelationValue(readProperty(page, "projectId", propertyMap)),
    contexts: getMultiSelectValue(readProperty(page, "contexts", propertyMap)),
    energy: getSelectValue(readProperty(page, "energy", propertyMap)),
    due: getDateValue(readProperty(page, "due", propertyMap)),
    waitingFor: getRichTextValue(readProperty(page, "waitingFor", propertyMap)),
    notes: getRichTextValue(readProperty(page, "notes", propertyMap)),
  };
}

function compareByCreatedDesc(a, b) {
  const aTime = a.createdTime ? Date.parse(a.createdTime) : 0;
  const bTime = b.createdTime ? Date.parse(b.createdTime) : 0;
  return bTime - aTime;
}

function getTodayAndTomorrow() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const format = (value) => {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  return {
    today: format(today),
    tomorrow: format(tomorrow),
  };
}

function isFocusTask(task, today, tomorrow) {
  if (task.status === "Done") {
    return false;
  }
  return task.focus || task.due === today || task.due === tomorrow;
}

function formatDisplayDate(value) {
  if (!value) {
    return "";
  }
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) {
    return value;
  }
  return `${day}/${month}/${year}`;
}

function parseProject(page, config) {
  const { propertyMap, dynamicProjectTextFields } = config;
  const textFields = {};
  for (const name of dynamicProjectTextFields) {
    textFields[name] = getRichTextValue(page.properties?.[name]);
  }

  return {
    id: page.id,
    title: getTitleValue(readProperty(page, "title", propertyMap)) || "Без названия",
    status: getSelectValue(readProperty(page, "status", propertyMap)) || "Active",
    notes: propertyMap.notes
      ? getRichTextValue(readProperty(page, "notes", propertyMap))
      : "",
    textFields,
  };
}

function buildTitle(content) {
  return [{ text: { content } }];
}

function buildRichText(content) {
  return content ? [{ text: { content } }] : [];
}

function buildSelectValue(value, schemaType) {
  if (!value) {
    return schemaType === "status" ? { status: null } : { select: null };
  }
  return schemaType === "status"
    ? { status: { name: value } }
    : { select: { name: value } };
}

function setProp(properties, propertyName, value) {
  if (propertyName) {
    properties[propertyName] = value;
  }
}

function buildTaskProps(fields, propertyMap, schema = {}) {
  const props = {};

  if (fields.title !== undefined) {
    setProp(props, propertyMap.title, { title: buildTitle(fields.title) });
  }
  if (fields.status !== undefined && propertyMap.status) {
    setProp(
      props,
      propertyMap.status,
      buildSelectValue(fields.status, schema[propertyMap.status]?.type)
    );
  }
  if (fields.focus !== undefined && propertyMap.focus) {
    setProp(props, propertyMap.focus, { checkbox: Boolean(fields.focus) });
  }
  if (fields.projectId !== undefined && propertyMap.projectId) {
    setProp(props, propertyMap.projectId, {
      relation: fields.projectId ? [{ id: fields.projectId }] : [],
    });
  }
  if (fields.contexts !== undefined && propertyMap.contexts) {
    setProp(props, propertyMap.contexts, {
      multi_select: fields.contexts.map((name) => ({ name })),
    });
  }
  if (fields.energy !== undefined && propertyMap.energy) {
    setProp(
      props,
      propertyMap.energy,
      buildSelectValue(fields.energy, schema[propertyMap.energy]?.type)
    );
  }
  if (fields.due !== undefined && propertyMap.due) {
    setProp(props, propertyMap.due, {
      date: fields.due ? { start: fields.due } : null,
    });
  }
  if (fields.waitingFor !== undefined && propertyMap.waitingFor) {
    setProp(props, propertyMap.waitingFor, {
      rich_text: buildRichText(fields.waitingFor),
    });
  }
  if (fields.notes !== undefined && propertyMap.notes) {
    setProp(props, propertyMap.notes, {
      rich_text: buildRichText(fields.notes),
    });
  }
  return props;
}

function buildProjectProps(fields, config) {
  const { propertyMap, schema, dynamicProjectTextFields } = config;
  const props = {};

  if (fields.title !== undefined) {
    setProp(props, propertyMap.title, { title: buildTitle(fields.title) });
  }
  if (fields.status !== undefined && propertyMap.status) {
    setProp(
      props,
      propertyMap.status,
      buildSelectValue(fields.status, schema[propertyMap.status]?.type)
    );
  }
  if (fields.notes !== undefined && propertyMap.notes) {
    setProp(props, propertyMap.notes, {
      rich_text: buildRichText(fields.notes),
    });
  }

  if (fields.textFields) {
    for (const name of dynamicProjectTextFields) {
      if (fields.textFields[name] !== undefined) {
        setProp(props, name, {
          rich_text: buildRichText(fields.textFields[name]),
        });
      }
    }
  }

  return props;
}

function ContextInput({ value, onChange, allCtx }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const suggestions = [...new Set([...DEFAULT_CTX, ...allCtx])]
    .filter(
      (item) =>
        item.toLowerCase().includes(text.toLowerCase()) && !value.includes(item)
    )
    .sort();

  function add(context) {
    const next = context.trim();
    if (next && !value.includes(next)) {
      onChange([...value, next]);
    }
    setText("");
    setOpen(false);
    ref.current?.focus();
  }

  function remove(context) {
    onChange(value.filter((item) => item !== context));
  }

  return (
    <div style={{ position: "relative" }}>
      <div
        onClick={() => ref.current?.focus()}
        style={{
          ...fieldInput,
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
          minHeight: 40,
          cursor: "text",
          padding: "6px 8px",
        }}
      >
        {value.map((context) => (
          <span
            key={context}
            style={{
              background: alpha(THEME.accent, 0.13),
              border: `1px solid ${alpha(THEME.accent, 0.3)}`,
              borderRadius: 999,
              padding: "2px 8px",
              color: THEME.accent,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {context}
            <span
              onMouseDown={(event) => {
                event.preventDefault();
                remove(context);
              }}
              style={{ cursor: "pointer", opacity: 0.7 }}
            >
              ×
            </span>
          </span>
        ))}
        <input
          ref={ref}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && text.trim()) {
              event.preventDefault();
              add(text);
            }
            if (event.key === "Backspace" && !text && value.length) {
              remove(value[value.length - 1]);
            }
            if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={value.length ? "" : "добавить..."}
          style={{
            background: "none",
            border: "none",
            outline: "none",
            color: THEME.text,
            fontSize: 13,
            fontFamily: "inherit",
            flex: 1,
            minWidth: 80,
            padding: 0,
          }}
        />
      </div>
      {open && (suggestions.length > 0 || text.trim()) && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 400,
            background: THEME.panel,
            border: `1px solid ${alpha(THEME.primary, 0.2)}`,
            borderRadius: 10,
            overflow: "hidden",
            boxShadow: `0 18px 50px ${alpha("#000000", 0.35)}`,
          }}
        >
          {suggestions.map((item) => (
            <div
              key={item}
              onMouseDown={() => add(item)}
              style={{
                padding: "8px 12px",
                color: THEME.text,
                fontSize: 13,
                cursor: "pointer",
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = alpha(THEME.primary, 0.12);
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = "";
              }}
            >
              {item}
            </div>
          ))}
          {text.trim() && ![...DEFAULT_CTX, ...allCtx].includes(text.trim()) && (
            <div
              onMouseDown={() => add(text)}
              style={{
                padding: "8px 12px",
                color: THEME.accent,
                fontSize: 12,
                cursor: "pointer",
                borderTop: `1px solid ${alpha(THEME.primary, 0.18)}`,
              }}
            >
              + Создать «{text.trim()}»
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          color: THEME.primarySoft,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function TaskDetailPanel({
  task,
  projects,
  allCtx,
  onSave,
  onDelete,
  onClose,
  onConvertToProject,
  onToggleFocus,
  mobile = false,
}) {
  const [form, setForm] = useState({ ...task });

  useEffect(() => {
    setForm({ ...task });
  }, [task]);

  const dirty = JSON.stringify(form) !== JSON.stringify(task);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const timeoutId = setTimeout(() => {
      onSave(form);
    }, 600);
    return () => clearTimeout(timeoutId);
  }, [dirty, form, task.id]);

  return (
    <div
      style={{
        width: mobile ? "100%" : 340,
        flexShrink: 0,
        borderLeft: mobile ? "none" : `1px solid ${alpha(THEME.primary, 0.16)}`,
        borderTop: mobile ? `1px solid ${alpha(THEME.primary, 0.16)}` : "none",
        background: THEME.panel,
        display: "flex",
        flexDirection: "column",
        height: mobile ? "auto" : "100vh",
        borderRadius: mobile ? 14 : 0,
        marginTop: mobile ? 8 : 0,
      }}
    >
      <div
        style={{
          padding: "12px 14px",
          borderBottom: `1px solid ${alpha(THEME.primary, 0.14)}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            color: THEME.primarySoft,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Задача
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {dirty && <span style={{ color: THEME.primarySoft, fontSize: 11 }}>сохранение...</span>}
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: THEME.muted,
              cursor: "pointer",
              fontSize: 18,
            }}
          >
            ×
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        <textarea
          value={form.title}
          onChange={(event) => set("title", event.target.value)}
          rows={2}
          style={{
            width: "100%",
            background: "none",
            border: "none",
            outline: "none",
            color: THEME.text,
            fontSize: 16,
            fontWeight: 700,
            fontFamily: "inherit",
            resize: "none",
            lineHeight: 1.4,
            marginBottom: 14,
            padding: 0,
            boxSizing: "border-box",
          }}
        />

        <FieldRow label="Статус">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {TASK_STATUSES.map((item) => (
              <button
                key={item.id}
                onClick={() => set("status", item.id)}
                style={{
                  background:
                    form.status === item.id ? alpha(item.color, 0.16) : alpha(item.color, 0.08),
                  border: `1px solid ${
                    form.status === item.id ? alpha(item.color, 0.45) : alpha(item.color, 0.2)
                  }`,
                  borderRadius: 999,
                  padding: "4px 10px",
                  color: item.color,
                  fontSize: 12,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow label="Фокус">
          <button
            onClick={() => {
              set("focus", !form.focus);
            }}
            style={{
              width: "100%",
              background: form.focus ? alpha("#F59E0B", 0.18) : alpha(THEME.primary, 0.08),
              border: `1px solid ${
                form.focus ? alpha("#F59E0B", 0.35) : alpha(THEME.primary, 0.18)
              }`,
              borderRadius: 10,
              padding: "8px 10px",
              color: form.focus ? "#FBBF24" : THEME.muted,
              fontSize: 13,
              cursor: "pointer",
              fontFamily: "inherit",
              textAlign: "left",
            }}
          >
            {form.focus ? "★ В фокусе" : "☆ Добавить в фокус"}
          </button>
        </FieldRow>

        <FieldRow label="Заметки">
          <textarea
            value={form.notes}
            onChange={(event) => set("notes", event.target.value)}
            rows={5}
            style={{ ...fieldInput, resize: "vertical" }}
          />
        </FieldRow>

        <FieldRow label="Проект">
          <select
            value={form.projectId || ""}
            onChange={(event) => set("projectId", event.target.value || null)}
            style={{ ...fieldInput, appearance: "none" }}
          >
            <option value="">— без проекта</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </FieldRow>

        <FieldRow label="Энергия">
          <div style={{ display: "flex", gap: 6 }}>
            {ENERGIES.map((energy) => (
              <button
                key={energy}
                onClick={() => set("energy", energy)}
                style={{
                  background:
                    form.energy === energy && energy
                      ? alpha(THEME.primaryStrong, 0.18)
                      : alpha(THEME.primary, 0.08),
                  border: `1px solid ${
                    form.energy === energy && energy
                      ? alpha(THEME.primaryStrong, 0.35)
                      : alpha(THEME.primary, 0.18)
                  }`,
                  borderRadius: 999,
                  padding: "4px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  color: form.energy === energy && energy ? THEME.primary : THEME.muted,
                }}
              >
                {energy ? E_DOTS[energy] : "—"}
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow label="Контекст">
          <ContextInput
            value={form.contexts}
            onChange={(next) => set("contexts", next)}
            allCtx={allCtx}
          />
        </FieldRow>

        <FieldRow label="Дедлайн">
          <input
            type="date"
            value={form.due || ""}
            onChange={(event) => set("due", event.target.value || null)}
            style={fieldInput}
          />
        </FieldRow>

        {(form.status === "Waiting" || form.waitingFor) && (
          <FieldRow label="Жду от">
            <input
              value={form.waitingFor}
              onChange={(event) => set("waitingFor", event.target.value)}
              placeholder="кого / чего..."
              style={fieldInput}
            />
          </FieldRow>
        )}

        <button
          onClick={() => onConvertToProject(task)}
          style={{
            width: "100%",
            background: alpha(THEME.accentStrong, 0.13),
            border: `1px solid ${alpha(THEME.accentStrong, 0.3)}`,
            borderRadius: 10,
            padding: "8px 10px",
            color: THEME.accent,
            fontSize: 12,
            cursor: "pointer",
            fontFamily: "inherit",
            marginBottom: 10,
          }}
        >
          Превратить в проект
        </button>

        <button
          onClick={() => onDelete(task.id)}
          style={{
            width: "100%",
            background: "none",
            border: `1px solid ${alpha("#f87171", 0.22)}`,
            borderRadius: 10,
            padding: "8px 10px",
            color: "#f58f8f",
            fontSize: 12,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Удалить
        </button>
      </div>
    </div>
  );
}

function ProjectDetailPanel({
  project,
  onSave,
  onClose,
  onDelete,
  projectSource,
  mobile = false,
}) {
  const [form, setForm] = useState({ ...project });

  useEffect(() => {
    setForm({ ...project });
  }, [project]);

  const dynamicNames = projectSource?.dynamicProjectTextFields ?? [];
  const projectStatuses =
    getSchemaOptionNames(
      projectSource?.schema,
      projectSource?.propertyMap?.status
    ) || [];
  const dirty = JSON.stringify(form) !== JSON.stringify(project);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const timeoutId = setTimeout(() => {
      onSave(form);
    }, 600);
    return () => clearTimeout(timeoutId);
  }, [dirty, form, project.id]);

  return (
    <div
      style={{
        width: mobile ? "100%" : 340,
        flexShrink: 0,
        borderLeft: mobile ? "none" : `1px solid ${alpha(THEME.primary, 0.16)}`,
        borderTop: mobile ? `1px solid ${alpha(THEME.primary, 0.16)}` : "none",
        background: THEME.panel,
        display: "flex",
        flexDirection: "column",
        height: mobile ? "auto" : "100vh",
        borderRadius: mobile ? 14 : 0,
        marginTop: mobile ? 8 : 0,
      }}
    >
      <div
        style={{
          padding: "12px 14px",
          borderBottom: `1px solid ${alpha(THEME.primary, 0.14)}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            color: THEME.accent,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Проект
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {dirty && <span style={{ color: THEME.primarySoft, fontSize: 11 }}>сохранение...</span>}
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: THEME.muted,
              cursor: "pointer",
              fontSize: 18,
            }}
          >
            ×
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        <textarea
          value={form.title}
          onChange={(event) => set("title", event.target.value)}
          rows={2}
          style={{
            width: "100%",
            background: "none",
            border: "none",
            outline: "none",
            color: THEME.text,
            fontSize: 16,
            fontWeight: 700,
            fontFamily: "inherit",
            resize: "none",
            lineHeight: 1.4,
            marginBottom: 14,
            padding: 0,
            boxSizing: "border-box",
          }}
        />

        <FieldRow label="Статус">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(projectStatuses.length ? projectStatuses : PROJECT_STATUSES).map((status) => (
              <button
                key={status}
                onClick={() => set("status", status)}
                style={{
                  background:
                    form.status === status
                      ? alpha(THEME.primaryStrong, 0.18)
                      : alpha(THEME.primary, 0.08),
                  border: `1px solid ${
                    form.status === status
                      ? alpha(THEME.primaryStrong, 0.35)
                      : alpha(THEME.primary, 0.18)
                  }`,
                  borderRadius: 999,
                  padding: "4px 10px",
                  color: form.status === status ? THEME.primary : THEME.muted,
                  fontSize: 12,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {status}
              </button>
            ))}
          </div>
        </FieldRow>

        {"notes" in form && (
          <FieldRow label="Заметки">
            <textarea
              value={form.notes || ""}
              onChange={(event) => set("notes", event.target.value)}
              rows={4}
              style={{ ...fieldInput, resize: "vertical" }}
            />
          </FieldRow>
        )}

        {dynamicNames.map((name) => (
          <FieldRow key={name} label={name}>
            <textarea
              value={form.textFields?.[name] || ""}
              onChange={(event) =>
                set("textFields", {
                  ...form.textFields,
                  [name]: event.target.value,
                })
              }
              rows={4}
              style={{ ...fieldInput, resize: "vertical" }}
            />
          </FieldRow>
        ))}

        <button
          onClick={() => onDelete(project.id)}
          style={{
            width: "100%",
            background: "none",
            border: `1px solid ${alpha("#f87171", 0.22)}`,
            borderRadius: 10,
            padding: "8px 10px",
            color: "#f58f8f",
            fontSize: 12,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Удалить проект
        </button>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  projects,
  active,
  isDragged,
  onClick,
  onToggleDone,
  onToggleFocus,
  onDragStart,
  onDragEnd,
}) {
  const project = projects.find((item) => item.id === task.projectId);
  const section = SECTIONS.find((item) => item.id === task.status);
  const done = task.status === "Done";

  return (
    <div
      draggable
      onDragStart={(event) => onDragStart(event, task.id)}
      onDragEnd={onDragEnd}
      onClick={onClick}
      style={{
        padding: "10px 16px",
        borderBottom: `1px solid ${alpha(THEME.primary, 0.09)}`,
        cursor: "pointer",
        //background: isDragged
         // ? alpha(THEME.primary, 0.18)
          //: active
          //? alpha(THEME.primary, 0.12)
          //: "transparent",
        background: active
          ? alpha(THEME.primary, 0.12)
          : "transparent",
        borderLeft: `2px solid ${active ? section?.color || THEME.primary : "transparent"}`,
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        borderRadius: 14,
        opacity: isDragged ? 0.72 : 1,
        //boxShadow: isDragged ? `0 10px 30px ${alpha(THEME.primaryStrong, 0.16)}` : "none",
        boxShadow: "none",
        position: "relative",
      }}
      onMouseEnter={(event) => {
        if (!active && !isDragged) {
          event.currentTarget.style.background = alpha(THEME.primary, 0.07);
        }
      }}
      onMouseLeave={(event) => {
        if (!active && !isDragged) {
          event.currentTarget.style.background = "transparent";
        }
      }}
    >
      <button
        onClick={(event) => {
          event.stopPropagation();
          onToggleFocus(task.id, !task.focus);
        }}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          marginTop: 1,
          color: task.focus ? "#FBBF24" : alpha(THEME.primary, 0.28),
          cursor: "pointer",
          fontSize: 15,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        {task.focus ? "★" : "☆"}
      </button>
      <div
        onClick={(event) => {
          event.stopPropagation();
          onToggleDone(task.id, done ? "Next" : "Done");
        }}
        style={{
          width: 15,
          height: 15,
          borderRadius: "50%",
          flexShrink: 0,
          marginTop: 2,
          border: `1.5px solid ${done ? "#34D399" : alpha(THEME.primary, 0.28)}`,
          background: done ? alpha("#34D399", 0.14) : "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
      >
        {done && <span style={{ color: "#34D399", fontSize: 8 }}>✓</span>}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            color: done ? alpha(THEME.text, 0.45) : THEME.text,
            textDecoration: done ? "line-through" : "none",
            lineHeight: 1.4,
            marginBottom: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task.title}
        </div>

        {(project || task.contexts.length > 0 || task.energy || task.due) && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {project && (
              <span
                style={{
                  fontSize: 10,
                  color: THEME.accent,
                  background: alpha(THEME.accent, 0.12),
                  border: `1px solid ${alpha(THEME.accent, 0.22)}`,
                  borderRadius: 999,
                  padding: "2px 7px",
                }}
              >
                {project.title}
              </span>
            )}
            {task.contexts.map((context) => (
              <span
                key={context}
                style={{
                  fontSize: 10,
                  color: THEME.primary,
                  background: alpha(THEME.primary, 0.12),
                  border: `1px solid ${alpha(THEME.primary, 0.2)}`,
                  borderRadius: 999,
                  padding: "2px 7px",
                }}
              >
                {context}
              </span>
            ))}
            {task.energy && (
              <span style={{ fontSize: 10, color: THEME.muted }}>{E_DOTS[task.energy]}</span>
            )}
            {task.due && (
              <span style={{ fontSize: 10, color: "#f59a9a", marginLeft: "auto" }}>
                {formatDisplayDate(task.due)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function QuickAdd({ onAdd, label }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!busy) {
      const id = setTimeout(() => ref.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [busy]);

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed || busy) {
      return;
    }

    setBusy(true);
    try {
      await onAdd(trimmed);
      setValue("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        padding: "10px 16px",
        borderBottom: `1px solid ${alpha(THEME.primary, 0.09)}`,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <div
        style={{
          width: 15,
          height: 15,
          borderRadius: "50%",
          flexShrink: 0,
          border: `1.5px solid ${alpha(THEME.primary, 0.24)}`,
        }}
      />
      <input
        ref={ref}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && submit()}
        disabled={busy}
        placeholder={label}
        style={{
          flex: 1,
          background: "none",
          border: "none",
          outline: "none",
          color: THEME.text,
          fontSize: 13,
          fontFamily: "inherit",
          opacity: busy ? 0.6 : 1,
        }}
      />
      {value.trim() && !busy && (
        <span
          onClick={submit}
          style={{ color: THEME.primarySoft, fontSize: 11, cursor: "pointer" }}
        >
          ↵ Enter
        </span>
      )}
      {busy && <span style={{ color: THEME.primary, fontSize: 11 }}>...</span>}
    </div>
  );
}

function ProjectRow({
  project,
  active,
  selected,
  count,
  onOpen,
}) {
  return (
    <div
      onClick={onOpen}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        borderRadius: 10,
        cursor: "pointer",
        background: active ? alpha(THEME.accent, 0.14) : selected ? alpha(THEME.primary, 0.12) : "transparent",
        border: `1px solid ${
          active
            ? alpha(THEME.accent, 0.25)
            : selected
            ? alpha(THEME.primary, 0.22)
            : "transparent"
        }`,
        marginBottom: 4,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: active ? THEME.accent : THEME.primarySoft }} />
      <span
        style={{
          flex: 1,
          fontSize: 12,
          color: active ? THEME.accent : THEME.text,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {project.title}
      </span>
      <span style={{ fontSize: 10, color: THEME.muted }}>{count}</span>
    </div>
  );
}

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [section, setSection] = useState("Inbox");
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [fCtx, setFCtx] = useState(null);
  const [fProj, setFProj] = useState(null);
  const [fEnergy, setFEnergy] = useState(null);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [dragOverSection, setDragOverSection] = useState(null);
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const dragGhostRef = useRef(null);
  const [sources, setSources] = useState({
    tasks: null,
    projects: null,
  });

  const allCtx = useMemo(
    () => [...new Set(tasks.flatMap((task) => task.contexts))],
    [tasks]
  );
  const { today, tomorrow } = useMemo(() => getTodayAndTomorrow(), []);

  async function load() {
    setLoading(true);
    setError(null);

    try {
      const [taskSource, projectSource] = await Promise.all([
        resolveCollectionConfig({
          databaseId: NOTION_CONFIG.tasksDatabaseId,
          preferredDataSourceId: NOTION_CONFIG.tasksDataSourceId,
          candidates: TASK_FIELD_CANDIDATES,
          kind: "tasks",
        }),
        resolveCollectionConfig({
          databaseId: NOTION_CONFIG.projectsDatabaseId,
          preferredDataSourceId: NOTION_CONFIG.projectsDataSourceId,
          candidates: PROJECT_FIELD_CANDIDATES,
          kind: "projects",
        }),
      ]);

      const [taskPages, projectPages] = await Promise.all([
        queryDataSource(taskSource.dataSourceId, [
          { timestamp: "created_time", direction: "descending" },
        ]),
        queryDataSource(projectSource.dataSourceId),
      ]);

      const parsedTasks = taskPages
        .map((page) => parseTask(page, taskSource.propertyMap))
        .sort(compareByCreatedDesc);
      const parsedProjects = projectPages.map((page) =>
        parseProject(page, projectSource)
      );

      setSources({ tasks: taskSource, projects: projectSource });
      setTasks(parsedTasks);
      setProjects(parsedProjects);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const onResize = () => setIsMobile(window.innerWidth < 768);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setSidebarOpen(false);
    }
  }, [isMobile]);

  const counts = useMemo(
    () =>
      SECTIONS.reduce(
        (accumulator, item) => ({
          ...accumulator,
          [item.id]:
            item.id === "Focus"
              ? tasks.filter((task) => isFocusTask(task, today, tomorrow)).length
              : tasks.filter((task) => task.status === item.id).length,
        }),
        {}
      ),
    [tasks, today, tomorrow]
  );

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const projectTaskCounts = useMemo(() => {
    const map = new Map();
    for (const task of tasks) {
      if (!task.projectId) {
        continue;
      }
      map.set(task.projectId, (map.get(task.projectId) ?? 0) + (task.status === "Done" ? 0 : 1));
    }
    return map;
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (section === "Focus") {
        if (!isFocusTask(task, today, tomorrow)) {
          return false;
        }
      } else if (task.status !== section) {
        return false;
      }
      if (activeProjectId && task.projectId !== activeProjectId) {
        return false;
      }
      if (fCtx && !task.contexts.includes(fCtx)) {
        return false;
      }
      if (fProj && task.projectId !== fProj) {
        return false;
      }
      if (fEnergy && task.energy !== fEnergy) {
        return false;
      }
      return true;
    });
  }, [tasks, section, activeProjectId, fCtx, fProj, fEnergy, today, tomorrow]);

  const selectedTask =
    selected?.type === "task"
      ? tasks.find((task) => task.id === selected.id) ?? null
      : null;
  const selectedProject =
    selected?.type === "project"
      ? projects.find((project) => project.id === selected.id) ?? null
      : null;

  const hasFilter = fCtx || fProj || fEnergy;

  async function addTask(title) {
    if (!sources.tasks) {
      return;
    }

    const projectId = activeProjectId || fProj || null;
    const targetStatus = section === "Focus" ? "Inbox" : section;

    try {
      setError(null);
      const page = await createPage(
        sources.tasks.dataSourceId,
        buildTaskProps(
          { title, status: targetStatus, projectId },
          sources.tasks.propertyMap,
          sources.tasks.schema
        )
      );
      const task = parseTask(page, sources.tasks.propertyMap);
      setTasks((current) => [task, ...current].sort(compareByCreatedDesc));
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveTask(form) {
    if (!sources.tasks) {
      return;
    }

    setSaving(true);
    try {
      setError(null);
      await updatePage(
        form.id,
        buildTaskProps(form, sources.tasks.propertyMap, sources.tasks.schema)
      );
      setTasks((current) =>
        current.map((task) =>
          task.id === form.id ? { ...task, ...form, createdTime: task.createdTime } : task
        )
      );
    } catch (err) {
      setError(err.message);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function saveProject(form) {
    if (!sources.projects) {
      return;
    }

    setSaving(true);
    try {
      setError(null);
      await updatePage(form.id, buildProjectProps(form, sources.projects));
      setProjects((current) =>
        current.map((project) =>
          project.id === form.id ? { ...project, ...form } : project
        )
      );
    } catch (err) {
      setError(err.message);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function deleteTask(id) {
    try {
      setError(null);
      await trashPage(id);
      setTasks((current) => current.filter((task) => task.id !== id));
      if (selected?.type === "task" && selected.id === id) {
        setSelected(null);
      }
    } catch (err) {
      setError(err.message);
      await load();
    }
  }

  async function deleteProject(id) {
    try {
      setError(null);
      await trashPage(id);
      setProjects((current) => current.filter((project) => project.id !== id));
      setTasks((current) =>
        current.map((task) => (task.projectId === id ? { ...task, projectId: null } : task))
      );
      if (activeProjectId === id) {
        setActiveProjectId(null);
      }
      if (selected?.type === "project" && selected.id === id) {
        setSelected(null);
      }
    } catch (err) {
      setError(err.message);
      await load();
    }
  }

  async function toggleDone(id, newStatus) {
    if (!sources.tasks) {
      return;
    }

    setTasks((current) =>
      current.map((item) =>
        item.id === id ? { ...item, status: newStatus } : item
      )
    );

    try {
      setError(null);
      await updatePage(
        id,
        buildTaskProps(
          { status: newStatus },
          sources.tasks.propertyMap,
          sources.tasks.schema
        )
      );
    } catch (err) {
      setError(err.message);
      await load();
    }
  }

  async function toggleFocus(id, nextFocus) {
    if (!sources.tasks) {
      return;
    }

    setTasks((current) =>
      current.map((task) => (task.id === id ? { ...task, focus: nextFocus } : task))
    );

    try {
      setError(null);
      await updatePage(
        id,
        buildTaskProps(
          { focus: nextFocus },
          sources.tasks.propertyMap,
          sources.tasks.schema
        )
      );
    } catch (err) {
      setError(err.message);
      await load();
    }
  }

  async function convertTaskToProject(task) {
    if (!sources.projects || !sources.tasks) {
      return;
    }

    try {
      setError(null);
      const projectFields = {
        title: task.title,
        status: "Active",
        notes: task.notes,
        textFields: {},
      };

      const firstDynamicField = sources.projects.dynamicProjectTextFields[0];
      if (firstDynamicField && task.notes) {
        projectFields.textFields[firstDynamicField] = task.notes;
      }

      const projectPage = await createPage(
        sources.projects.dataSourceId,
        buildProjectProps(projectFields, sources.projects)
      );
      const project = parseProject(projectPage, sources.projects);

      await updatePage(
        task.id,
        buildTaskProps(
          { projectId: project.id },
          sources.tasks.propertyMap,
          sources.tasks.schema
        )
      );

      setProjects((current) => [...current, project]);
      setTasks((current) =>
        current.map((item) =>
          item.id === task.id ? { ...item, projectId: project.id } : item
        )
      );
      setActiveProjectId(project.id);
      setSelected({ type: "project", id: project.id });
    } catch (err) {
      setError(err.message);
      await load();
    }
  }

  async function moveTaskToSection(taskId, nextStatus) {
    if (!sources.tasks || !draggedTaskId) {
      return;
    }

    if (nextStatus === "Focus") {
      setDraggedTaskId(null);
      setDragOverSection(null);
      await toggleFocus(taskId, true);
      return;
    }

    const movedTask = tasks.find((task) => task.id === taskId);
    if (!movedTask) {
      return;
    }

    const nextProjectId = activeProjectId ?? movedTask.projectId ?? null;
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? { ...task, status: nextStatus, projectId: nextProjectId }
          : task
      )
    );
    setDraggedTaskId(null);
    setDragOverSection(null);

    try {
      setError(null);
      await updatePage(
        taskId,
        buildTaskProps(
          {
            status: nextStatus,
            projectId: nextProjectId,
          },
          sources.tasks.propertyMap,
          sources.tasks.schema
        )
      );
    } catch (err) {
      setError(err.message);
      await load();
    }
  }

  function handleDragStart(event, taskId) {
    setDraggedTaskId(taskId);
    setDragOverSection(null);

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
    const source = event.currentTarget;
    const clone = source.cloneNode(true);
    const rect = source.getBoundingClientRect();

    clone.style.position = "fixed";
    clone.style.top = "-1000px";
    clone.style.left = "-1000px";
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.margin = "0";
    clone.style.pointerEvents = "none";
    clone.style.transform = "none";
    clone.style.opacity = "1";
    clone.style.zIndex = "9999";

    document.body.appendChild(clone);
    dragGhostRef.current = clone;
    event.dataTransfer.setDragImage(clone, 24, 16);
  }

  function cleanupDragGhost() {
    if (dragGhostRef.current?.parentNode) {
      dragGhostRef.current.parentNode.removeChild(dragGhostRef.current);
    }
    dragGhostRef.current = null;
  }

  function clearDragState() {
    cleanupDragGhost();
    setDraggedTaskId(null);
    setDragOverSection(null);
  }

  const selectedContent = selectedTask ? (
    <TaskDetailPanel
      task={selectedTask}
      projects={projects}
      allCtx={allCtx}
      onSave={saveTask}
      onDelete={deleteTask}
      onClose={() => setSelected(null)}
      onConvertToProject={convertTaskToProject}
      onToggleFocus={toggleFocus}
      mobile={isMobile}
    />
  ) : selectedProject ? (
    <ProjectDetailPanel
      project={selectedProject}
      projectSource={sources.projects}
      onSave={saveProject}
      onDelete={deleteProject}
      onClose={() => setSelected(null)}
      mobile={isMobile}
    />
  ) : null;

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: `linear-gradient(180deg, ${THEME.bg}, ${THEME.panelSoft})`,
        fontFamily: "'Inter', system-ui, sans-serif",
        color: THEME.text,
        overflow: "hidden",
      }}
    >
      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: ${alpha(THEME.primary, 0.22)}; border-radius: 999px; }
        ::-webkit-scrollbar-track { background: transparent; }
        select option { background: ${THEME.panel}; color: ${THEME.text}; }
        textarea { scrollbar-width: thin; }
      `}</style>

      {isMobile && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: alpha("#000000", 0.45),
            zIndex: 40,
          }}
        />
      )}

      <div
        style={{
          width: 250,
          flexShrink: 0,
          background: alpha(THEME.panel, 0.95),
          borderRight: `1px solid ${alpha(THEME.primary, 0.12)}`,
          display: "flex",
          flexDirection: "column",
          position: isMobile ? "fixed" : "relative",
          inset: isMobile ? "0 auto 0 0" : "auto",
          zIndex: isMobile ? 50 : "auto",
          transform: isMobile ? `translateX(${sidebarOpen ? "0" : "-100%"})` : "none",
          transition: isMobile ? "transform 0.2s ease" : "none",
          height: "100vh",
        }}
      >
        <div
          style={{
            padding: "16px 14px 12px",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 7,
              background: `linear-gradient(135deg, ${THEME.primaryStrong}, ${THEME.accentStrong})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              fontWeight: 900,
              color: "white",
              boxShadow: `0 10px 24px ${alpha(THEME.primaryStrong, 0.28)}`,
            }}
          >
            G
          </div>
          <span style={{ fontWeight: 700, fontSize: 14, color: THEME.text }}>
            GTD
          </span>
          {saving && (
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: THEME.primary,
                marginLeft: "auto",
                animation: "pulse 1s infinite",
              }}
            />
          )}
        </div>

        <div style={{ padding: "0 10px 8px" }}>
          {SECTIONS.map((item) => (
            <div
              key={item.id}
              onClick={() => {
                setSection(item.id);
                if (isMobile) {
                  setSidebarOpen(false);
                }
                if (selected?.type === "task") {
                  setSelected(null);
                }
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragEnter={() => setDragOverSection(item.id)}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedTaskId) {
                  moveTaskToSection(draggedTaskId, item.id);
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 10px",
                cursor: "pointer",
                borderLeft: `2px solid ${section === item.id ? item.color : "transparent"}`,
                background:
                  dragOverSection === item.id
                    ? alpha(item.color, 0.22)
                    : section === item.id
                    ? alpha(item.color, 0.12)
                    : "transparent",
                borderRadius: 10,
                marginBottom: 4,
                boxShadow:
                  dragOverSection === item.id
                    ? `inset 0 0 0 1px ${alpha(item.color, 0.32)}`
                    : "none",
              }}
            >
              <span style={{ fontSize: 11, width: 14, textAlign: "center", color: item.color }}>
                {item.icon}
              </span>
              <span
                style={{
                  fontSize: 13,
                  flex: 1,
                  fontWeight: section === item.id ? 600 : 400,
                  color: item.color,
                }}
              >
                {item.label}
              </span>
              {counts[item.id] > 0 && (
                <span
                  style={{
                    fontSize: 10,
                    color: item.color,
                    background: alpha(item.color, 0.12),
                    borderRadius: 999,
                    padding: "1px 7px",
                    minWidth: 18,
                    textAlign: "center",
                  }}
                >
                  {counts[item.id]}
                </span>
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: "10px", borderTop: `1px solid ${alpha(THEME.primary, 0.1)}` }}>
          <div
            style={{
              color: THEME.primarySoft,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Фильтры
          </div>
          {[
            {
              val: fProj,
              set: setFProj,
              opts: projects.map((project) => ({ v: project.id, l: project.title })),
              ph: "Проект",
            },
            {
              val: fCtx,
              set: setFCtx,
              opts: allCtx.map((context) => ({ v: context, l: context })),
              ph: "Контекст",
            },
            {
              val: fEnergy,
              set: setFEnergy,
              opts: ["Low", "Medium", "High"].map((energy) => ({
                v: energy,
                l: energy,
              })),
              ph: "Энергия",
            },
          ].map(({ val, set, opts, ph }, index) => (
            <select
              key={index}
              value={val || ""}
              onChange={(event) => set(event.target.value || null)}
              style={{
                ...fieldInput,
                marginBottom: 6,
                appearance: "none",
                cursor: "pointer",
                color: val ? THEME.text : THEME.muted,
              }}
            >
              <option value="">{ph}</option>
              {opts.map((option) => (
                <option key={option.v} value={option.v}>
                  {option.l}
                </option>
              ))}
            </select>
          ))}

          {hasFilter && (
            <button
              onClick={() => {
                setFProj(null);
                setFCtx(null);
                setFEnergy(null);
              }}
              style={{
                width: "100%",
                background: alpha(THEME.primary, 0.08),
                border: `1px solid ${alpha(THEME.primary, 0.18)}`,
                borderRadius: 10,
                padding: "7px 8px",
                color: THEME.primary,
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              × сброс
            </button>
          )}
        </div>

        <div
          style={{
            flex: 1,
            padding: "10px",
            borderTop: `1px solid ${alpha(THEME.primary, 0.1)}`,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <span
              style={{
                color: THEME.accent,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              Проекты
            </span>
            {activeProject && (
              <button
                onClick={() => setActiveProjectId(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: THEME.muted,
                  cursor: "pointer",
                  fontSize: 11,
                  fontFamily: "inherit",
                }}
              >
                все
              </button>
            )}
          </div>

          {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                active={activeProjectId === project.id}
                selected={selected?.type === "project" && selected.id === project.id}
                count={projectTaskCounts.get(project.id) ?? 0}
                onOpen={() => {
                  setActiveProjectId((current) =>
                    current === project.id ? null : project.id
                  );
                  setSelected({ type: "project", id: project.id });
                }}
              />
            ))}
        </div>

        <div style={{ padding: "10px", borderTop: `1px solid ${alpha(THEME.primary, 0.1)}` }}>
          <button
            onClick={load}
            style={{
              width: "100%",
              background: alpha(THEME.primary, 0.08),
              border: `1px solid ${alpha(THEME.primary, 0.18)}`,
              borderRadius: 10,
              padding: "8px",
              color: THEME.primary,
              fontSize: 11,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            ↻ обновить
          </button>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div
          style={{
            padding: "14px 16px",
            borderBottom: `1px solid ${alpha(THEME.primary, 0.12)}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: alpha(THEME.panel, 0.45),
          }}
        >
          {isMobile && (
            <button
              onClick={() => setSidebarOpen(true)}
              style={{
                background: alpha(THEME.primary, 0.1),
                border: `1px solid ${alpha(THEME.primary, 0.2)}`,
                borderRadius: 10,
                padding: "6px 10px",
                color: THEME.primary,
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Разделы
            </button>
          )}
          <span style={{ fontSize: 15, fontWeight: 700, color: THEME.text }}>
            {SECTIONS.find((item) => item.id === section)?.label}
          </span>
          {activeProject && (
            <span
              style={{
                fontSize: 11,
                color: THEME.accent,
                background: alpha(THEME.accent, 0.12),
                border: `1px solid ${alpha(THEME.accent, 0.22)}`,
                borderRadius: 999,
                padding: "3px 9px",
              }}
            >
              {activeProject.title}
            </span>
          )}
          {section === "Inbox" && counts.Inbox > 0 && !activeProject && (
            <span
              style={{
                fontSize: 11,
                color: "#FBBF24",
                background: alpha("#FBBF24", 0.12),
                border: `1px solid ${alpha("#FBBF24", 0.22)}`,
                borderRadius: 999,
                padding: "3px 9px",
              }}
            >
              {counts.Inbox} нужно обработать
            </span>
          )}
          <span style={{ marginLeft: "auto", fontSize: 11, color: THEME.muted }}>
            {visibleTasks.length} задач
          </span>
        </div>

        <div
          style={{ flex: 1, overflowY: "auto" }}
          onDragOver={(event) => event.preventDefault()}
          onDragEnter={() => setDragOverSection(section)}
          onDrop={(event) => {
            event.preventDefault();
            if (draggedTaskId) {
              moveTaskToSection(draggedTaskId, section);
            }
          }}
        >
          {loading ? (
            <div style={{ padding: 40, textAlign: "center", color: THEME.muted, fontSize: 13 }}>
              Загрузка из Notion...
            </div>
          ) : error ? (
            <div style={{ padding: 20, color: "#f58f8f", fontSize: 13 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Ошибка подключения к Notion</div>
              <div style={{ color: THEME.muted, fontSize: 11, lineHeight: 1.6, marginBottom: 12 }}>
                {error}
              </div>
              <button
                onClick={load}
                style={{
                  background: alpha(THEME.primaryStrong, 0.18),
                  border: `1px solid ${alpha(THEME.primaryStrong, 0.32)}`,
                  borderRadius: 10,
                  padding: "7px 12px",
                  color: THEME.primary,
                  fontSize: 12,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Попробовать снова
              </button>
            </div>
          ) : (
            <>
              <QuickAdd
                onAdd={addTask}
                label={
                  activeProject
                    ? `Новая задача в ${activeProject.title}...`
                    : section === "Focus"
                    ? "Новая задача в Focus (уйдёт в Inbox)..."
                    : `Новая задача в ${section}...`
                }
              />
              {isMobile && selected?.type === "project" && selectedContent}
              {visibleTasks.length === 0 ? (
                <div style={{ padding: "40px 16px", textAlign: "center", color: THEME.muted, fontSize: 13 }}>
                  {activeProject
                    ? `В проекте «${activeProject.title}» нет задач со статусом ${section}`
                    : section === "Focus"
                    ? "Нет задач в фокусе и задач на сегодня/завтра"
                    : section === "Inbox"
                    ? "Inbox пуст"
                    : `Нет задач в ${section}`}
                </div>
              ) : (
                visibleTasks.map((task) => (
                  <div key={task.id}>
                    <TaskRow
                      task={task}
                      projects={projects}
                      active={selected?.type === "task" && selected.id === task.id}
                      isDragged={draggedTaskId === task.id}
                      onClick={() =>
                        setSelected((current) =>
                          itemKey(current) === itemKey({ type: "task", id: task.id })
                            ? null
                            : { type: "task", id: task.id }
                        )
                      }
                      onToggleDone={toggleDone}
                      onToggleFocus={toggleFocus}
                      onDragStart={handleDragStart}
                      onDragEnd={clearDragState}
                    />
                    {isMobile &&
                      selected?.type === "task" &&
                      selected.id === task.id &&
                      selectedContent}
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>

      {!isMobile && selectedContent}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.25} }`}</style>
    </div>
  );
}
