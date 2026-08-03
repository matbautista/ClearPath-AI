import { Router } from "express";
import { db } from "../db.js";

export const categoriesRouter = Router();

// GET /api/categories — spending categories (2.4), for populating dropdowns.
// Rename/merge/delete (4.6) aren't implemented yet; this is read-only for now.
categoriesRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT id, name, is_system FROM spending_categories ORDER BY name").all();
  res.json((rows as any[]).map((r) => ({ id: r.id, name: r.name, isSystem: !!r.is_system })));
});
