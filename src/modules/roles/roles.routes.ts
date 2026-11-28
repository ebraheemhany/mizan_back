import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { roleSchema, updateRoleSchema } from "./roles.schemas.js";
import * as roles from "./roles.service.js";

export function createRolesRouter() {
  const router = Router();

  // Like the rest of team management: the owner only.
  router.use(authenticate, requireRole("owner"));

  router.get("/", async (req, res) => {
    res.json({ roles: await roles.listRoles(req.user!.companyId) });
  });

  router.post("/", validateBody(roleSchema), async (req, res) => {
    res.status(201).json({ role: await roles.createRole(req.user!.companyId, req.body) });
  });

  router.patch("/:id", validateBody(updateRoleSchema), async (req, res) => {
    res.json({ role: await roles.updateRole(req.user!.companyId, parseId(req.params.id, "Role"), req.body) });
  });

  router.delete("/:id", async (req, res) => {
    await roles.deleteRole(req.user!.companyId, parseId(req.params.id, "Role"));
    res.status(204).end();
  });

  return router;
}
