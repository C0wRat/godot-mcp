import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Config {
  /** Directory that holds every project this server manages. */
  projectsDir: string;
  /** Godot executable (name on PATH or absolute path). */
  godotPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    projectsDir: path.resolve(env.GODOT_PROJECTS_DIR ?? path.join(os.homedir(), "godot-projects")),
    godotPath: env.GODOT_PATH ?? "godot",
  };
}

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROP_RE = /^[A-Za-z_][A-Za-z0-9_/]*$/;
const GODOT_TIMEOUT_MS = 120_000;

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function projectDir(cfg: Config, project: string): string {
  assert(PROJECT_RE.test(project), `invalid project name "${project}" (letters, digits, . _ - only)`);
  return path.join(cfg.projectsDir, project);
}

async function requireProject(dir: string): Promise<void> {
  assert(existsSync(path.join(dir, "project.godot")), `project not found: ${path.basename(dir)}`);
}

/** Resolve a project-relative path, refusing absolute paths, escapes, and wrong extensions. */
function inProject(dir: string, rel: string, ext: string): string {
  assert(!path.isAbsolute(rel), `path must be relative to the project: ${rel}`);
  assert(rel.endsWith(ext), `path must end with ${ext}: ${rel}`);
  const full = path.resolve(dir, rel);
  assert(full.startsWith(dir + path.sep), `path escapes the project: ${rel}`);
  return full;
}

function resPath(dir: string, full: string): string {
  return "res://" + path.relative(dir, full).split(path.sep).join("/");
}

async function createNew(full: string, content: string, what: string): Promise<void> {
  await mkdir(path.dirname(full), { recursive: true });
  try {
    await writeFile(full, content, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${what} already exists`);
    throw err;
  }
}

function projectFile(displayName: string): string {
  return [
    "config_version=5",
    "",
    "[application]",
    "",
    `config/name=${JSON.stringify(displayName)}`,
    'config/features=PackedStringArray("4.6")',
    "",
  ].join("\n");
}

function sceneFile(rootName: string, rootType: string): string {
  return `[gd_scene format=3]\n\n[node name="${rootName}" type="${rootType}"]\n`;
}

function scriptTemplate(extendsType: string): string {
  return `extends ${extendsType}\n\n\nfunc _ready() -> void:\n\tpass\n`;
}

export async function createProject(cfg: Config, input: { name: string; displayName?: string }) {
  const dir = projectDir(cfg, input.name);
  const displayName = input.displayName ?? input.name;
  assert(!/[\r\n]/.test(displayName), "display name must be a single line");

  await mkdir(cfg.projectsDir, { recursive: true });
  try {
    await mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`project "${input.name}" already exists`);
    throw err;
  }
  await mkdir(path.join(dir, "scenes"));
  await mkdir(path.join(dir, "scripts"));
  await writeFile(path.join(dir, "project.godot"), projectFile(displayName));
  await writeFile(path.join(dir, ".gitignore"), ".godot/\n");

  await createScene(cfg, { project: input.name, scenePath: "scenes/main.tscn", rootName: "Main", rootType: "Node2D" });
  await setMainScene(cfg, { project: input.name, scenePath: "scenes/main.tscn" });
  return { project: input.name, path: dir, main_scene: "res://scenes/main.tscn" };
}

export async function createScene(
  cfg: Config,
  input: { project: string; scenePath: string; rootName: string; rootType: string },
) {
  const dir = projectDir(cfg, input.project);
  await requireProject(dir);
  const full = inProject(dir, input.scenePath, ".tscn");
  assert(IDENT_RE.test(input.rootName), `root name must be an identifier: ${input.rootName}`);
  assert(IDENT_RE.test(input.rootType), `root type must be a Godot class name: ${input.rootType}`);
  await createNew(full, sceneFile(input.rootName, input.rootType), `scene ${input.scenePath}`);
  return { scene: resPath(dir, full) };
}

interface SceneNode {
  /** Path from the root, "." for the root itself. */
  path: string;
}

function headerAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

/** Derive node paths from `[node ...]` headers. Godot writes parent relative to the root. */
function parseNodes(lines: string[]): SceneNode[] {
  const nodes: SceneNode[] = [];
  for (const line of lines) {
    if (!line.startsWith("[node ")) continue;
    const attrs = headerAttrs(line);
    if (attrs.parent === undefined) {
      nodes.push({ path: "." });
    } else {
      const p = attrs.parent === "." ? attrs.name : `${attrs.parent}/${attrs.name}`;
      nodes.push({ path: p });
    }
  }
  return nodes;
}

function nextExtId(lines: string[]): string {
  let max = 0;
  for (const line of lines) {
    if (!line.startsWith("[ext_resource ")) continue;
    const id = Number(headerAttrs(line).id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return String(max + 1);
}

export async function addNode(
  cfg: Config,
  input: {
    project: string;
    scenePath: string;
    parent?: string;
    name: string;
    type: string;
    properties?: Record<string, string>;
    scriptPath?: string;
  },
) {
  const dir = projectDir(cfg, input.project);
  await requireProject(dir);
  const full = inProject(dir, input.scenePath, ".tscn");
  assert(existsSync(full), `scene not found: ${input.scenePath}`);
  const parent = input.parent ?? ".";
  assert(IDENT_RE.test(input.name), `node name must be an identifier: ${input.name}`);
  assert(IDENT_RE.test(input.type), `node type must be a Godot class name: ${input.type}`);
  const props = Object.entries(input.properties ?? {});
  for (const [key, value] of props) {
    assert(PROP_RE.test(key), `invalid property name: ${key}`);
    assert(!/[\r\n]/.test(value), `property ${key} value must be a single line`);
  }

  const text = await readFile(full, "utf8");
  const lines = text.replace(/\n+$/, "").split("\n");
  assert(lines[0]?.startsWith("[gd_scene"), `not a scene file: ${input.scenePath}`);

  const nodes = parseNodes(lines);
  assert(nodes.length > 0, "scene has no root node");
  assert(nodes.some((n) => n.path === parent), `parent not found in scene: ${parent}`);
  const childPath = parent === "." ? input.name : `${parent}/${input.name}`;
  assert(!nodes.some((n) => n.path === childPath), `node already exists: ${childPath}`);

  let scriptId: string | undefined;
  if (input.scriptPath !== undefined) {
    const scriptFull = inProject(dir, input.scriptPath, ".gd");
    assert(existsSync(scriptFull), `script not found: ${input.scriptPath}`);
    scriptId = nextExtId(lines);
    let insertAt = 0;
    lines.forEach((l, i) => {
      if (l.startsWith("[ext_resource ") || l.startsWith("[gd_scene")) insertAt = i + 1;
    });
    lines.splice(insertAt, 0, `[ext_resource type="Script" path="${resPath(dir, scriptFull)}" id="${scriptId}"]`);
  }

  const block = [`[node name="${input.name}" type="${input.type}" parent="${parent}"]`];
  if (scriptId !== undefined) block.push(`script = ExtResource("${scriptId}")`);
  for (const [key, value] of props) block.push(`${key} = ${value}`);

  lines.push("", ...block);
  await writeFile(full, lines.join("\n") + "\n");
  return { node: childPath, scene: resPath(dir, full) };
}

export async function setMainScene(cfg: Config, input: { project: string; scenePath: string }) {
  const dir = projectDir(cfg, input.project);
  await requireProject(dir);
  const full = inProject(dir, input.scenePath, ".tscn");
  assert(existsSync(full), `scene not found: ${input.scenePath}`);
  const setting = `run/main_scene="${resPath(dir, full)}"`;

  const file = path.join(dir, "project.godot");
  const lines = (await readFile(file, "utf8")).replace(/\n+$/, "").split("\n");
  const header = lines.indexOf("[application]");
  if (header === -1) {
    lines.push("", "[application]", "", setting);
  } else {
    let end = lines.findIndex((l, i) => i > header && l.startsWith("["));
    if (end === -1) end = lines.length;
    const existing = lines.findIndex((l, i) => i > header && i < end && l.startsWith("run/main_scene="));
    if (existing !== -1) lines[existing] = setting;
    else lines.splice(end, 0, setting);
  }
  await writeFile(file, lines.join("\n") + "\n");
  return { main_scene: resPath(dir, full) };
}

export async function createScript(
  cfg: Config,
  input: { project: string; scriptPath: string; extendsType?: string; content?: string },
) {
  const dir = projectDir(cfg, input.project);
  await requireProject(dir);
  const full = inProject(dir, input.scriptPath, ".gd");
  const extendsType = input.extendsType ?? "Node";
  assert(IDENT_RE.test(extendsType), `extends must be a Godot class name: ${extendsType}`);
  await createNew(full, input.content ?? scriptTemplate(extendsType), `script ${input.scriptPath}`);
  return { script: resPath(dir, full) };
}

async function listScripts(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name === ".godot") continue;
    const next = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...(await listScripts(dir, next)));
    else if (entry.name.endsWith(".gd")) out.push(next);
  }
  return out;
}

function runGodot(cfg: Config, dir: string, args: string[]): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.godotPath, ["--headless", "--path", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GODOT_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to start Godot at "${cfg.godotPath}": ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** Pull error lines (plus the line after each, which carries the location) out of Godot output. */
function errorLines(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim());
  const found: string[] = [];
  lines.forEach((l, i) => {
    if (/\bERROR\b/.test(l)) {
      found.push(l);
      if (lines[i + 1]) found.push(lines[i + 1]);
    }
  });
  return found;
}

export async function validateProject(cfg: Config, input: { project: string }) {
  const dir = projectDir(cfg, input.project);
  await requireProject(dir);
  const errors: string[] = [];

  // --quit exits 0 even when a script fails to parse, so errors come from the output.
  // Per-script --check-only catches scripts no scene references.
  const scripts = await listScripts(dir);
  for (const script of scripts) {
    const rel = script.split(path.sep).join("/");
    const result = await runGodot(cfg, dir, ["--check-only", "--script", `res://${rel}`]);
    if (result.timedOut) errors.push(`${rel}: timed out`);
    else if (result.code !== 0) errors.push(...(errorLines(result.output).length ? errorLines(result.output) : [`${rel}: check failed (exit ${result.code})`]));
  }

  const run = await runGodot(cfg, dir, ["--quit"]);
  if (run.timedOut) errors.push("project run timed out");
  errors.push(...errorLines(run.output));

  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique, scripts_checked: scripts.length };
}
