import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const P = { gh: 4101, dk: 4102, app: 4100 };
const APP = `http://localhost:${P.app}`;
let ghUser = { id: 777, login: "mdnhs" };
const dkCalls: string[] = [];

const listen = (port: number, h: http.RequestListener) => new Promise<http.Server>((r) => { const s = http.createServer(h); s.listen(port, () => r(s)); });
const body = (req: http.IncomingMessage) => new Promise<string>((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); });

const gh = await listen(P.gh, async (req, res) => {
  const u = new URL(req.url!, "http://x");
  if (u.pathname === "/login/oauth/authorize") {
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "ghcode"); back.searchParams.set("state", u.searchParams.get("state")!);
    res.writeHead(302, { location: back.href }).end();
  } else if (u.pathname === "/login/oauth/access_token") {
    const b = JSON.parse(await body(req));
    assert.equal(b.client_secret, "gh-secret");
    res.setHeader("content-type", "application/json").end(JSON.stringify({ access_token: "ghtok" }));
  } else if (u.pathname === "/user") {
    assert.equal(req.headers.authorization, "Bearer ghtok");
    res.setHeader("content-type", "application/json").end(JSON.stringify(ghUser));
  } else res.writeHead(404).end();
});
const dk = await listen(P.dk, (req, res) => {
  assert.equal(req.headers["x-api-key"], "dk-key");
  dkCalls.push(`${req.method} ${req.url}`);
  res.setHeader("content-type", "application/json");
  if (req.url!.startsWith("/api/project.all")) res.end(JSON.stringify([{ projectId: "p1", name: "Raynx", environments: [{ environmentId: "e1", applications: [{ applicationId: "a1", name: "web", applicationStatus: "done", env: "SECRET=1", password: "x" }], compose: [{ composeId: "c1", name: "plane", composeStatus: "running" }] }] }]));
  else if (req.url!.startsWith("/api/application.one")) res.end(JSON.stringify({ applicationId: "a1", name: "web", env: "TOP=SECRET", githubToken: "t" }));
  else res.end(JSON.stringify(true));
});

const srv = spawn("node_modules/.bin/tsx", ["src/server.ts"], {
  env: { ...process.env, PORT: String(P.app), PUBLIC_URL: APP, DOKPLOY_URL: `http://localhost:${P.dk}`, DOKPLOY_API_KEY: "dk-key",
    GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret", GITHUB_AUTH_BASE: `http://localhost:${P.gh}`, GITHUB_API_BASE: `http://localhost:${P.gh}`,
    ALLOWED_GITHUB_ID: "777", AUTH_SECRET: randomBytes(32).toString("hex") }, stdio: ["ignore", "inherit", "inherit"],
});
const cleanup = () => { srv.kill(); gh.close(); dk.close(); };
process.on("exit", cleanup);
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${APP}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

const ok = (m: string) => console.log("✓", m);
const b64 = (b: Buffer) => b.toString("base64url");

// discovery
const prm: any = await (await fetch(`${APP}/.well-known/oauth-protected-resource/mcp`)).json();
assert.equal(prm.resource, `${APP}/mcp`); ok("protected-resource metadata");
const asm: any = await (await fetch(`${APP}/.well-known/oauth-authorization-server`)).json();
assert.ok(asm.registration_endpoint && asm.code_challenge_methods_supported.includes("S256")); ok("authorization-server metadata");
const un = await fetch(`${APP}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
assert.equal(un.status, 401); assert.match(un.headers.get("www-authenticate")!, /resource_metadata/); ok("/mcp without token → 401 + resource_metadata");

// DCR
const redirect = "https://claude.ai/api/mcp/auth_callback";
const reg: any = await (await fetch(asm.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json();
assert.ok(reg.client_id && !reg.client_secret); ok("dynamic client registration");

async function login(verifierOut: { v: string }, challengeOverride?: string) {
  const verifier = b64(randomBytes(32)); verifierOut.v = verifier;
  const challenge = challengeOverride ?? b64(createHash("sha256").update(verifier).digest());
  const a = new URL(asm.authorization_endpoint);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "dokploy", resource: `${APP}/mcp` }).forEach(([k, v]) => a.searchParams.set(k, v));
  const r1 = await fetch(a, { redirect: "manual" });
  assert.equal(r1.status, 302);
  const cookie = r1.headers.get("set-cookie")!.split(";")[0];
  const r2 = await fetch(r1.headers.get("location")!, { redirect: "manual" }); // mock github → callback url
  const r3 = await fetch(r2.headers.get("location")!, { headers: { cookie } });
  return { r3, cookie };
}
const token = (params: Record<string, string>) => fetch(asm.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: reg.client_id, ...params }) });

// happy path
const vo = { v: "" };
const { r3, cookie } = await login(vo);
const html = await r3.text();
assert.equal(r3.status, 200); assert.match(html, /Signed in as <b>mdnhs<\/b>/); assert.match(html, /claude\.ai/); ok("GitHub login + consent page");
const consent = /name=consent value="([^"]+)"/.exec(html)![1];
const noCookie = await fetch(`${APP}/consent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ consent, decision: "allow" }), redirect: "manual" });
assert.equal(noCookie.status, 400); ok("consent without session cookie rejected (CSRF)");
const c = await fetch(`${APP}/consent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams({ consent, decision: "allow" }), redirect: "manual" });
assert.equal(c.status, 302);
const back = new URL(c.headers.get("location")!);
assert.equal(back.origin + back.pathname, redirect); assert.equal(back.searchParams.get("state"), "xyz");
const code = back.searchParams.get("code")!;

const bad = await token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: "x".repeat(50) });
assert.equal(bad.status, 400); ok("wrong PKCE verifier rejected");
const tk: any = await (await token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: vo.v })).json();
assert.ok(tk.access_token && tk.refresh_token); ok("code → tokens");
const replay = await token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: vo.v });
assert.equal(replay.status, 400); ok("code replay rejected");

// MCP session
const mk = (t: string) => new Client({ name: "t", version: "1" }).connect(new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
const client: any = new Client({ name: "t", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tk.access_token}` } } }));
const tools = (await client.listTools()).tools.map((t: any) => t.name);
assert.deepEqual(tools.sort(), ["dokploy_call_api", "dokploy_deploy", "dokploy_get", "dokploy_overview", "dokploy_search_api"]); ok("tools/list: " + tools.join(", "));
const txt = (r: any) => r.content[0].text as string;
const ov = txt(await client.callTool({ name: "dokploy_overview", arguments: {} }));
assert.match(ov, /"plane"/); assert.match(ov, /"project": "Raynx"/); ok("overview");
const one = txt(await client.callTool({ name: "dokploy_get", arguments: { kind: "application", id: "a1" } }));
assert.ok(!one.includes("TOP=SECRET") && !one.includes('"t"') && one.includes("[redacted]")); ok("secrets redacted");
const s = txt(await client.callTool({ name: "dokploy_search_api", arguments: { query: "application delete" } }));
assert.match(s, /\/application\.delete/); assert.match(s, /"needsConfirm": true/); ok("search_api");
const r1 = await client.callTool({ name: "dokploy_call_api", arguments: { method: "POST", path: "/application.delete", params: { applicationId: "a1" } } });
assert.equal(r1.isError, true); assert.ok(!dkCalls.some((x) => x.includes("application.delete"))); ok("delete without confirm blocked");
const r2 = await client.callTool({ name: "dokploy_call_api", arguments: { method: "POST", path: "/application.delete", params: { applicationId: "a1" }, confirm: true } });
assert.ok(!r2.isError); assert.ok(dkCalls.includes("POST /api/application.delete")); ok("delete with confirm works");
const r3b = await client.callTool({ name: "dokploy_call_api", arguments: { method: "GET", path: "/nope.x" } });
assert.equal(r3b.isError, true); ok("unknown op rejected");
const dep = await client.callTool({ name: "dokploy_deploy", arguments: { kind: "compose", id: "c1" } });
assert.ok(!dep.isError && dkCalls.includes("POST /api/compose.deploy")); ok("deploy");

// refresh
const rt: any = await (await token({ grant_type: "refresh_token", refresh_token: tk.refresh_token })).json();
assert.ok(rt.access_token); ok("refresh token");
const asRefresh = await fetch(`${APP}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tk.refresh_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
assert.equal(asRefresh.status, 401); ok("refresh token not usable as access token");

// wrong github user
ghUser = { id: 999, login: "intruder" };
const w = await login({ v: "" });
assert.equal(w.r3.status, 403); ok("non-allowlisted GitHub user denied");

console.log("\nALL PASSED"); cleanup(); process.exit(0);
