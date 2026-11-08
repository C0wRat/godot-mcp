# godot-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant create and validate [Godot 4](https://godotengine.org) games. It writes real project files (`project.godot`, `.tscn` scenes, `.gd` scripts), then runs Godot headless to check them.

## Requirements

- Node.js 18 or newer
- Godot 4.x on your `PATH` (or set `GODOT_PATH`). Tested with Godot 4.6.3.

## Install

```bash
git clone https://github.com/C0wRat/godot-mcp.git
cd godot-mcp
npm install
npm run build
```

## Connect to Claude Code

```bash
claude mcp add godot \
  -e GODOT_PROJECTS_DIR="$HOME/godot-projects" \
  -- node /absolute/path/to/godot-mcp/dist/server.js
```

Or add it to a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/dist/server.js"],
      "env": { "GODOT_PROJECTS_DIR": "/home/you/godot-projects" }
    }
  }
}
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GODOT_PROJECTS_DIR` | `~/godot-projects` | Folder that holds every project. All writes stay inside it. |
| `GODOT_PATH` | `godot` | Godot executable. |

## Tools

| Tool | What it does |
| --- | --- |
| `create_project` | Creates a project folder with `scenes/`, `scripts/`, and a `Main` Node2D scene set as the main scene. |
| `create_scene` | Creates a `.tscn` scene with one root node. |
| `add_node` | Adds a node to a scene. Optional `properties` take Godot literal values (`"Vector2(10, 20)"`). Optional `script_path` attaches a script. |
| `create_script` | Creates a `.gd` script from a template, or from `content` you provide. |
| `set_main_scene` | Sets the scene that runs on start. |
| `validate_project` | Checks every script for parse errors and runs the project headless. Returns `ok` and the Godot error lines. |

Paths are relative to the project. Absolute paths and paths that escape the project folder are rejected.

## Example session

An assistant with this server can build a small game like this:

1. `create_project` with `name: "shooter"`
2. `create_script` for `scripts/player.gd`, extending `CharacterBody2D`
3. `add_node` for `Player` with `script_path: "scripts/player.gd"`
4. `add_node` for `CollisionShape2D` under `parent: "Player"`
5. `validate_project`, which must return `ok: true` before the game is considered working

## Limitations

- The server creates and edits files. It does not open the Godot editor or play the game in a window.
- It cannot read or change existing scripts or nodes, and it does not remove nodes. `create_script` refuses to overwrite a file.
- Node and class names are checked as identifiers. Whether a class exists is only known when `validate_project` runs.
- Property values are passed through as Godot literals and are not type-checked until validation.

## Development

```bash
npm test
```

`npm test` builds the project, then runs unit tests for the file logic and an end-to-end test. The end-to-end test starts the server over MCP stdio and builds a small game. Both need Godot on `PATH` or `GODOT_PATH`.

## License

MIT
