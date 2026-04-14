#!/usr/bin/env node
/**
 * Synology Photos AI Tagger
 *
 * For JPEG files, this variant embeds XMP/IPTC metadata into the image file
 * itself so Synology Photos can index the tags. Non-JPEG formats still use
 * sidecar XMP files.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const CONFIG = {
  apiKey: process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_API_KEY || process.env.AI_API_KEY || "",
  apiEndpoint:
    process.env.DASHSCOPE_API_ENDPOINT ||
    process.env.ALIYUN_API_ENDPOINT ||
    process.env.AI_ENDPOINT ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  photoDir: process.env.PHOTO_DIR || "/volume1/homes/YOUR_USER/Photos",
  progressFile: process.env.PROGRESS_FILE || "./progress.json",
  logFile: process.env.LOG_FILE || "./tagger.log",
  requestsPerMinute: 30,
  primaryModel:
    process.env.DASHSCOPE_MODEL ||
    process.env.ALIYUN_MODEL ||
    process.env.AI_MODEL ||
    "qwen-vl-plus",
  secondaryModel:
    process.env.DASHSCOPE_SECONDARY_MODEL ||
    process.env.ALIYUN_SECONDARY_MODEL ||
    process.env.SECONDARY_AI_MODEL ||
    "qwen-vl-max",
  enableSecondaryPass: parseBoolean(process.env.ENABLE_SECONDARY_MODEL, true),
  visionMaxEdge: parsePositiveInt(process.env.VISION_MAX_EDGE, 1600),
  visionMaxBytes: parsePositiveInt(process.env.VISION_MAX_BYTES, 900000),
  embedJpegMetadata: parseBoolean(process.env.EMBED_JPEG_METADATA, true),
  keepJpegSidecar: parseBoolean(process.env.KEEP_JPEG_SIDECAR, false),
  exiv2Bin: process.env.EXIV2_BIN || "exiv2",
};

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".heic", ".webp"]);
const RAW_EXTS = new Set([".rw2", ".nef", ".arw", ".cr2", ".cr3", ".orf", ".dng"]);
const EMBED_EXTS = new Set([".jpg", ".jpeg"]);
const TEXT_LIKE_TAGS = new Set([
  "信息",
  "文字",
  "文字信息",
  "聊天",
  "聊天信息",
  "群聊",
  "微信",
  "文档",
  "文件",
  "通知",
  "海报",
  "幻灯片",
  "投影",
  "表格",
  "图表",
  "报表",
  "菜单",
  "价格表",
  "屏幕",
  "界面",
  "截图",
  "显示器",
  "电脑",
  "手机",
  "白板",
  "课件",
  "演示",
  "演讲",
  "讲解",
  "教学",
  "知识分享",
  "思维模型",
  "防疫",
  "消毒",
]);

const isDryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.indexOf("--limit");
const maxPhotos = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isQuotaExceededError(error) {
  const message = String(error?.message || error);
  return (
    message.includes("429") &&
    (message.includes("Too Many Requests") ||
      message.includes("quota") ||
      message.includes("rate-limit"))
  );
}

function ensureConfig() {
  if (!CONFIG.apiKey) {
    throw new Error("Missing API key. Set DASHSCOPE_API_KEY, ALIYUN_API_KEY, or AI_API_KEY.");
  }
  if (!fs.existsSync(CONFIG.photoDir)) {
    throw new Error(`PHOTO_DIR does not exist: ${CONFIG.photoDir}`);
  }
  if (limitArg !== -1 && (!Number.isFinite(maxPhotos) || maxPhotos <= 0)) {
    throw new Error("Invalid --limit value.");
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
  fs.appendFileSync(CONFIG.logFile, `${line}\n`);
}

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.progressFile, "utf8"));
  } catch {
    return { processed: {}, stats: { success: 0, failed: 0, skipped: 0 } };
  }
}

function saveProgress(progress) {
  fs.mkdirSync(path.dirname(CONFIG.progressFile), { recursive: true });
  fs.writeFileSync(CONFIG.progressFile, JSON.stringify(progress, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findThumbnail(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  for (const name of ["SYNOPHOTO_THUMB_XL.jpg", "SYNOPHOTO_THUMB_L.jpg"]) {
    const candidate = path.join(dir, "@eaDir", base, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function collectPhotos(dir) {
  const files = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith("@")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTS.has(ext) || RAW_EXTS.has(ext)) files.push(fullPath);
      }
    }
  }
  walk(dir);
  return files;
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;",
  })[char]);
}

function buildXmp(tags) {
  const items = tags
    .map((tag) => `          <rdf:li>${escapeXml(tag)}</rdf:li>`)
    .join("\n");
  return `<?xpacket begin='﻿' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
  <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
    <rdf:Description rdf:about=''
        xmlns:dc='http://purl.org/dc/elements/1.1/'
        xmlns:lr='http://ns.adobe.com/lightroom/1.0/'>
      <dc:subject>
        <rdf:Bag>
${items}
        </rdf:Bag>
      </dc:subject>
      <lr:hierarchicalSubject>
        <rdf:Bag>
${items}
        </rdf:Bag>
      </lr:hierarchicalSubject>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>`;
}

function sidecarPathFor(filePath) {
  return filePath.replace(/\.[^.]+$/, ".xmp");
}

function writeSidecar(filePath, tags) {
  const xmpPath = sidecarPathFor(filePath);
  fs.writeFileSync(xmpPath, buildXmp(tags), "utf8");
  return xmpPath;
}

function embedIntoJpeg(filePath, tags) {
  const xmpPath = writeSidecar(filePath, tags);
  try {
    execFileSync(CONFIG.exiv2Bin, ["-iX", "in", filePath], {
      stdio: "pipe",
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    throw new Error(`exiv2 embed failed: ${stderr || error.message}`);
  }

  if (!CONFIG.keepJpegSidecar) {
    fs.rmSync(xmpPath, { force: true });
  }
}

function persistTags(filePath, tags) {
  const ext = path.extname(filePath).toLowerCase();
  if (CONFIG.embedJpegMetadata && EMBED_EXTS.has(ext)) {
    embedIntoJpeg(filePath, tags);
    return "embedded";
  }
  writeSidecar(filePath, tags);
  return "sidecar";
}

const PROMPT = `分析这张照片，用简短的中文关键词描述其内容。
返回一个 JSON 数组，包含 5-10 个关键词。
关键词类别包括但不限于：
- 场景：室内、室外、城市、自然、海边、山景、街道
- 主体：人物、动物、食物、建筑、风景、植物、车辆
- 活动：旅行、聚会、运动、日常、工作
- 风格：夜景、日出、特写、人像
- 信息：文字、文档、屏幕、界面、通知、表格、海报
- 如果画面是截图、聊天界面、社交应用或软件界面，优先描述截图本身，例如：截图、聊天、群聊、微信、界面、屏幕、二维码、公告、通知、联系人。
- 忽略头像、小缩略图、聊天气泡中的配图或列表封面里的次要照片内容，除非它们占据画面主体。
只返回 JSON 数组，例如：["旅行", "海边", "风景", "自然", "户外"]`;

const TEXT_FOCUSED_PROMPT = `${PROMPT}
如果画面包含明显的文字、文档、通知、表格、屏幕、投影、白板、聊天记录、社交界面或演示内容，优先输出这些信息相关关键词。`;

function parseTags(text) {
  const cleaned = String(text || "").trim();
  const match = cleaned.match(/\[[\s\S]*?\]/);
  if (!match) throw new Error(`无法解析: ${cleaned}`);

  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) {
    throw new Error(`模型未返回数组: ${cleaned}`);
  }

  const normalized = [...new Set(
    parsed
      .map((item) => String(item).trim())
      .filter(Boolean),
  )];

  if (normalized.length === 0) {
    throw new Error("模型未返回有效标签。");
  }

  return normalized.slice(0, 10);
}

function preprocessImageForVisionModel(imagePath) {
  const inputBuffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const sourceMimeType = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".heic": "image/heic",
    ".webp": "image/webp",
  }[ext] || "image/jpeg";

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-img-"));
  const outputPath = path.join(tempDir, `${path.basename(imagePath, ext)}.jpg`);
  const attempts = [
    { edge: CONFIG.visionMaxEdge, quality: 88 },
    { edge: Math.min(CONFIG.visionMaxEdge, 1440), quality: 84 },
    { edge: Math.min(CONFIG.visionMaxEdge, 1280), quality: 80 },
    { edge: Math.min(CONFIG.visionMaxEdge, 1024), quality: 76 },
  ];

  try {
    for (const attempt of attempts) {
      try {
        execFileSync("convert", [
          imagePath,
          "-auto-orient",
          "-resize", `${attempt.edge}x${attempt.edge}>`,
          "-quality", String(attempt.quality),
          outputPath,
        ], { stdio: "ignore" });
      } catch {
        execFileSync("ffmpeg", [
          "-y",
          "-i", imagePath,
          "-vf", `scale='min(${attempt.edge},iw)':'min(${attempt.edge},ih)':force_original_aspect_ratio=decrease`,
          "-q:v", "4",
          outputPath,
        ], { stdio: "ignore" });
      }

      const outputBuffer = fs.readFileSync(outputPath);
      if (outputBuffer.length <= CONFIG.visionMaxBytes) {
        return { buffer: outputBuffer, mimeType: "image/jpeg" };
      }
    }

    return { buffer: fs.readFileSync(outputPath), mimeType: "image/jpeg" };
  } catch {
    return { buffer: inputBuffer, mimeType: sourceMimeType };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildPayload(model, mimeType, base64, prompt) {
  return {
    model,
    messages: [
      {
        role: "system",
        content: "你是 Synology Photos 的照片标签助手。只返回一个 JSON 数组，包含 5 到 10 个简短中文关键词，不要输出解释、Markdown 或多余文本。",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
            },
          },
        ],
      },
    ],
    temperature: 0.2,
    stream: false,
  };
}

function isTextLikeTagSet(tags) {
  return tags.some((tag) => TEXT_LIKE_TAGS.has(tag));
}

async function requestTags(model, prepared, prompt) {
  const mimeType = prepared.mimeType || "image/jpeg";
  const base64 = prepared.buffer.toString("base64");
  const payload = buildPayload(model, mimeType, base64, prompt);

  const response = await fetch(CONFIG.apiEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    throw new Error(`Non-JSON response (${response.status}): ${responseText.slice(0, 400)}`);
  }

  if (!response.ok) {
    const message =
      responseJson?.error?.message ||
      responseJson?.base_resp?.status_msg ||
      responseJson?.message ||
      responseText;
    throw new Error(`API ${response.status}: ${message}`);
  }

  const content = responseJson?.choices?.[0]?.message?.content;
  const contentText =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("\n")
        : "";

  if (!contentText) {
    throw new Error(`Unexpected response format: ${responseText.slice(0, 400)}`);
  }

  return parseTags(contentText);
}

async function analyzePhoto(imagePath) {
  const prepared = preprocessImageForVisionModel(imagePath);
  const primaryTags = await requestTags(CONFIG.primaryModel, prepared, PROMPT);

  if (
    !CONFIG.enableSecondaryPass ||
    !CONFIG.secondaryModel ||
    CONFIG.secondaryModel === CONFIG.primaryModel ||
    !isTextLikeTagSet(primaryTags)
  ) {
    return { tags: primaryTags, modelUsed: CONFIG.primaryModel };
  }

  const secondaryTags = await requestTags(CONFIG.secondaryModel, prepared, TEXT_FOCUSED_PROMPT);
  return {
    tags: secondaryTags,
    modelUsed: `${CONFIG.primaryModel}->${CONFIG.secondaryModel}`,
    primaryTags,
  };
}

async function main() {
  ensureConfig();
  log(`=== 开始运行 ${isDryRun ? "[DRY RUN]" : ""} ===`);

  const progress = loadProgress();
  const allPhotos = collectPhotos(CONFIG.photoDir);
  const pending = allPhotos.filter((filePath) => !progress.processed[filePath]);

  log(`总照片数: ${allPhotos.length}，已处理: ${Object.keys(progress.processed).length}，待处理: ${pending.length}`);

  const toProcess = pending.slice(0, maxPhotos === Infinity ? pending.length : maxPhotos);
  log(`本次处理: ${toProcess.length} 张`);

  const interval = (60 / CONFIG.requestsPerMinute) * 1000;
  let lastRequestTime = 0;

  for (let index = 0; index < toProcess.length; index += 1) {
    const filePath = toProcess[index];
    const ext = path.extname(filePath).toLowerCase();
    const isRaw = RAW_EXTS.has(ext);

    let analyzeTarget = filePath;
    if (isRaw) {
      const thumb = findThumbnail(filePath);
      if (!thumb) {
        log(`[跳过] 无缩略图: ${filePath}`);
        progress.processed[filePath] = { status: "skipped", reason: "no_thumbnail" };
        progress.stats.skipped += 1;
        saveProgress(progress);
        continue;
      }
      analyzeTarget = thumb;
    }

    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < interval) await sleep(interval - elapsed);

    const shortPath = filePath.replace(CONFIG.photoDir, "");
    process.stdout.write(`[${index + 1}/${toProcess.length}] ${shortPath} ... `);

    try {
      lastRequestTime = Date.now();
      const { tags, modelUsed, primaryTags } = await analyzePhoto(analyzeTarget);

      let writeMode = "dry-run";
      if (!isDryRun) {
        writeMode = persistTags(filePath, tags);
      }

      const modelNote = primaryTags ? ` [${modelUsed}]` : ` [${modelUsed}]`;
      console.log(`✓${modelNote} ${tags.join(", ")}`);
      progress.processed[filePath] = {
        status: "success",
        tags,
        primaryTags,
        modelUsed,
        writeMode,
        time: new Date().toISOString(),
      };
      progress.stats.success += 1;
    } catch (error) {
      const message = String(error.message || error);
      console.log(`✗ ${message.split("\n")[0]}`);
      log(`[错误] ${filePath}: ${message}`);

      if (isQuotaExceededError(error)) {
        log("[停止] API 配额已耗尽，本轮停止，未处理文件保持待处理状态。");
        saveProgress(progress);
        break;
      }

      progress.processed[filePath] = {
        status: "failed",
        error: message,
      };
      progress.stats.failed += 1;
    }

    if ((index + 1) % 100 === 0) {
      saveProgress(progress);
      log(`进度: ${index + 1}/${toProcess.length} | 成功:${progress.stats.success} 失败:${progress.stats.failed} 跳过:${progress.stats.skipped}`);
    }
  }

  saveProgress(progress);
  log(`=== 完成 === 成功:${progress.stats.success} 失败:${progress.stats.failed} 跳过:${progress.stats.skipped}`);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
