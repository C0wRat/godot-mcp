#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as godot from "./godot.js";

const cfg = godot.loadConfig();

const server = new McpServer({ name: "godot-mcp", version: "0.1.0" });

// Tool results are JSON text; failures come back as isError results so the client can recover.
async function call(fn: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
  }
}

const project = z.string().describe("Project folder name under the projects directory");
const scenePath = z.string().describe('Scene path relative to the project, e.g. "scenes/level1.tscn"');

server.registerTool(
  "create_project",
  {
    description:
      "Create a Godot 4 project with a scenes/ and scripts/ folder and a main scene (scenes/main.tscn, Node2D root). Creates the project under the projects directory.",
    inputSchema: {
      name: z.string().describe("Project folder name (letters, digits, . _ -)"),
      display_name: z.string().optional().describe("Game title shown in Godot; defaults to name"),
    },
  },
  (args) => call(() => godot.createProject(cfg, { name: args.name, displayName: args.display_name })),
);

server.registerTool(
  "create_scene",
  {
    description: "Create a new .tscn scene with a single root node.",
    inputSchema: {
      project,
      scene_path: scenePath,
      root_name: z.string().describe("Root node name (identifier)"),
      root_type: z.string().describe('Root node Godot class, e.g. "Node2D", "Control", "CharacterBody2D"'),
    },
  },
  (args) =>
    call(() =>
      godot.createScene(cfg, {
        project: args.project,
        scenePath: args.scene_path,
        rootName: args.root_name,
        rootType: args.root_type,
      }),
    ),
);

server.registerTool(
  "add_node",
  {
    description:
      "Add a node to an existing scene. Property values are Godot literal expressions, e.g. position: \"Vector2(10, 20)\", text: '\"Hello\"'. A script_path attaches a script to the node.",
    inputSchema: {
      project,
      scene_path: scenePath,
      parent: z.string().optional().describe('Parent path from the root; "." (default) adds it under the root'),
      name: z.string().describe("Node name (identifier)"),
      type: z.string().describe('Godot class, e.g. "Sprite2D", "CollisionShape2D", "Label"'),
      properties: z.record(z.string(), z.string()).optional().describe("Property name to Godot literal value"),
      script_path: z.string().optional().describe('Script to attach, e.g. "scripts/player.gd"'),
    },
  },
  (args) =>
    call(() =>
      godot.addNode(cfg, {
        project: args.project,
        scenePath: args.scene_path,
        parent: args.parent,
        name: args.name,
        type: args.type,
        properties: args.properties,
        scriptPath: args.script_path,
      }),
    ),
);

server.registerTool(
  "create_script",
  {
    description:
      "Create a GDScript file. Without content, writes a template with the given extends type and an empty _ready().",
    inputSchema: {
      project,
      script_path: z.string().describe('Script path relative to the project, e.g. "scripts/player.gd"'),
      extends: z.string().optional().describe('Base class, default "Node"'),
      content: z.string().optional().describe("Full script source; overrides the template"),
    },
  },
  (args) =>
    call(() =>
      godot.createScript(cfg, {
        project: args.project,
        scriptPath: args.script_path,
        extendsType: args.extends,
        content: args.content,
      }),
    ),
);

server.registerTool(
  "set_main_scene",
  {
    description: "Set the scene that runs when the game starts.",
    inputSchema: { project, scene_path: scenePath },
  },
  (args) => call(() => godot.setMainScene(cfg, { project: args.project, scenePath: args.scene_path })),
);

server.registerTool(
  "validate_project",
  {
    description:
      "Check every script for parse errors and run the project headless to catch scene and load errors. Returns ok: true only when Godot reports no errors.",
    inputSchema: { project },
  },
  (args) => call(() => godot.validateProject(cfg, { project: args.project })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`godot-mcp ready (projects: ${cfg.projectsDir}, godot: ${cfg.godotPath})`);
