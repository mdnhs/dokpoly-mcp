// Usage: node scripts/build-catalog.mjs [openapi.json path]
import fs from "node:fs";
const src = process.argv[2] || "/tmp/openapi.json";
const o = JSON.parse(fs.readFileSync(src, "utf8"));
const out = [];
for (const [path, item] of Object.entries(o.paths)) {
  for (const method of ["get", "post"]) {
    const op = item[method];
    if (!op) continue;
    const params = [];
    for (const p of op.parameters || []) params.push({ n: p.name, r: !!p.required, t: p.schema?.type });
    const body = op.requestBody?.content?.["application/json"]?.schema;
    for (const [k, v] of Object.entries(body?.properties || {}))
      params.push({ n: k, r: (body.required || []).includes(k), t: v.type || (v.enum ? "enum" : undefined) });
    out.push({ m: method.toUpperCase(), p: path, tag: op.tags?.[0] || "", s: op.summary || op.description || "", params });
  }
}
fs.writeFileSync(new URL("../src/dokploy/catalog.json", import.meta.url), JSON.stringify(out));
console.log(out.length, "operations");
