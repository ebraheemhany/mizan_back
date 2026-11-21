import express, { Router, type Response } from "express";
import { parseId } from "../../lib/params.js";
import { getLogo } from "./files.service.js";

/** The raw body of an upload (the file itself), a little over the biggest kind's limit. */
export const rawUpload = express.raw({ type: () => true, limit: "6mb" });

/** Sends a stored file: its own type, never sniffed by the browser, never cached by shared caches. */
export function sendFile(
  res: Response,
  file: { contentType: string; data: Uint8Array; name?: string | null },
  opts: { publicCache?: boolean } = {},
) {
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Shown inline (an image or a PDF), with its name for "save as".
  const name = file.name ? `; filename*=UTF-8''${encodeURIComponent(file.name)}` : "";
  res.setHeader("Content-Disposition", `inline${name}`);
  // Nothing in a stored file may run: no scripts, even inside a PDF viewer's page.
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  if (opts.publicCache) {
    // A logo's id changes whenever it is replaced, so it can be cached for good;
    // other sites (the frontend's origin) may show it.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  } else {
    res.setHeader("Cache-Control", "private, no-store");
  }
  res.send(Buffer.from(file.data));
}

/** /api/public/logos/:id — company logos for invoices and quotes, no login. */
export function createPublicLogosRouter() {
  const router = Router();
  router.get("/:id", async (req, res) => {
    sendFile(res, await getLogo(parseId(req.params["id"], "Logo")), { publicCache: true });
  });
  return router;
}
