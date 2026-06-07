# TaskFlow — your Todoist + Asana

A single-file task manager that runs locally in your browser. No install, no account, no server. Your data lives in your browser's `localStorage` and never leaves your machine.

## Open it

Double-click **`index.html`** (or right-click → Open with → your browser). That's it.

> Tip: works fully offline. To "install" it like an app, open in Chrome/Edge → menu → *Save and share* → *Install page as app*.

## Features

**Todoist-style**
- Quick Add with natural language — `Email Sam tomorrow at 9am p1 @urgent`
- Today / Upcoming / Inbox smart views
- Priorities P1–P4, due dates + times, **recurring tasks** (`every week`, `every 2 days`, `every monday`, `every month`…)
- Labels, custom Filters (`p1`, `overdue`, `today`, `no date`, `@label`, or free text)
- Subtasks, comments, search
- Light / dark theme

**Asana-style**
- Projects with **Sections**
- **Board (Kanban)** view with drag-and-drop between columns, or List view — toggle per project
- Assignees on tasks

**Keyboard**
- `q` — quick add · `/` — search · `Esc` — close

## Importing tasks (the "run myself through Claude" part)

1. In the sidebar, open **Import / Export**.
2. Go to the **Schema & prompt** tab and copy the prompt + schema.
3. Paste it into Claude and describe your tasks (or paste a brain-dump / a Todoist/Asana export).
4. Claude returns one JSON object. Copy it.
5. Back in TaskFlow → **Import JSON** tab → paste → **Import**.

Use the **Load sample** button to see a working example first.

### Import JSON shape (short version)

```json
{
  "projects": [
    { "name": "Work", "color": "#14aaf5", "view": "board",
      "sections": ["To Do", "In Progress", "Done"] }
  ],
  "labels": [ { "name": "urgent", "color": "#dc4c3e" } ],
  "tasks": [
    {
      "title": "Email the client",
      "description": "optional notes",
      "project": "Work",          // omit => Inbox
      "section": "To Do",         // optional
      "priority": 1,               // 1 (high) .. 4 (none)
      "dueDate": "2026-06-10",    // YYYY-MM-DD
      "dueTime": "09:00",         // HH:MM, optional
      "recurrence": "every week", // optional
      "labels": ["urgent"],
      "assignee": "Sam",          // optional
      "completed": false,
      "subtasks": [ { "title": "Draft", "completed": true } ],
      "comments": [ { "text": "waiting on legal", "author": "Me" } ]
    }
  ]
}
```

Only `title` is required on a task. Importing **merges** by default (or tick "Replace all" to start clean). Projects/sections/labels are created automatically if they don't exist.

See **`claude-import-prompt.txt`** for a copy-paste prompt to hand to Claude.

## Backup / move your data

**Import / Export → Export** tab → Copy or Download `.json`. Re-import any time, on any machine.
