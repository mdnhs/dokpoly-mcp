import catalog from "./catalog.json" with { type: "json" };
import type { Config } from "../config.js";

export type Op = { m: string; p: string; tag: string; s: string; params: { n: string; r: boolean; t?: string }[] };
export const ops = catalog as Op[];
export const findOp = (method: string, path: string) =>
  ops.find((o) => o.m === method.toUpperCase() && o.p === path);

// Operations that remove/overwrite/stop things need an explicit confirm:true.
const DESTRUCTIVE = /(delete|remove|prune|clean|kill|reset|destroy|stop|cancel|truncate|revoke|drop|restore|rollback|disable|shutdown|update|rebuild|move|transfer|unlink|disconnect)/i;
export const isDestructive = (o: Op) => o.m !== "GET" && DESTRUCTIVE.test(o.p);

const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|private[-_]?key|^env$|build(args|secrets)|credential|^key$|authorization)/i;
export function redact(v: unknown, reveal: boolean): unknown {
  if (reveal) return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, reveal));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [
        k,
        SECRET_KEY.test(k) && val != null && val !== "" ? "[redacted]" : redact(val, reveal),
      ]),
    );
  }
  return v;
}

export class Dokploy {
  constructor(private cfg: Config) {}
  async call(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}) {
    const url = new URL(`${this.cfg.dokployUrl}/api${path}`);
    const init: RequestInit = {
      method,
      headers: { "x-api-key": this.cfg.dokployApiKey, accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    };
    if (method === "GET") {
      for (const [k, v] of Object.entries(params))
        if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    } else {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(params);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) {
      const msg = typeof data === "object" && data ? ((data as any).message ?? JSON.stringify(data)) : String(data);
      throw new Error(`Dokploy ${res.status} on ${method} ${path}: ${String(msg).slice(0, 500)}`);
    }
    return data;
  }
}
