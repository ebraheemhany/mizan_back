import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import type { AuthRateLimiters } from "../../middleware/rate-limit.js";
import { validateBody } from "../../middleware/validate.js";
import { changePasswordSchema, loginSchema, refreshTokenSchema, registerSchema } from "./auth.schemas.js";
import * as authService from "./auth.service.js";
import { revokeSession, rotateRefreshToken } from "./tokens.js";

export function createAuthRouter(limit: AuthRateLimiters) {
  const router = Router();

  router.post("/register", limit.register, validateBody(registerSchema), async (req, res) => {
    res.status(201).json(await authService.register(req.body));
  });

  router.post(
    "/login",
    validateBody(loginSchema),
    limit.loginPerIp,
    limit.loginPerAccount,
    async (req, res) => {
      res.json(await authService.login(req.body));
    },
  );

  // No access token needed: this is what the frontend calls when the access token has expired.
  router.post("/refresh", validateBody(refreshTokenSchema), async (req, res) => {
    res.json(await rotateRefreshToken(req.body.refreshToken));
  });

  router.post("/logout", validateBody(refreshTokenSchema), async (req, res) => {
    await revokeSession(req.body.refreshToken);
    res.status(204).end();
  });

  router.get("/me", authenticate, async (req, res) => {
    res.json({ user: await authService.getCurrentUser(req.user!.id) });
  });

  router.post(
    "/change-password",
    authenticate,
    limit.changePassword,
    validateBody(changePasswordSchema),
    async (req, res) => {
      res.json(await authService.changePassword(req.user!.id, req.body));
    },
  );

  return router;
}
