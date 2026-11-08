import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as godot from "../dist/godot.js";

let root;
let cfg;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "godot-mcp-test-"));
  cfg = { projectsDir: root, godotPath: process.env.GODOT_PATH ?? "godot" };
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("create_project writes a runnable project with a main scene", async () => {
  const result = await godot.createProject(cfg, { name: "demo", displayName: "Demo Game" });
  assert.equal(result.main_scene, "res://scenes/main.tscn");
  const projectFile = await readFile(path.join(root, "demo", "project.godot"), "utf8");
  assert.match(projectFile, /config\/name="Demo Game"/);
  assert.match(projectFile, /run\/main_scene="res:\/\/scenes\/main\.tscn"/);
  const scene = await readFile(path.join(root, "demo", "scenes", "main.tscn"), "utf8");
  assert.match(scene, /\[node name="Main" type="Node2D"\]/);
});

test("create_project refuses an existing project", async () => {
  await assert.rejects(godot.createProject(cfg, { name: "demo" }), /already exists/);
});

test("project names and paths are confined", async () => {
  await assert.rejects(godot.createProject(cfg, { name: "../escape" }), /invalid project name/);
  await assert.rejects(godot.createProject(cfg, { name: "a/b" }), /invalid project name/);
  await assert.rejects(
    godot.createScript(cfg, { project: "demo", scriptPath: "../outside.gd" }),
    /escapes the project|must be relative/,
  );
  await assert.rejects(
    godot.createScript(cfg, { project: "demo", scriptPath: "/etc/x.gd" }),
    /must be relative/,
  );
  await assert.rejects(
    godot.createScene(cfg, { project: "demo", scenePath: "scenes/x.txt", rootName: "A", rootType: "Node" }),
    /must end with .tscn/,
  );
});

test("add_node builds a hierarchy, attaches scripts, and checks parents", async () => {
  await godot.createScript(cfg, { project: "demo", scriptPath: "scripts/player.gd", extendsType: "CharacterBody2D" });
  await godot.addNode(cfg, {
    project: "demo",
    scenePath: "scenes/main.tscn",
    name: "Player",
    type: "CharacterBody2D",
    properties: { position: "Vector2(10, 20)" },
    scriptPath: "scripts/player.gd",
  });
  await godot.addNode(cfg, {
    project: "demo",
    scenePath: "scenes/main.tscn",
    parent: "Player",
    name: "Sprite",
    type: "Sprite2D",
  });
  const scene = await readFile(path.join(root, "demo", "scenes", "main.tscn"), "utf8");
  assert.match(scene, /\[ext_resource type="Script" path="res:\/\/scripts\/player\.gd" id="1"\]/);
  assert.match(scene, /\[node name="Player" type="CharacterBody2D" parent="\."\]\nscript = ExtResource\("1"\)\nposition = Vector2\(10, 20\)/);
  assert.match(scene, /\[node name="Sprite" type="Sprite2D" parent="Player"\]/);

  await assert.rejects(
    godot.addNode(cfg, { project: "demo", scenePath: "scenes/main.tscn", parent: "Missing", name: "X", type: "Node" }),
    /parent not found/,
  );
  await assert.rejects(
    godot.addNode(cfg, { project: "demo", scenePath: "scenes/main.tscn", name: "Player", type: "Node" }),
    /already exists/,
  );
});

test("add_node rejects values that would break the scene file", async () => {
  await assert.rejects(
    godot.addNode(cfg, {
      project: "demo",
      scenePath: "scenes/main.tscn",
      name: "Label",
      type: "Label",
      properties: { text: '"a"\n[node name="Evil" type="Node" parent="."]' },
    }),
    /single line/,
  );
  await assert.rejects(
    godot.addNode(cfg, { project: "demo", scenePath: "scenes/main.tscn", name: "bad name", type: "Node" }),
    /identifier/,
  );
});

test("set_main_scene replaces the existing setting", async () => {
  await godot.createScene(cfg, { project: "demo", scenePath: "scenes/level1.tscn", rootName: "Level1", rootType: "Node2D" });
  await godot.setMainScene(cfg, { project: "demo", scenePath: "scenes/level1.tscn" });
  const projectFile = await readFile(path.join(root, "demo", "project.godot"), "utf8");
  assert.match(projectFile, /run\/main_scene="res:\/\/scenes\/level1\.tscn"/);
  assert.equal((projectFile.match(/run\/main_scene=/g) ?? []).length, 1);
});

test("validate_project passes a good project and reports a broken script", async () => {
  const good = await godot.validateProject(cfg, { project: "demo" });
  assert.deepEqual(good.errors, []);
  assert.equal(good.ok, true);

  await godot.createScript(cfg, {
    project: "demo",
    scriptPath: "scripts/broken.gd",
    content: "extends Node\n\nfunc _ready() -> void:\n\tvar x = \n",
  });
  const bad = await godot.validateProject(cfg, { project: "demo" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /Parse Error/.test(e)), bad.errors.join("\n"));
});

test("validate_project catches an unknown node type", async () => {
  await godot.createProject(cfg, { name: "typo" });
  await godot.addNode(cfg, { project: "typo", scenePath: "scenes/main.tscn", name: "Thing", type: "NotARealType" });
  await godot.setMainScene(cfg, { project: "typo", scenePath: "scenes/main.tscn" });
  const result = await godot.validateProject(cfg, { project: "typo" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /NotARealType/.test(e)), result.errors.join("\n"));
});

test("loadConfig honours environment overrides", () => {
  const c = godot.loadConfig({ GODOT_PROJECTS_DIR: "/tmp/x", GODOT_PATH: "/opt/godot" });
  assert.equal(c.projectsDir, "/tmp/x");
  assert.equal(c.godotPath, "/opt/godot");
  assert.equal(godot.loadConfig({}).godotPath, "godot");
});
