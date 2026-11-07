import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { changePasswordSchema, loginSchema, refreshTokenSchema, registerSchema } from "./auth.schemas.js";
import * as authService from "./auth.service.js";
import { revokeSession, rotateRefreshToken } from "./tokens.js";

export const authRouter = Router();

authRouter.post("/register", validateBody(registerSchema), async (req, res) => {
  res.status(201).json(await authService.register(req.body));
});

authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
  res.json(await authService.login(req.body));
});

// No access token needed: this is what the frontend calls when the access token has expired.
authRouter.post("/refresh", validateBody(refreshTokenSchema), async (req, res) => {
  res.json(await rotateRefreshToken(req.body.refreshToken));
});

authRouter.post("/logout", validateBody(refreshTokenSchema), async (req, res) => {
  await revokeSession(req.body.refreshToken);
  res.status(204).end();
});

authRouter.get("/me", authenticate, async (req, res) => {
  res.json({ user: await authService.getCurrentUser(req.user!.id) });
});

authRouter.post("/change-password", authenticate, validateBody(changePasswordSchema), async (req, res) => {
  res.json(await authService.changePassword(req.user!.id, req.body));
});
