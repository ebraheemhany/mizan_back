import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { createTaskSchema, updateTaskSchema } from "./tasks.schemas.js";
import * as tasks from "./tasks.service.js";

export function createTasksRouter() {
  const router = Router();
  router.use(authenticate);

  // Every role can read the tasks; changing them needs the "tasks" permission.
  const edit = requirePermission("tasks");

  router.get("/", async (req, res) => {
    res.json(await tasks.listTasks(req.user!.companyId));
  });

  router.post("/", edit, validateBody(createTaskSchema), async (req, res) => {
    res.status(201).json({ task: await tasks.createTask(req.user!, req.body) });
  });

  router.patch("/:id", edit, validateBody(updateTaskSchema), async (req, res) => {
    const id = parseId(req.params.id, "Task");
    res.json({ task: await tasks.updateTask(req.user!, id, req.body) });
  });

  // Also limited to the owner or the task's creator (checked in the service).
  router.delete("/:id", edit, async (req, res) => {
    await tasks.deleteTask(req.user!, parseId(req.params.id, "Task"));
    res.status(204).end();
  });

  return router;
}
