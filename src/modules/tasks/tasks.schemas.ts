import { z } from "zod";
import { isoDate } from "../invoices/invoices.schemas.js";

export const taskPriorities = ["urgent", "important", "normal"] as const;
export const taskKinds = ["meeting", "quote", "collection", "visit", "deadline", "admin"] as const;

const taskFields = {
  title: z.string().trim().min(1).max(200),
  /** The day it is due, "yyyy-mm-dd". */
  due: isoDate,
  priority: z.enum(taskPriorities),
  kind: z.enum(taskKinds),
  /** A customer of the same company; null for none. */
  customerId: z.uuid().nullable(),
  /** A deal of the same company; null for none. Its customer fills in a missing customer. */
  dealId: z.uuid().nullable(),
};

export const createTaskSchema = z.object({
  title: taskFields.title,
  due: taskFields.due,
  priority: taskFields.priority.default("normal"),
  kind: taskFields.kind.default("admin"),
  customerId: taskFields.customerId.optional(),
  dealId: taskFields.dealId.optional(),
});

export const updateTaskSchema = z
  .object({
    ...taskFields,
    /** true marks it done (today), false reopens it. */
    done: z.boolean(),
    /**
     * With done: true, the day it was done instead of today (not after today): "undo"
     * after reopening a task puts back the day it was really done.
     */
    completedOn: isoDate,
  })
  .partial()
  .refine((v) => Object.values(v).some((value) => value !== undefined), "Send at least one field")
  .refine((v) => v.completedOn === undefined || v.done === true, {
    path: ["completedOn"],
    message: "completedOn goes with done: true",
  });

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
