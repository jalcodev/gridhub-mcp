#!/usr/bin/env node
// stdio → Streamable HTTP bridge for clients that can't speak remote MCP
// directly. Delegates to mcp-remote; the real server is hosted at
// https://api.grid-hub.app/mcp. Set GRIDHUB_API_KEY for full data.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const ENDPOINT = process.env.GRIDHUB_MCP_URL ?? "https://api.grid-hub.app/mcp";
const args = [ENDPOINT, "--transport", "http-only"];
if (process.env.GRIDHUB_API_KEY) {
  args.push("--header", `Authorization: Bearer ${process.env.GRIDHUB_API_KEY}`);
}

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("mcp-remote/package.json"));
const bin = join(pkgDir, require("mcp-remote/package.json").bin["mcp-remote"]);

const child = spawn(process.execPath, [bin, ...args], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
