#!/usr/bin/env node
import { main } from "./index.js";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "The MCP server stopped.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
