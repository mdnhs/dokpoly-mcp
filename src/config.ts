const env = (k: string, d?: string) => process.env[k] ?? d;
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var: ${k}`);
  return v;
};
const bool = (k: string) => /^(1|true|yes)$/i.test(process.env[k] ?? "");

export function loadConfig() {
  const publicUrl = need("PUBLIC_URL").replace(/\/+$/, "");
  const allowedId = env("ALLOWED_GITHUB_ID");
  const allowedLogin = env("ALLOWED_GITHUB_LOGIN");
  if (!allowedId && !allowedLogin) throw new Error("Set ALLOWED_GITHUB_ID (recommended) or ALLOWED_GITHUB_LOGIN");
  const secret = need("AUTH_SECRET");
  if (secret.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters");
  return {
    port: Number(env("PORT", "3000")),
    publicUrl,
    dokployUrl: need("DOKPLOY_URL").replace(/\/+$/, ""),
    dokployApiKey: need("DOKPLOY_API_KEY"),
    githubClientId: need("GITHUB_CLIENT_ID"),
    githubClientSecret: need("GITHUB_CLIENT_SECRET"),
    githubAuthBase: env("GITHUB_AUTH_BASE", "https://github.com"),
    githubApiBase: env("GITHUB_API_BASE", "https://api.github.com"),
    allowedId,
    allowedLogin: allowedLogin?.toLowerCase(),
    authSecret: new TextEncoder().encode(secret),
    readOnly: bool("READ_ONLY"),
    revealSecrets: bool("REVEAL_SECRETS"),
  };
}
export type Config = ReturnType<typeof loadConfig>;
