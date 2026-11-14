import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { changeRoleSchema } from "./users.schemas.js";
import * as users from "./users.service.js";

export function createUsersRouter() {
  const router = Router();

  // Team management is for the owner only.
  router.use(authenticate, requireRole("owner"));

  router.get("/", async (req, res) => {
    res.json({ users: await users.listTeam(req.user!.companyId) });
  });

  router.patch("/:id", validateBody(changeRoleSchema), async (req, res) => {
    const user = await users.changeRole(req.user!.companyId, parseId(req.params.id, "User"), req.body.role);
    res.json({ user });
  });

  router.delete("/:id", async (req, res) => {
    await users.removeUser(req.user!.companyId, parseId(req.params.id, "User"));
    res.status(204).end();
  });

  return router;
}
