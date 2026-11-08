// Drives the built server over MCP stdio, the way an AI client would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

test("an MCP client builds a small playable Godot game and validates it", async () => {
  const projectsDir = await mkdtemp(path.join(os.tmpdir(), "godot-mcp-e2e-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, GODOT_PROJECTS_DIR: projectsDir },
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e-test", version: "0.0.0" });
  await client.connect(transport);

  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["add_node", "create_project", "create_scene", "create_script", "set_main_scene", "validate_project"]);

    const call = async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content[0].text;
      return { isError: res.isError === true, text, json: res.isError ? null : JSON.parse(text) };
    };

    assert.equal((await call("create_project", { name: "shooter", display_name: "Shooter" })).isError, false);
    assert.equal((await call("create_script", {
      project: "shooter",
      script_path: "scripts/player.gd",
      extends: "CharacterBody2D",
      content: "extends CharacterBody2D\n\nconst SPEED := 200.0\n\nfunc _physics_process(delta: float) -> void:\n\tvelocity.x = Input.get_axis(\"ui_left\", \"ui_right\") * SPEED\n\tmove_and_slide()\n",
    })).isError, false);
    assert.equal((await call("add_node", {
      project: "shooter",
      scene_path: "scenes/main.tscn",
      name: "Player",
      type: "CharacterBody2D",
      properties: { position: "Vector2(320, 240)" },
      script_path: "scripts/player.gd",
    })).isError, false);
    assert.equal((await call("add_node", {
      project: "shooter",
      scene_path: "scenes/main.tscn",
      parent: "Player",
      name: "Shape",
      type: "CollisionShape2D",
    })).isError, false);

    const good = await call("validate_project", { project: "shooter" });
    assert.equal(good.isError, false, good.text);
    assert.equal(good.json.ok, true, good.text);

    // A typo in a script must be reported, not silently accepted.
    assert.equal((await call("create_script", {
      project: "shooter",
      script_path: "scripts/enemy.gd",
      content: "extends Node2D\n\nfunc _ready() -> void:\n\tvar x = \n",
    })).isError, false);
    const bad = await call("validate_project", { project: "shooter" });
    assert.equal(bad.json.ok, false);
    assert.ok(bad.json.errors.some((e) => /enemy\.gd|Parse Error/.test(e)), bad.text);

    // Duplicate and missing-parent edits come back as tool errors, not crashes.
    assert.equal((await call("add_node", { project: "shooter", scene_path: "scenes/main.tscn", name: "Player", type: "Node" })).isError, true);
    assert.equal((await call("add_node", { project: "shooter", scene_path: "scenes/main.tscn", parent: "Nope", name: "X", type: "Node" })).isError, true);

    const scene = await readFile(path.join(projectsDir, "shooter", "scenes", "main.tscn"), "utf8");
    assert.match(scene, /\[node name="Shape" type="CollisionShape2D" parent="Player"\]/);
  } finally {
    await client.close();
    await rm(projectsDir, { recursive: true, force: true });
  }
});
