import type { RequestHandler } from "express";
import { unauthorized, forbidden } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { can, type Permission } from "../lib/permissions.js";
import { prisma } from "../lib/prisma.js";
import type { Role } from "../generated/prisma/client.js";

export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw unauthorized();
  }

  let claims: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    claims = await verifyAccessToken(header.slice("Bearer ".length).trim());
  } catch {
    throw unauthorized("Invalid or expired token");
  }

  // Read the user from the database so a deleted user or a changed role
  // takes effect immediately instead of when the token expires.
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, companyId: true, role: true, passwordChangedAt: true },
  });
  if (!user) {
    throw unauthorized("Invalid or expired token");
  }
  if (user.passwordChangedAt && claims.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
    throw unauthorized("Password was changed, please log in again");
  }

  req.user = { id: user.id, companyId: user.companyId, role: user.role };
  next();
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };

/** Allows the request only if the user's role has this permission (see lib/permissions). */
export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (!can(req.user.role, permission)) throw forbidden();
    next();
  };
