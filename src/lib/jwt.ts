import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";
import type { Role } from "../generated/prisma/client.js";

const secret = new TextEncoder().encode(config.JWT_SECRET);
const ALGORITHM = "HS256";

export type TokenClaims = {
  sub: string;
  companyId: string;
  role: Role;
};

export function signAccessToken(claims: TokenClaims) {
  return new SignJWT({ companyId: claims.companyId, role: claims.role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(config.JWT_ACCESS_EXPIRES_IN)
    .sign(secret);
}

export async function verifyAccessToken(token: string) {
  const { payload } = await jwtVerify(token, secret, { algorithms: [ALGORITHM] });
  if (!payload.sub || payload.iat === undefined) {
    throw new Error("Token is missing required claims");
  }
  return { sub: payload.sub, iat: payload.iat };
}
