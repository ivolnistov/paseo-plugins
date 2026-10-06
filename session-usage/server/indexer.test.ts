import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UsageIndex } from "./indexer";
import { INDEX_VERSION, UsageStore } from "./index-store";
import { SnapshotSchema } from "../shared/schema";
import { EMPTY_FILTERS, filterSessions } from "../shared/model";

async function save(path: string, content: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }

test("index joins archived metadata, deduplicates copies, keeps missing agents and refreshes changed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-usage-index-"));
  const roots = { paseo: join(root, "paseo"), claude: join(root, "claude"), codex: join(root, "codex"), data: join(root, "data"), cursor: [join(root, "cursor")] };
  const index = new UsageIndex(roots);
  try {
    await save(join(roots.paseo, "projects", "projects.json"), JSON.stringify([{ projectId: "p", rootPath: "/project", customName: "Project", archivedAt: "2026-09-01" }]));
    await save(join(roots.paseo, "projects", "workspaces.json"), JSON.stringify([{ workspaceId: "w", projectId: "p", cwd: "/worktree", title: "Workspace", labels: ["team"] }]));
    const agent = { id: "a", provider: "claude", cwd: "/worktree", workspaceId: "w", title: "Agent", createdAt: "2026-09-01", persistence: { sessionId: "c1", metadata: { apiKey: "SECRET_MUST_NOT_LEAK" } } };
    const agentPath = join(roots.paseo, "agents", "bucket", "a.json");
    await save(agentPath, JSON.stringify(agent));
    await save(join(roots.paseo, "agents", "bucket", "resumed.json"), JSON.stringify({ ...agent, id: "resumed", archivedAt: "2026-09-01" }));
    await save(join(roots.paseo, "agents", "bucket", "missing.json"), JSON.stringify({ ...agent, id: "missing", persistence: { sessionId: "missing-session" } }));
    const claudePath = join(roots.claude, "projects", "-worktree", "c1.jsonl");
    const claude = (id: string) => JSON.stringify({ type: "assistant", uuid: id, timestamp: "2026-09-01T12:00:00Z", sessionId: "c1", cwd: "/worktree", message: { id, model: "claude-opus-4-6", content: [{ type: "text", text: "PRIVATE_TRANSCRIPT_TEXT" }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } }) + "\n";
    await save(claudePath, claude("r1"));
    await save(join(roots.claude, "projects", "-worktree", "c1", "subagents", "agent-child.jsonl"), claude("r2"));
    const filename = "rollout-2026-09-01T12-00-00-x1.jsonl";
    const codex = JSON.stringify({ type: "session_meta", timestamp: "2026-09-01T12:00:00Z", payload: { id: "x1", cwd: "/outside" } }) + "\n" + JSON.stringify({ type: "token_usage_record", timestamp: "2026-09-01T12:00:01Z", payload: { response_id: "r1", usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 } } }) + "\n";
    await save(join(roots.codex, "sessions", filename), codex);
    await save(join(roots.codex, "archived_sessions", filename), codex);
    assert.equal(index.snapshot().scanning, true);
    const snapshot = await index.settled();
    SnapshotSchema.parse(snapshot);
    assert.equal(snapshot.sessions.length, 4);
    const main = snapshot.sessions.find((s) => s.id === "claude:c1")!;
    assert.equal(main.agentId, "a");
    assert.equal(main.archived, true);
    assert.equal(main.project, "Project");
    assert.equal(main.providerLabel, "Claude");
    assert.deepEqual(main.labels, ["team"]);
    const child = snapshot.sessions.find((s) => s.kind === "subagent")!;
    assert.equal(child.parentId, main.id);
    assert.equal(child.projectId, "p");
    assert.equal(child.agentId, null);
    assert.equal(snapshot.sessions.find((s) => s.provider === "codex")!.archived, true);
    assert.equal(snapshot.sessions.find((s) => s.nativeId === "missing-session")!.coverage, "missing");
    assert.ok(!JSON.stringify(snapshot).includes("SECRET_MUST_NOT_LEAK"));
    assert.ok(!JSON.stringify(snapshot).includes("PRIVATE_TRANSCRIPT_TEXT"));
    const originalMetadata = await readFile(agentPath, "utf8");
    await appendFile(claudePath, claude("r3"));
    index.snapshot(true);
    const refreshed = await index.settled();
    const mainRow = filterSessions(refreshed.sessions, EMPTY_FILTERS).find((r) => r.session.id === main.id)!;
    assert.equal(mainRow.metrics.inputTokens, 120);
    assert.equal(await readFile(agentPath, "utf8"), originalMetadata);
    await rm(claudePath);
    index.snapshot(true);
    const removed = await index.settled();
    assert.equal(removed.sessions.find((s) => s.id === main.id)!.coverage, "missing");
  } finally { index.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("SQLite stores add OpenCode-family, Devin and Cursor sessions, resolve custom provider IDs and label every provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-usage-stores-"));
  const roots = { paseo: join(root, "paseo"), claude: join(root, "claude"), codex: join(root, "codex"), data: join(root, "data"), cursor: [join(root, "cursor")] };
  const index = new UsageIndex(roots);
  const T0 = Date.parse("2026-09-10T12:00:00Z");
  try {
    await save(join(roots.paseo, "config.json"), JSON.stringify({ agents: { providers: { kilocode: { extends: "acp", label: "Kilo Code", env: { KILO_API_KEY: "SECRET_MUST_NOT_LEAK" } }, cursor: { extends: "acp", label: "Cursor" } } } }));
    await save(join(roots.paseo, "projects", "workspaces.json"), JSON.stringify([{ workspaceId: "w", projectId: "p", cwd: "/worktree", title: "Workspace" }]));
    const agent = (id: string, provider: string, sessionId: string) => save(join(roots.paseo, "agents", "bucket", `${id}.json`), JSON.stringify({ id, provider, cwd: "/worktree", workspaceId: "w", title: id, createdAt: "2026-09-10", persistence: { sessionId, nativeHandle: sessionId } }));
    await Promise.all([agent("kilo-agent", "kilocode", "ses_linked"), agent("devin-agent", "devin", "shared-jargon"), agent("cursor-agent", "cursor", "cursor-session")]);

    await mkdir(join(roots.data, "kilo"), { recursive: true });
    const kiloPath = join(roots.data, "kilo", "kilo.db");
    const kilo = new DatabaseSync(kiloPath);
    kilo.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT);
      INSERT INTO credential VALUES ('c', 'SECRET_MUST_NOT_LEAK');`);
    const insertSession = kilo.prepare("INSERT INTO session VALUES (?, 'project', ?, ?, ?, ?, ?, ?)");
    insertSession.run("ses_linked", null, "/worktree", "Linked", T0, T0 + 9000, null);
    insertSession.run("ses_outside", null, "/outside", "Outside", T0, T0, T0);
    insertSession.run("ses_empty", null, "/outside", "Empty", T0, T0, null);
    insertSession.run("ses_child", "ses_linked", "/worktree", "Child", T0, T0, null);
    const insertMessage = (db: DatabaseSync, id: string, session: string, created: number, data: object) => db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(id, session, created, created, JSON.stringify(data));
    const part = (id: string, messageId: string, data: object) => kilo.prepare("INSERT INTO part VALUES (?, ?, 'ses_linked', ?, ?, ?)").run(id, messageId, T0, T0, JSON.stringify(data));
    const reply = (created: number) => ({ role: "assistant", parentID: "u1", modelID: "anthropic/claude-sonnet-4.5", providerID: "kilo", cost: 0.01, tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 50 } }, time: { created, completed: created + 4000 } });
    insertMessage(kilo, "u1", "ses_linked", T0, { role: "user", time: { created: T0 }, model: { providerID: "anthropic", modelID: "claude-sonnet-4.5" } });
    insertMessage(kilo, "a1", "ses_linked", T0 + 1000, reply(T0 + 1000));
    part("p1", "u1", { type: "text", text: "PRIVATE_TRANSCRIPT_TEXT" });
    part("p2", "a1", { type: "text", text: "hello" });
    part("p3", "a1", { type: "tool", tool: "bash", callID: "call", state: { status: "error", input: { command: "PRIVATE_TOOL_INPUT" }, error: "boom" } });
    part("p4", "a1", { type: "compaction", auto: true });
    insertMessage(kilo, "u2", "ses_outside", T0, { role: "user", time: { created: T0 }, model: { modelID: "kilo-auto/frontier" } });
    insertMessage(kilo, "c1", "ses_child", T0, { ...reply(T0), parentID: "none" });
    kilo.close();

    await mkdir(join(roots.data, "devin", "cli"), { recursive: true });
    const devin = new DatabaseSync(join(roots.data, "devin", "cli", "sessions.db"));
    devin.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, title TEXT, created_at INTEGER, last_activity_at INTEGER);
      CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT);`);
    devin.prepare("INSERT INTO sessions VALUES ('shared-jargon', '/worktree', 'Devin', ?, ?)").run(T0 / 1000, T0 / 1000 + 60);
    const node = (nodeId: number, chat: object) => devin.prepare("INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES ('shared-jargon', ?, ?, ?)").run(nodeId, JSON.stringify(chat), T0 / 1000);
    const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
    const assistant = { message_id: "m2", role: "assistant", content: "hi", tool_calls: [{ id: "call_1", name: "skill", arguments: { name: "PRIVATE_TOOL_INPUT" } }], metadata: { created_at: at(2), generation_model: "gpt-6-astra-medium", telemetry: { source: "assistant" }, metrics: { input_tokens: 3, output_tokens: 7, cache_read_tokens: 1000, cache_creation_tokens: 200 } } };
    node(0, { message_id: "m0", role: "system", content: "PRIVATE_TRANSCRIPT_TEXT", metadata: { created_at: at(0), telemetry: { source: "sysprompt" } } });
    node(1, { message_id: "m1", role: "user", content: "PRIVATE_TRANSCRIPT_TEXT", metadata: { created_at: at(1), is_user_input: true, telemetry: { source: "user" } } });
    node(2, assistant);
    node(3, { message_id: "m3", role: "tool", tool_call_id: "call_1", content: "failed", metadata: { created_at: at(3), extensions: { "chisel/tool_result_meta": { success: false } } } });
    node(4, { message_id: "m4", role: "user", content: "", metadata: { created_at: at(4), telemetry: { source: "cache_keepalive" } } });
    node(5, assistant); // Compaction copy of the same message.
    devin.close();

    // Cursor: hex JSON meta, a protobuf root listing message blob IDs, JSON message blobs and an orphaned stale blob.
    const cursorStore = async (path: string, agentId: string, messages: object[]) => {
      await mkdir(dirname(path), { recursive: true });
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
      const insert = db.prepare("INSERT INTO blobs VALUES (?, ?)");
      const field = (tag: number, bytes: Buffer) => Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
      const ids = messages.map((message, i) => { const id = Buffer.alloc(32, i + 1); insert.run(id.toString("hex"), Buffer.from(JSON.stringify(message))); return id; });
      insert.run(Buffer.alloc(32, 99).toString("hex"), Buffer.from(JSON.stringify({ role: "user", content: "PRIVATE_TRANSCRIPT_TEXT stale" })));
      const root = Buffer.concat([...ids.map((id) => field(0x0a, id)), field(0x4a, Buffer.from("file:///worktree")), Buffer.from([0xd0, 0x01, 0x05])]);
      insert.run("root", root);
      db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId, latestRootBlobId: "root", name: "Cursor task", createdAt: T0, blobEncryptionKey: "SECRET_MUST_NOT_LEAK" })).toString("hex"));
      db.close();
    };
    const cursorModel = (name: string) => ({ providerOptions: { cursor: { modelName: name } } });
    await cursorStore(join(roots.cursor[0], "acp-sessions", "cursor-session", "store.db"), "cursor-session", [
      { role: "system", content: "PRIVATE_TRANSCRIPT_TEXT" },
      { role: "user", content: [{ type: "text", text: "PRIVATE_TRANSCRIPT_TEXT" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "", signature: "x" }, { type: "text", text: "hello", ...cursorModel("cursor-grok-4.6-high") }, { type: "tool-call", toolCallId: "t1", toolName: "Read", args: { path: "PRIVATE_TOOL_INPUT" }, ...cursorModel("cursor-grok-4.6-high") }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "Read", result: "fail" }], providerOptions: { cursor: { highLevelToolCallResult: { output: { error: { errorMessage: "fail" } } } } } },
      { role: "user", content: "again" },
      { role: "assistant", content: [{ type: "text", text: "ok", ...cursorModel("cursor-grok-4.6-xhigh-fast") }] },
    ]);
    await cursorStore(join(roots.cursor[0], "chats", "md5", "cli-chat", "store.db"), "cli-chat", [{ role: "user", content: "hi" }]);
    await mkdir(join(roots.cursor[0], "acp-sessions", "empty"), { recursive: true });

    index.snapshot();
    const snapshot = await index.settled();
    SnapshotSchema.parse(snapshot);
    const serialized = JSON.stringify(snapshot);
    for (const secret of ["SECRET_MUST_NOT_LEAK", "PRIVATE_TRANSCRIPT_TEXT", "PRIVATE_TOOL_INPUT"]) assert.ok(!serialized.includes(secret), secret);
    assert.deepEqual(snapshot.warnings, []);
    assert.deepEqual(snapshot.sessions.map((s) => s.id).sort(), ["cursor:cli-chat", "cursor:cursor-session", "devin:shared-jargon", "kilocode:ses_child", "kilocode:ses_linked", "kilocode:ses_outside"]);
    const row = (sessions: typeof snapshot.sessions, id: string) => filterSessions(sessions, EMPTY_FILTERS).find((r) => r.session.id === id)!;

    const linked = row(snapshot.sessions, "kilocode:ses_linked");
    assert.equal(linked.session.providerLabel, "Kilo Code");
    assert.equal(linked.session.agentId, "kilo-agent");
    assert.equal(linked.session.workspaceId, "w");
    assert.equal(linked.session.coverage, "available");
    const { inputTokens, uncachedTokens, outputTokens, reasoningTokens, requests, userMessages, assistantMessages, toolCalls, toolErrors, toolOutputCharacters, compactions, userCharacters, assistantCharacters, activeMs, reportedCostUsd } = linked.metrics;
    assert.deepEqual({ inputTokens, uncachedTokens, outputTokens, reasoningTokens, requests, userMessages, assistantMessages, toolCalls, toolErrors, toolOutputCharacters, compactions, userCharacters, assistantCharacters, activeMs, reportedCostUsd },
      { inputTokens: 160, uncachedTokens: 10, outputTokens: 25, reasoningTokens: 5, requests: 1, userMessages: 1, assistantMessages: 1, toolCalls: 1, toolErrors: 1, toolOutputCharacters: 4, compactions: 1, userCharacters: 23, assistantCharacters: 5, activeMs: 5000, reportedCostUsd: 0.01 });
    assert.ok(Math.abs(linked.metrics.estimatedCostUsd! - 622.5 / 1e6) < 1e-12);
    assert.deepEqual(linked.buckets.flatMap((b) => Object.entries(b.tools)), [["bash", 1]]);
    const outside = row(snapshot.sessions, "kilocode:ses_outside").session;
    assert.equal(outside.providerLabel, "Kilo Code");
    assert.equal(outside.archived, true);
    const child = row(snapshot.sessions, "kilocode:ses_child").session;
    assert.equal(child.kind, "subagent");
    assert.equal(child.parentId, "kilocode:ses_linked");

    const devinRow = row(snapshot.sessions, "devin:shared-jargon");
    assert.equal(devinRow.session.providerLabel, "Devin");
    assert.equal(devinRow.session.agentId, "devin-agent");
    assert.deepEqual(devinRow.buckets.map((b) => [b.model, b.effort, b.hour]), [["gpt-6-astra", "medium", 12], ["unknown", null, 12]]);
    const d = devinRow.metrics;
    assert.deepEqual([d.inputTokens, d.outputTokens, d.requests, d.userMessages, d.assistantMessages, d.toolCalls, d.toolErrors, d.userCharacters, d.compactions, d.activeMs], [1203, 7, 1, 1, 1, 1, 1, 23, null, null]);
    assert.ok(Math.abs(d.estimatedCostUsd! - 3880 / 1e6) < 1e-12);

    const cursor = row(snapshot.sessions, "cursor:cursor-session");
    assert.equal(cursor.session.providerLabel, "Cursor");
    assert.equal(cursor.session.agentId, "cursor-agent");
    assert.equal(cursor.session.cwd, "/worktree");
    assert.equal(cursor.session.coverage, "partial");
    assert.match(cursor.session.warnings[0], /Cursor keeps no token usage/);
    assert.equal(cursor.session.startedAt, new Date(T0).toISOString());
    assert.deepEqual(cursor.buckets.map((b) => [b.model, b.effort, b.hour]), [["cursor-grok-4.6", "high", 12], ["cursor-grok-4.6-fast", "xhigh", 12]]);
    const c = cursor.metrics;
    assert.deepEqual([c.inputTokens, c.estimatedCostUsd, c.userMessages, c.assistantMessages, c.toolCalls, c.toolErrors, c.userCharacters, c.assistantCharacters, c.toolOutputCharacters, c.compactions], [null, null, 2, 2, 1, 1, 28, 7, 4, null]);
    assert.deepEqual(cursor.buckets.flatMap((b) => Object.entries(b.tools)), [["Read", 1]]);
    assert.equal(row(snapshot.sessions, "cursor:cli-chat").session.agentId, null);

    const reopened = new DatabaseSync(kiloPath);
    insertMessage(reopened, "a2", "ses_linked", T0 + 6000, reply(T0 + 6000));
    reopened.close();
    index.snapshot(true);
    const refreshed = await index.settled();
    assert.equal(row(refreshed.sessions, "kilocode:ses_linked").metrics.inputTokens, 320);
  } finally { index.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("unavailable provider directories produce an empty completed scan without mutating the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-usage-empty-"));
  const index = new UsageIndex({ paseo: join(root, "paseo"), claude: join(root, "claude"), codex: join(root, "codex"), data: join(root, "data"), cursor: [join(root, "cursor")] });
  try {
    index.snapshot();
    const snapshot = await index.settled();
    assert.deepEqual(snapshot.sessions, []);
    assert.equal(snapshot.scanning, false);
    assert.deepEqual(snapshot.warnings, []);
  } finally { index.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("the persistent index serves unchanged sources after a restart and follows changes and deletions", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-usage-persist-"));
  const roots = { paseo: join(root, "paseo"), claude: join(root, "claude"), codex: join(root, "codex"), data: join(root, "data"), cursor: [join(root, "cursor")] };
  const database = join(root, "index", "usage.sqlite");
  const claudePath = join(roots.claude, "projects", "-worktree", "c1.jsonl");
  const record = (input: number) => JSON.stringify({ type: "assistant", uuid: "r1", timestamp: "2026-09-01T12:00:00Z", sessionId: "c1", message: { id: "r1", model: "claude-fable-5", content: [{ type: "text", text: "PRIVATE_TRANSCRIPT_TEXT" }], usage: { input_tokens: input, output_tokens: 5 } } }) + "\n";
  const tokens = async (index: UsageIndex) => {
    index.snapshot(true);
    const snapshot = await index.settled();
    return filterSessions(snapshot.sessions, EMPTY_FILTERS).find((r) => r.session.id === "claude:c1")?.metrics.inputTokens;
  };
  const restart = async () => { const index = new UsageIndex(roots, database); try { return await tokens(index); } finally { index.dispose(); } };
  try {
    const mtime = new Date("2026-09-01T12:00:00Z");
    await save(claudePath, record(100));
    await utimes(claudePath, mtime, mtime);
    assert.equal(await restart(), 100);
    const stored = new DatabaseSync(database, { readOnly: true });
    const rows = stored.prepare("SELECT kind, path, data FROM sources").all() as { kind: string; path: string; data: string }[];
    stored.close();
    assert.deepEqual(rows.map((row) => [row.kind, row.path]), [["file", claudePath]]);
    assert.ok(!rows[0].data.includes("PRIVATE_TRANSCRIPT_TEXT"));

    // Same size and mtime: a restarted index must not reread the file.
    await writeFile(claudePath, record(200));
    await utimes(claudePath, mtime, mtime);
    assert.equal(await restart(), 100);

    await utimes(claudePath, mtime, new Date(mtime.getTime() + 1000));
    assert.equal(await restart(), 200);

    await rm(claudePath);
    assert.equal(await restart(), undefined);
    const emptied = new DatabaseSync(database, { readOnly: true });
    assert.deepEqual(emptied.prepare("SELECT path FROM sources").all(), []);
    emptied.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an index from another version is rebuilt", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-usage-version-"));
  const database = join(root, "usage.sqlite");
  try {
    const old = new DatabaseSync(database);
    old.exec("CREATE TABLE sources (kind TEXT, path TEXT, signature TEXT, data TEXT, indexed_at TEXT); INSERT INTO sources VALUES ('file', '/stale', '1:1', '{}', 'then'); PRAGMA user_version = 999");
    old.close();
    const store = UsageStore.open(database)!;
    assert.deepEqual([...store.load().files.keys()], []);
    store.close();
    const reopened = new DatabaseSync(database, { readOnly: true });
    assert.equal((reopened.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, INDEX_VERSION);
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("snapshots carry a content revision and omit sessions the caller already has", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-usage-revision-"));
  const roots = { paseo: join(root, "paseo"), claude: join(root, "claude"), codex: join(root, "codex"), data: join(root, "data"), cursor: [join(root, "cursor")] };
  const claudePath = join(roots.claude, "projects", "-worktree", "c1.jsonl");
  const record = (id: string) => JSON.stringify({ type: "assistant", uuid: id, timestamp: "2026-09-01T12:00:00Z", sessionId: "c1", message: { id, model: "claude-fable-5", content: [], usage: { input_tokens: 1, output_tokens: 1 } } }) + "\n";
  const scan = async (index: UsageIndex) => { index.snapshot(true); return index.settled(); };
  const first = new UsageIndex(roots, join(root, "usage.sqlite"));
  const second = new UsageIndex(roots, join(root, "usage.sqlite"));
  try {
    assert.equal(first.view().revision, "");
    await first.firstScan(10);
    first.snapshot();
    await first.firstScan(5_000);
    await save(claudePath, record("r1"));
    const initial = await scan(first);
    assert.equal(initial.sessions.length, 1);
    const unchanged = first.view(initial.revision);
    assert.equal(unchanged.unchanged, true);
    assert.deepEqual(unchanged.sessions, []);
    assert.equal((await scan(first)).sessions, initial.sessions);
    assert.equal(first.view("other").sessions.length, 1);
    assert.equal((await scan(second)).revision, initial.revision);

    await appendFile(claudePath, record("r2"));
    const changed = await scan(first);
    assert.notEqual(changed.revision, initial.revision);
    assert.equal(first.view(initial.revision).unchanged, undefined);
  } finally { first.dispose(); second.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("provider profiles from Paseo config add every CLAUDE_CONFIG_DIR and CODEX_HOME and attribute sessions to that provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-usage-profiles-"));
  const roots = { paseo: join(root, "paseo"), claude: join(root, "claude"), codex: join(root, "codex"), data: join(root, "data"), cursor: [join(root, "cursor")] };
  const index = new UsageIndex(roots);
  try {
    await save(join(roots.paseo, "config.json"), JSON.stringify({ agents: { providers: {
      claude: { enabled: false }, codex: { enabled: false },
      "claude-a1": { extends: "claude", label: "Claude Code A1", env: { CLAUDE_CONFIG_DIR: roots.claude, OPENAI_API_KEY: "SECRET_MUST_NOT_LEAK" } },
      "claude-personal": { extends: "claude", label: "Claude Code Personal", env: { CLAUDE_CONFIG_DIR: join(root, "claude-personal") } },
      "codex-personal": { extends: "codex", label: "Codex Personal", env: { CODEX_HOME: join(root, "codex-personal") } },
    } } }));
    const claude = (id: string, sessionId: string) => JSON.stringify({ type: "assistant", uuid: id, timestamp: "2026-09-01T12:00:00Z", sessionId, cwd: "/worktree", message: { id, model: "claude-opus-5", content: [{ type: "text", text: "PRIVATE_TRANSCRIPT_TEXT" }], usage: { input_tokens: 10, output_tokens: 5 } } }) + "\n";
    await save(join(roots.claude, "projects", "-worktree", "a1.jsonl"), claude("r1", "a1"));
    await save(join(root, "claude-personal", "projects", "-worktree", "p1.jsonl"), claude("r2", "p1"));
    const codex = JSON.stringify({ timestamp: "2026-09-01T12:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 0, reasoning_output_tokens: 0 }, last_token_usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 0, reasoning_output_tokens: 0 } } } }) + "\n";
    await save(join(roots.codex, "sessions", "2026", "09", "01", "rollout-2026-09-01T12-00-00-base.jsonl"), codex);
    await save(join(root, "codex-personal", "sessions", "2026", "09", "01", "rollout-2026-09-01T12-00-00-pers.jsonl"), codex);
    // A Paseo agent recorded under the profile provider links to the transcript in that profile's directory.
    await save(join(roots.paseo, "agents", "bucket", "agent.json"), JSON.stringify({ id: "agent", provider: "claude-personal", cwd: "/worktree", workspaceId: "", title: "Personal agent", createdAt: "2026-09-01", persistence: { sessionId: "p1" } }));

    index.snapshot(true);
    const snapshot = await index.settled();
    SnapshotSchema.parse(snapshot);
    const byId = new Map(snapshot.sessions.map((s) => [s.id, s]));
    assert.equal(byId.get("claude-a1:a1")?.providerLabel, "Claude Code A1", "the default directory is claimed by the profile that points at it");
    assert.equal(byId.get("claude-personal:p1")?.providerLabel, "Claude Code Personal");
    assert.equal(byId.get("claude-personal:p1")?.agentId, "agent");
    assert.equal(byId.get("codex-personal:pers")?.providerLabel, "Codex Personal");
    assert.equal(byId.get("codex:base")?.providerLabel, "Codex", "an unclaimed default directory keeps the base provider");
    assert.equal(snapshot.sessions.length, 4);
    assert.ok(!JSON.stringify(snapshot).includes("SECRET_MUST_NOT_LEAK"));
  } finally { index.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("an OpenCode store under the nested launcher data directory is read once, even through a symlinked legacy path", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-usage-opencode-"));
  const roots = { paseo: join(root, "paseo"), claude: join(root, "claude"), codex: join(root, "codex"), data: join(root, "data"), cursor: [] };
  const T0 = Date.parse("2026-10-05T12:00:00Z");
  try {
    const nested = join(roots.data, "opencode", "opencode", "opencode.db");
    await mkdir(dirname(nested), { recursive: true });
    const db = new DatabaseSync(nested);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
    db.prepare("INSERT INTO session VALUES ('ses_kimi', 'project', NULL, '/worktree', 'PRIVATE_TITLE', ?, ?, NULL)").run(T0, T0 + 5000);
    const message = db.prepare("INSERT INTO message VALUES (?, 'ses_kimi', ?, ?, ?)");
    message.run("u1", T0, T0, JSON.stringify({ role: "user", time: { created: T0 } }));
    message.run("a1", T0 + 1000, T0 + 1000, JSON.stringify({ role: "assistant", parentID: "u1", modelID: "k3", providerID: "kimi-code", cost: 0, tokens: { input: 40, output: 10, reasoning: 5, cache: { read: 900, write: 60 } }, time: { created: T0 + 1000, completed: T0 + 3000 } }));
    db.close();
    // The legacy location is an alias of the same file.
    await symlink(nested, join(roots.data, "opencode", "opencode.db"));

    const index = new UsageIndex(roots);
    try {
      index.snapshot();
      const snapshot = await index.settled();
      assert.deepEqual(snapshot.warnings, []);
      assert.deepEqual(snapshot.sessions.map((s) => [s.id, s.provider, s.coverage]), [["opencode:ses_kimi", "opencode", "available"]]);
      const m = filterSessions(snapshot.sessions, EMPTY_FILTERS)[0].metrics;
      // Counted once: uncached 40 + cache read 900 + cache write 60; output includes reasoning once.
      assert.deepEqual([m.inputTokens, m.uncachedTokens, m.cacheReadTokens, m.cacheWriteTokens, m.outputTokens, m.reasoningTokens, m.requests], [1000, 40, 900, 60, 15, 5, 1]);
    } finally {
      index.dispose();
    }

    // Without the alias, the nested store alone is found.
    await rm(join(roots.data, "opencode", "opencode.db"));
    const alone = new UsageIndex(roots);
    try {
      alone.snapshot();
      assert.deepEqual((await alone.settled()).sessions.map((s) => s.id), ["opencode:ses_kimi"]);
    } finally {
      alone.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
