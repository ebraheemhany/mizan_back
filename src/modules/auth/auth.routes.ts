import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import type { AuthRateLimiters } from "../../middleware/rate-limit.js";
import { validateBody } from "../../middleware/validate.js";
import {
  accountTokenSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  googleSignInSchema,
  localeSchema,
  loginSchema,
  refreshTokenSchema,
  registerSchema,
  resetPasswordSchema,
} from "./auth.schemas.js";
import * as authService from "./auth.service.js";
import * as links from "./account-links.service.js";
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

  // Signs in, links, joins an invitation or creates a company, with a Google ID token.
  router.post("/google", validateBody(googleSignInSchema), limit.loginPerIp, async (req, res) => {
    const { created, ...session } = await authService.continueWithGoogle(req.body);
    res.status(created ? 201 : 200).json(session);
  });

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

  // Always the same answer, whether or not the address has an account.
  router.post(
    "/forgot-password",
    validateBody(forgotPasswordSchema),
    limit.forgotPasswordPerIp,
    limit.forgotPasswordPerEmail,
    (req, res) => {
      links.requestPasswordReset(req.body.email, req.body.locale);
      res.status(204).end();
    },
  );

  router.get("/reset-password/:token", limit.accountToken, async (req, res) => {
    res.json(await links.previewPasswordReset(String(req.params.token).slice(0, 200)));
  });

  router.post("/reset-password", limit.accountToken, validateBody(resetPasswordSchema), async (req, res) => {
    await links.resetPassword(req.body.token, req.body.password);
    res.status(204).end();
  });

  // No login needed: the link may be opened on another device.
  router.post("/verify-email", limit.accountToken, validateBody(accountTokenSchema), async (req, res) => {
    res.json(await links.verifyEmail(req.body.token));
  });

  router.post(
    "/verify-email/resend",
    authenticate,
    limit.resendVerification,
    validateBody(localeSchema),
    async (req, res) => {
      await links.resendVerification(req.user!.id, req.body.locale);
      res.status(204).end();
    },
  );

  return router;
}
