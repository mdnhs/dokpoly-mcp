import express from "express";
import { jwtVerify } from "jose";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { StatelessProvider, SCOPE } from "./oauth/provider.js";
import { buildServer } from "./tools.js";

const cfg = loadConfig();
const provider = new StatelessProvider(cfg);
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const cookie = (req: express.Request, name: string) =>
  (req.headers.cookie ?? "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];
const page = (body: string, status = 200) => ({ status, html: `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Dokploy MCP</title><style>body{font:16px system-ui;max-width:460px;margin:12vh auto;padding:0 16px}button{font:inherit;padding:10px 18px;margin-right:8px}code{background:#eee;padding:1px 5px;border-radius:4px}</style>${body}` });
const send = (res: express.Response, p: { status: number; html: string }) => { res.setHeader("Cache-Control", "no-store"); res.status(p.status).type("html").send(p.html); };

const resourceServerUrl = new URL(`${cfg.publicUrl}/mcp`);
app.use(mcpAuthRouter({
  provider,
  issuerUrl: new URL(cfg.publicUrl),
  resourceServerUrl,
  scopesSupported: [SCOPE],
  resourceName: "Dokploy MCP",
}));

app.get("/health", (_req, res) => { res.json({ ok: true }); });

// Step 2: GitHub redirects back here. Verify identity, then require explicit consent.
app.get("/github/callback", async (req, res) => {
  try {
    const { code, state } = req.query as Record<string, string>;
    if (!code || !state) return send(res, page("<h3>Bad request</h3>", 400));
    const { payload: txn } = await jwtVerify(state, cfg.authSecret, { issuer: "dokploy-mcp", algorithms: ["HS256"] });
    if (txn.typ !== "txn" || cookie(req, "mcp_n") !== txn.n) return send(res, page("<h3>Session mismatch</h3><p>Start the connection again from Claude.</p>", 400));

    const tr = await fetch(new URL("/login/oauth/access_token", cfg.githubAuthBase), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: cfg.githubClientId, client_secret: cfg.githubClientSecret, code, redirect_uri: `${cfg.publicUrl}/github/callback` }),
    });
    const tj: any = await tr.json();
    if (!tj.access_token) return send(res, page("<h3>GitHub login failed</h3>", 400));
    const ur = await fetch(new URL("/user", cfg.githubApiBase), { headers: { authorization: `Bearer ${tj.access_token}`, accept: "application/json", "user-agent": "dokploy-mcp" } });
    const user: any = await ur.json();
    const ok = cfg.allowedId ? String(user.id) === cfg.allowedId : String(user.login).toLowerCase() === cfg.allowedLogin;
    if (!ok) { console.warn("denied github user", user.login); return send(res, page("<h3>Access denied</h3><p>This GitHub account is not allowed.</p>", 403)); }

    const client = await provider.clientsStore.getClient(String(txn.cid));
    const consent = await provider.sign("consent", { txn: state, sub: String(user.id), n: txn.n }, 300);
    let host = "";
    try { host = new URL(String(txn.ru)).host; } catch {}
    send(res, page(`<h3>Allow access to Dokploy?</h3>
<p>Signed in as <b>${esc(user.login)}</b>.</p>
<p><b>${esc(client?.client_name ?? "An application")}</b> wants to manage your Dokploy server and will be sent back to <code>${esc(host)}</code>.</p>
<form method=post action="/consent"><input type=hidden name=consent value="${esc(consent)}">
<button name=decision value=allow>Allow</button><button name=decision value=deny>Deny</button></form>`));
  } catch (e) {
    console.error("callback error", e);
    send(res, page("<h3>Link expired or invalid</h3><p>Start the connection again from Claude.</p>", 400));
  }
});

// Step 3: consent submitted -> mint authorization code and return to the client.
app.post("/consent", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const c = await provider.verify("consent", String(req.body.consent));
    if (cookie(req, "mcp_n") !== c.n) return send(res, page("<h3>Session mismatch</h3>", 400));
    const txn = await provider.verify("txn", String(c.txn));
    const ru = new URL(String(txn.ru));
    res.clearCookie("mcp_n", { path: "/" });
    if (req.body.decision !== "allow") {
      ru.searchParams.set("error", "access_denied");
    } else {
      ru.searchParams.set("code", await provider.mintCode(txn, String(c.sub)));
    }
    if (txn.st) ru.searchParams.set("state", String(txn.st));
    res.redirect(ru.href);
  } catch { send(res, page("<h3>Link expired or invalid</h3>", 400)); }
});

// MCP endpoint (stateless Streamable HTTP, one server instance per request).
const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl) });
app.post("/mcp", bearer, express.json({ limit: "2mb" }), async (req, res) => {
  const server = buildServer(cfg, String(req.auth?.extra?.sub ?? "?"));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("mcp error", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.all("/mcp", (_req, res) => { res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }); });

app.listen(cfg.port, () => console.log(`dokploy-mcp listening on :${cfg.port} (${cfg.publicUrl}) readOnly=${cfg.readOnly}`));
