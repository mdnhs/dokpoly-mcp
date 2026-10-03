import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { Dokploy, findOp, isDestructive, ops, redact } from "./dokploy/client.js";

const MAX = 60_000;
const KINDS = ["application", "compose", "postgres", "mysql", "mariadb", "mongo", "redis", "libsql"] as const;

const out = (cfg: Config, data: unknown) => {
  let text = JSON.stringify(redact(data, cfg.revealSecrets), null, 1) ?? "null";
  if (text.length > MAX) text = text.slice(0, MAX) + `\n…[truncated ${text.length - MAX} chars]`;
  // Dokploy data is untrusted: it is returned as data only.
  return { content: [{ type: "text" as const, text }] };
};
const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });

function summarize(node: unknown, acc: any[] = [], proj?: string): any[] {
  if (Array.isArray(node)) { node.forEach((n) => summarize(n, acc, proj)); return acc; }
  if (node && typeof node === "object") {
    const o = node as Record<string, any>;
    let p = proj;
    if (o.projectId && o.name && !o.environmentId) p = o.name;
    for (const k of KINDS) {
      if (o[`${k}Id`] && o.name) acc.push({ kind: k, id: o[`${k}Id`], name: o.name, status: o.applicationStatus ?? o.composeStatus, project: p });
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") summarize(v, acc, p);
  }
  return acc;
}

export function buildServer(cfg: Config, who: string) {
  const dk = new Dokploy(cfg);
  const server = new McpServer({ name: "dokploy", version: "1.0.0" });
  const log = (tool: string, args: unknown) =>
    console.log(JSON.stringify({ t: new Date().toISOString(), who, tool, args }));

  server.registerTool("dokploy_overview", {
    description: "List all Dokploy projects and the services (applications, compose stacks, databases) in them, with ids and status.",
    annotations: { readOnlyHint: true },
  }, async () => {
    log("overview", {});
    try { return out(cfg, summarize(await dk.call("GET", "/project.all"))); } catch (e: any) { return fail(e.message); }
  });

  server.registerTool("dokploy_get", {
    description: "Get full details of one service by kind and id (secrets are redacted).",
    inputSchema: { kind: z.enum(KINDS), id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ kind, id }) => {
    log("get", { kind, id });
    try { return out(cfg, await dk.call("GET", `/${kind}.one`, { [`${kind}Id`]: id })); } catch (e: any) { return fail(e.message); }
  });

  if (!cfg.readOnly) {
    server.registerTool("dokploy_deploy", {
      description: "Trigger a deploy (or redeploy) of an application or compose stack.",
      inputSchema: { kind: z.enum(["application", "compose"]), id: z.string().min(1), redeploy: z.boolean().optional() },
    }, async ({ kind, id, redeploy }) => {
      log("deploy", { kind, id, redeploy });
      try {
        return out(cfg, await dk.call("POST", `/${kind}.${redeploy ? "redeploy" : "deploy"}`, { [`${kind}Id`]: id }));
      } catch (e: any) { return fail(e.message); }
    });
  }

  server.registerTool("dokploy_search_api", {
    description: "Search the Dokploy API catalog (≈600 operations) by keyword and/or tag. Use before dokploy_call_api to find the path and parameters.",
    inputSchema: { query: z.string().optional(), tag: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ query, tag, limit }) => {
    const q = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const hits = ops.filter((o) =>
      (!tag || o.tag.toLowerCase() === tag.toLowerCase()) &&
      q.every((w) => `${o.p} ${o.s} ${o.tag}`.toLowerCase().includes(w)),
    ).slice(0, limit ?? 20).map((o) => ({
      method: o.m, path: o.p, summary: o.s, needsConfirm: isDestructive(o),
      params: o.params.map((p) => `${p.n}${p.r ? "*" : ""}${p.t ? `:${p.t}` : ""}`).join(", "),
    }));
    return out(cfg, hits);
  });

  server.registerTool("dokploy_call_api", {
    description:
      "Call any Dokploy API operation (find it with dokploy_search_api). GET params go in the query, POST params in the JSON body. " +
      "Operations that delete, stop, update or otherwise change/remove things require confirm=true: describe the action to the user and get their approval first." +
      (cfg.readOnly ? " This server is READ-ONLY: only GET operations work." : ""),
    inputSchema: {
      method: z.enum(["GET", "POST"]),
      path: z.string().describe("e.g. /application.one"),
      params: z.record(z.string(), z.any()).optional(),
      confirm: z.boolean().optional(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ method, path, params, confirm }) => {
    const op = findOp(method, path);
    if (!op) return fail(`Unknown operation ${method} ${path}. Use dokploy_search_api.`);
    log("call_api", { method, path, params: Object.keys(params ?? {}) });
    if (cfg.readOnly && method !== "GET") return fail("Server is in READ_ONLY mode.");
    if (isDestructive(op) && confirm !== true)
      return fail(`${method} ${path} changes or removes things. Tell the user exactly what will happen, and if they agree call again with confirm=true.`);
    try { return out(cfg, await dk.call(method, path, params ?? {})); } catch (e: any) { return fail(e.message); }
  });

  return server;
}
