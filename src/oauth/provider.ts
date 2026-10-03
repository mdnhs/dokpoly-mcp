import { randomUUID, randomBytes } from "node:crypto";
import type { Response } from "express";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Config } from "../config.js";

const ISS = "dokploy-mcp";
export const ACCESS_TTL = 3600; // 1h
export const REFRESH_TTL = 30 * 86400; // 30d
export const SCOPE = "dokploy";

/** All state lives in signed JWTs (HS256) so the server needs no database. */
export class StatelessProvider implements OAuthServerProvider {
  private usedCodes = new Map<string, number>(); // single-use enforcement (per instance)
  constructor(private cfg: Config) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.usedCodes) if (v < now) this.usedCodes.delete(k);
    }, 60_000).unref();
  }

  sign(typ: string, claims: JWTPayload, ttlSec: number) {
    return new SignJWT({ ...claims, typ })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISS)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${ttlSec}s`)
      .sign(this.cfg.authSecret);
  }
  async verify(typ: string, token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.cfg.authSecret, { issuer: ISS, algorithms: ["HS256"] });
    if (payload.typ !== typ) throw new Error("wrong token type");
    return payload;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => {
        try {
          const p = await this.verify("client", clientId);
          return { ...(p.meta as object), client_id: clientId } as OAuthClientInformationFull;
        } catch { return undefined; }
      },
      registerClient: async (client) => {
        const meta = {
          redirect_uris: client.redirect_uris,
          client_name: client.client_name,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: SCOPE,
        };
        const client_id = await this.sign("client", { meta }, 365 * 86400);
        return { ...meta, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
      },
    };
  }

  /** Step 1: send the user to GitHub. A signed "txn" carries the original request. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const nonce = randomBytes(16).toString("hex");
    const txn = await this.sign("txn", {
      cid: client.client_id, ru: params.redirectUri, cc: params.codeChallenge,
      st: params.state, sc: params.scopes, res: params.resource?.href, n: nonce,
    }, 600);
    res.cookie("mcp_n", nonce, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600_000, path: "/" });
    const u = new URL("/login/oauth/authorize", this.cfg.githubAuthBase);
    u.searchParams.set("client_id", this.cfg.githubClientId);
    u.searchParams.set("redirect_uri", `${this.cfg.publicUrl}/github/callback`);
    u.searchParams.set("scope", "read:user");
    u.searchParams.set("state", txn);
    res.redirect(u.href);
  }

  async challengeForAuthorizationCode(_c: OAuthClientInformationFull, code: string) {
    try { return (await this.verify("code", code)).cc as string; }
    catch { throw new InvalidGrantError("invalid or expired authorization code"); }
  }

  private async issue(sub: string, cid: string, scope: string[], resource?: string): Promise<OAuthTokens> {
    const base = { sub, cid, sc: scope, res: resource };
    return {
      access_token: await this.sign("access", base, ACCESS_TTL),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      scope: scope.join(" "),
      refresh_token: await this.sign("refresh", base, REFRESH_TTL),
    };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _v?: string, redirectUri?: string) {
    let p: JWTPayload;
    try { p = await this.verify("code", code); } catch { throw new InvalidGrantError("invalid or expired authorization code"); }
    if (p.cid !== client.client_id) throw new InvalidGrantError("code was issued to another client");
    if (redirectUri && p.ru !== redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    if (this.usedCodes.has(p.jti!)) throw new InvalidGrantError("authorization code already used");
    this.usedCodes.set(p.jti!, Date.now() + 600_000);
    return this.issue(String(p.sub), client.client_id, (p.sc as string[]) ?? [SCOPE], p.res as string | undefined);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string) {
    let p: JWTPayload;
    try { p = await this.verify("refresh", refreshToken); } catch { throw new InvalidGrantError("invalid refresh token"); }
    if (p.cid !== client.client_id) throw new InvalidGrantError("refresh token was issued to another client");
    return this.issue(String(p.sub), client.client_id, (p.sc as string[]) ?? [SCOPE], p.res as string | undefined);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const p = await this.verify("access", token);
      return {
        token, clientId: String(p.cid), scopes: (p.sc as string[]) ?? [SCOPE], expiresAt: p.exp,
        resource: p.res ? new URL(p.res as string) : undefined, extra: { sub: p.sub },
      };
    } catch { throw new InvalidTokenError("invalid or expired access token"); }
  }

  /** Code minted after GitHub login + explicit consent. */
  async mintCode(txn: JWTPayload, sub: string) {
    return this.sign("code", { cid: txn.cid, ru: txn.ru, cc: txn.cc, sc: (txn.sc as string[] | undefined)?.length ? txn.sc : [SCOPE], res: txn.res, sub }, 300);
  }
}
