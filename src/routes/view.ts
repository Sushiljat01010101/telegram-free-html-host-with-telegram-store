import { Router } from "express";
import { createClient } from "@supabase/supabase-js";

const router = Router();

const supabase = createClient(
  process.env["SUPABASE_URL"] ?? "",
  process.env["SUPABASE_SERVICE_KEY"] ?? ""
);

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";

router.get("/view/:userId/:fileName", async (req, res) => {
  const { userId, fileName } = req.params;
  const decodedName = decodeURIComponent(fileName);

  try {
    const { data, error } = await supabase
      .from("files")
      .select("telegram_file_id, content_type")
      .eq("user_id", userId)
      .eq("file_name", decodedName)
      .single();

    if (error || !data) {
      res.status(404).send("File not found.");
      return;
    }

    const getFileRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${data.telegram_file_id}`
    );
    const getFileJson = (await getFileRes.json()) as {
      ok: boolean;
      result?: { file_path: string };
    };

    if (!getFileJson.ok || !getFileJson.result?.file_path) {
      res.status(404).send("File not available from Telegram.");
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${getFileJson.result.file_path}`;
    const fileRes = await fetch(fileUrl);

    if (!fileRes.ok) {
      res.status(404).send("File not available.");
      return;
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());

    const ext = decodedName.split(".").pop()?.toLowerCase() ?? "";

    const contentTypeMap: Record<string, string> = {
      html: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "application/javascript; charset=utf-8",
      zip: "application/zip",
    };

    const contentType =
      contentTypeMap[ext] ??
      (data.content_type as string | null) ??
      "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  } catch (err) {
    res.status(500).send("Error serving file.");
  }
});

export default router;
