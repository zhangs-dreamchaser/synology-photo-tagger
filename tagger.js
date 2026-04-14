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
import nodemailer from "nodemailer";
import os from "os";
import path from "path";

const DEFAULT_PROGRESS_FILE = process.env.PROGRESS_FILE || "./progress.json";
const DEFAULT_DAILY_STATE_FILE = defaultDailyStateFile(DEFAULT_PROGRESS_FILE);

const CONFIG = {
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.AI_API_KEY || "",
  apiEndpoint: stripTrailingSlash(
    process.env.GEMINI_API_ENDPOINT ||
      process.env.GOOGLE_API_ENDPOINT ||
      process.env.AI_ENDPOINT ||
      "https://generativelanguage.googleapis.com/v1beta",
  ),
  photoDir: process.env.PHOTO_DIR || "/volume1/homes/YOUR_USER/Photos",
  progressFile: DEFAULT_PROGRESS_FILE,
  dailyStateFile: process.env.DAILY_STATE_FILE || DEFAULT_DAILY_STATE_FILE,
  logFile: process.env.LOG_FILE || "./tagger.log",
  requestsPerMinute: parsePositiveInt(process.env.REQUESTS_PER_MINUTE, 15),
  model: process.env.GEMINI_MODEL || process.env.AI_MODEL || "gemini-2.0-flash",
  dailyRequestCap: parseNonNegativeInt(process.env.DAILY_REQUEST_CAP, 1500),
  waitForNextDay: parseBoolean(process.env.WAIT_FOR_NEXT_DAY, true),
  notifyOnDailyLimit: parseBoolean(process.env.NOTIFY_ON_DAILY_LIMIT, true),
  notifyTarget: process.env.NOTIFY_TARGET || "",
  notifyBin: process.env.NOTIFY_BIN || "/usr/syno/bin/synodsmnotify",
  notifyTitleKey: process.env.DSM_NOTIFY_TITLE_KEY || "",
  alertEmailTo: process.env.ALERT_EMAIL_TO || process.env.NOTIFY_EMAIL_TO || "",
  alertEmailFrom: process.env.ALERT_EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || "",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: parsePositiveInt(process.env.SMTP_PORT, 465),
  smtpSecure: parseBoolean(process.env.SMTP_SECURE, true),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  timeZone: process.env.TIME_ZONE || process.env.TZ || "Asia/Shanghai",
  visionMaxEdge: parsePositiveInt(process.env.VISION_MAX_EDGE, 1600),
  visionMaxBytes: parsePositiveInt(process.env.VISION_MAX_BYTES, 900000),
  embedJpegMetadata: parseBoolean(process.env.EMBED_JPEG_METADATA, true),
  keepJpegSidecar: parseBoolean(process.env.KEEP_JPEG_SIDECAR, false),
  exiv2Bin: process.env.EXIV2_BIN || "exiv2",
};

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".heic", ".webp"]);
const RAW_EXTS = new Set([".rw2", ".nef", ".arw", ".cr2", ".cr3", ".orf", ".dng"]);
const EMBED_EXTS = new Set([".jpg", ".jpeg"]);

const SYSTEM_INSTRUCTION =
  "你是 Synology Photos 的照片标签助手。只返回一个 JSON 数组，包含 5 到 10 个简短中文关键词，不要输出解释、Markdown 或多余文本。";

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

class DailyRequestLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "DailyRequestLimitError";
  }
}

const isDryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.indexOf("--limit");
const maxPhotos = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

let dailyState = null;

function defaultDailyStateFile(progressFile) {
  const parsed = path.parse(progressFile);
  return path.join(parsed.dir, `${parsed.name}.daily-state.json`);
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getDatePartsInTimeZone(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CONFIG.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  return {
    year: Number.parseInt(parts.find((part) => part.type === "year")?.value || "1970", 10),
    month: Number.parseInt(parts.find((part) => part.type === "month")?.value || "01", 10),
    day: Number.parseInt(parts.find((part) => part.type === "day")?.value || "01", 10),
  };
}

function getDateKey(date = new Date()) {
  const parts = getDatePartsInTimeZone(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function createEmptyDailyState(dateKey = getDateKey()) {
  return {
    date: dateKey,
    requestCount: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    lastRequestAt: null,
    lastStopAt: null,
    lastStopReason: null,
    lastNotificationDate: null,
    lastNotificationReason: null,
    lastNotificationAt: null,
  };
}

function ensureDailyStateShape(rawState) {
  const state = rawState && typeof rawState === "object" ? rawState : {};
  const currentDate = getDateKey();

  if (state.date !== currentDate) {
    return createEmptyDailyState(currentDate);
  }

  return {
    date: currentDate,
    requestCount: parseNonNegativeInt(state.requestCount, 0),
    successCount: parseNonNegativeInt(state.successCount, 0),
    failedCount: parseNonNegativeInt(state.failedCount, 0),
    skippedCount: parseNonNegativeInt(state.skippedCount, 0),
    lastRequestAt: state.lastRequestAt || null,
    lastStopAt: state.lastStopAt || null,
    lastStopReason: state.lastStopReason || null,
    lastNotificationDate: state.lastNotificationDate || null,
    lastNotificationReason: state.lastNotificationReason || null,
    lastNotificationAt: state.lastNotificationAt || null,
  };
}

function loadDailyState() {
  try {
    const rawState = JSON.parse(fs.readFileSync(CONFIG.dailyStateFile, "utf8"));
    dailyState = ensureDailyStateShape(rawState);
  } catch {
    dailyState = createEmptyDailyState();
  }
  saveDailyState();
  return dailyState;
}

function saveDailyState() {
  if (!dailyState) return;
  fs.mkdirSync(path.dirname(CONFIG.dailyStateFile), { recursive: true });
  fs.writeFileSync(CONFIG.dailyStateFile, JSON.stringify(dailyState, null, 2));
}

function refreshDailyState() {
  const normalized = ensureDailyStateShape(dailyState);
  const rolledOver = !dailyState || dailyState.date !== normalized.date;
  dailyState = normalized;
  if (rolledOver) {
    saveDailyState();
  }
  return dailyState;
}

function isQuotaExceededError(error) {
  const message = String(error?.message || error);
  return (
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("Too Many Requests")
  );
}

function ensureConfig() {
  if (!CONFIG.apiKey) {
    throw new Error("Missing API key. Set GEMINI_API_KEY, GOOGLE_API_KEY, or AI_API_KEY.");
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

function millisecondsUntilNextDay() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 5, 0);
  return Math.max(next.getTime() - now.getTime(), 60_000);
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

function parseTags(text) {
  const cleaned = String(text || "").trim();
  const match = cleaned.match(/\[[\s\S]*?\]/);
  if (!match) throw new Error(`无法解析: ${cleaned}`);

  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) {
    throw new Error(`模型未返回数组: ${cleaned}`);
  }

  const normalized = [
    ...new Set(
      parsed
        .map((item) => String(item).trim())
        .filter(Boolean),
    ),
  ];

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
        execFileSync(
          "convert",
          [
            imagePath,
            "-auto-orient",
            "-resize",
            `${attempt.edge}x${attempt.edge}>`,
            "-quality",
            String(attempt.quality),
            outputPath,
          ],
          { stdio: "ignore" },
        );
      } catch {
        execFileSync(
          "ffmpeg",
          [
            "-y",
            "-i",
            imagePath,
            "-vf",
            `scale='min(${attempt.edge},iw)':'min(${attempt.edge},ih)':force_original_aspect_ratio=decrease`,
            "-q:v",
            "4",
            outputPath,
          ],
          { stdio: "ignore" },
        );
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

function buildPayload(mimeType, base64, prompt) {
  return {
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: base64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  };
}

function buildGeminiUrl(model) {
  return `${CONFIG.apiEndpoint}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(CONFIG.apiKey)}`;
}

function countApiRequest() {
  const state = refreshDailyState();
  if (CONFIG.dailyRequestCap > 0 && state.requestCount >= CONFIG.dailyRequestCap) {
    throw new DailyRequestLimitError(
      `Daily request cap reached: ${state.requestCount}/${CONFIG.dailyRequestCap} (${state.date})`,
    );
  }

  state.requestCount += 1;
  state.lastRequestAt = new Date().toISOString();
  saveDailyState();
}

function updateDailyPhotoStat(status) {
  const state = refreshDailyState();
  if (status === "success") state.successCount += 1;
  if (status === "failed") state.failedCount += 1;
  if (status === "skipped") state.skippedCount += 1;
  saveDailyState();
}

function buildNotificationBody(progress, pendingCount, reason, currentFile) {
  const state = refreshDailyState();
  const lines = [
    `日期: ${state.date}`,
    `目录: ${CONFIG.photoDir}`,
    `模型: ${CONFIG.model}`,
    `原因: ${reason}`,
    `今日请求数: ${state.requestCount}${CONFIG.dailyRequestCap > 0 ? ` / ${CONFIG.dailyRequestCap}` : ""}`,
    `今日新增成功: ${state.successCount}`,
    `今日新增失败: ${state.failedCount}`,
    `今日新增跳过: ${state.skippedCount}`,
    `累计成功: ${progress.stats.success}`,
    `累计失败: ${progress.stats.failed}`,
    `累计跳过: ${progress.stats.skipped}`,
    `累计已处理: ${Object.keys(progress.processed).length}`,
    `当前待处理: ${pendingCount}`,
  ];

  if (currentFile) {
    lines.push(`当前文件: ${currentFile}`);
  }

  if (CONFIG.waitForNextDay) {
    lines.push("状态: 已暂停，等待下一天自动继续");
  } else {
    lines.push("状态: 已停止，需要手动再次启动");
  }

  return lines.join("\n");
}

function hasSmtpNotificationConfig() {
  return Boolean(CONFIG.alertEmailTo && CONFIG.alertEmailFrom && CONFIG.smtpHost);
}

async function sendSmtpNotification(subject, body) {
  const transport = nodemailer.createTransport({
    host: CONFIG.smtpHost,
    port: CONFIG.smtpPort,
    secure: CONFIG.smtpSecure,
    auth:
      CONFIG.smtpUser || CONFIG.smtpPass
        ? {
            user: CONFIG.smtpUser,
            pass: CONFIG.smtpPass,
          }
        : undefined,
  });

  await transport.sendMail({
    from: CONFIG.alertEmailFrom,
    to: CONFIG.alertEmailTo,
    subject,
    text: body,
  });
}

function sendDsmNotification(subject, body) {
  if (!CONFIG.notifyTarget || !CONFIG.notifyTitleKey) return false;
  if (!fs.existsSync(CONFIG.notifyBin)) {
    log(`[通知] 未找到 DSM 通知命令: ${CONFIG.notifyBin}`);
    return false;
  }

  try {
    execFileSync(CONFIG.notifyBin, [CONFIG.notifyTarget, CONFIG.notifyTitleKey, body], {
      stdio: "pipe",
    });
    log(`[通知] 已通过 DSM 发送到 ${CONFIG.notifyTarget}，标题键 ${CONFIG.notifyTitleKey}`);
    return true;
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    log(`[DSM 通知失败] ${stderr || error.message}`);
    return false;
  }
}

async function sendDailyLimitNotification(progress, pendingCount, reason, currentFile) {
  if (!CONFIG.notifyOnDailyLimit) return;
  const state = refreshDailyState();
  if (state.lastNotificationDate === state.date && state.lastNotificationReason === reason) {
    return;
  }

  const subject = `Photo Tagger 今日限额停止 (${state.date})`;
  const body = buildNotificationBody(progress, pendingCount, reason, currentFile);
  let sent = false;

  try {
    if (hasSmtpNotificationConfig()) {
      await sendSmtpNotification(subject, body);
      log(`[通知] 已发送邮件到 ${CONFIG.alertEmailTo}`);
      sent = true;
    } else if (CONFIG.notifyTarget && CONFIG.notifyTitleKey) {
      sent = sendDsmNotification(subject, body);
    } else {
      log("[通知] 未配置 SMTP 或 DSM 自定义通知键，跳过邮件通知。");
    }
  } catch (error) {
    log(`[邮件通知失败] ${error.message}`);
  }

  if (sent) {
    state.lastNotificationDate = state.date;
    state.lastNotificationReason = reason;
    state.lastNotificationAt = new Date().toISOString();
    saveDailyState();
  }
}

async function pauseUntilNextDay(progress, pendingCount, reason, currentFile) {
  const state = refreshDailyState();
  state.lastStopAt = new Date().toISOString();
  state.lastStopReason = reason;
  saveDailyState();

  await sendDailyLimitNotification(progress, pendingCount, reason, currentFile);

  if (!CONFIG.waitForNextDay) {
    return false;
  }

  const waitMs = millisecondsUntilNextDay();
  log(`[暂停] ${reason}；将在下一天自动继续，预计等待 ${Math.ceil(waitMs / 60000)} 分钟。`);
  await sleep(waitMs);

  dailyState = createEmptyDailyState();
  saveDailyState();
  log(`[恢复] 已进入 ${dailyState.date}，继续处理剩余照片。`);
  return true;
}

async function requestTags(prepared, prompt) {
  countApiRequest();

  const mimeType = prepared.mimeType || "image/jpeg";
  const base64 = prepared.buffer.toString("base64");
  const payload = buildPayload(mimeType, base64, prompt);

  const response = await fetch(buildGeminiUrl(CONFIG.model), {
    method: "POST",
    headers: {
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
    const message = responseJson?.error?.message || responseText;
    throw new Error(`API ${response.status}: ${message}`);
  }

  const promptBlockReason = responseJson?.promptFeedback?.blockReason;
  if (promptBlockReason) {
    throw new Error(`Prompt blocked: ${promptBlockReason}`);
  }

  const candidate = responseJson?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const contentText = parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();

  if (!contentText) {
    const finishReason = candidate?.finishReason || "UNKNOWN";
    throw new Error(`Unexpected response format: finishReason=${finishReason}`);
  }

  return {
    tags: parseTags(contentText),
    usage: responseJson?.usageMetadata || null,
  };
}

async function analyzePhoto(imagePath) {
  const prepared = preprocessImageForVisionModel(imagePath);
  const { tags, usage } = await requestTags(prepared, PROMPT);
  return { tags, modelUsed: CONFIG.model, usage };
}

async function main() {
  ensureConfig();
  loadDailyState();
  log(`=== 开始运行 ${isDryRun ? "[DRY RUN]" : ""} ===`);
  log(`模型: ${CONFIG.model} | 每分钟限制: ${CONFIG.requestsPerMinute} | 每日请求上限: ${CONFIG.dailyRequestCap || "unlimited"}`);
  log(`今日日期(${CONFIG.timeZone}): ${dailyState.date} | 今日已用请求: ${dailyState.requestCount}`);

  const progress = loadProgress();
  const allPhotos = collectPhotos(CONFIG.photoDir);
  log(`总照片数: ${allPhotos.length}，已处理: ${Object.keys(progress.processed).length}，待处理: ${allPhotos.length - Object.keys(progress.processed).length}`);

  const toProcess = allPhotos
    .filter((filePath) => !progress.processed[filePath])
    .slice(0, maxPhotos === Infinity ? undefined : maxPhotos);
  log(`本次处理: ${toProcess.length} 张`);

  const interval = (60 / CONFIG.requestsPerMinute) * 1000;
  let lastRequestTime = 0;
  let index = 0;

  while (index < toProcess.length) {
    refreshDailyState();
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
        updateDailyPhotoStat("skipped");
        saveProgress(progress);
        index += 1;
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
      const { tags, modelUsed, usage } = await analyzePhoto(analyzeTarget);

      let writeMode = "dry-run";
      if (!isDryRun) {
        writeMode = persistTags(filePath, tags);
      }

      console.log(`✓ [${modelUsed}] ${tags.join(", ")}`);
      progress.processed[filePath] = {
        status: "success",
        tags,
        modelUsed,
        usage,
        writeMode,
        time: new Date().toISOString(),
      };
      progress.stats.success += 1;
      updateDailyPhotoStat("success");
      index += 1;
    } catch (error) {
      const message = String(error.message || error);

      if (error instanceof DailyRequestLimitError || isQuotaExceededError(error)) {
        console.log(`… ${message.split("\n")[0]}`);
        saveProgress(progress);
        const shouldContinue = await pauseUntilNextDay(
          progress,
          toProcess.length - index,
          error instanceof DailyRequestLimitError ? "达到脚本每日请求上限" : "Gemini API 当日配额已耗尽",
          filePath,
        );
        if (!shouldContinue) break;
        continue;
      }

      console.log(`✗ ${message.split("\n")[0]}`);
      log(`[错误] ${filePath}: ${message}`);
      progress.processed[filePath] = {
        status: "failed",
        error: message,
      };
      progress.stats.failed += 1;
      updateDailyPhotoStat("failed");
      index += 1;
    }

    if (index % 100 === 0) {
      saveProgress(progress);
      log(`进度: ${index}/${toProcess.length} | 成功:${progress.stats.success} 失败:${progress.stats.failed} 跳过:${progress.stats.skipped}`);
    }
  }

  saveProgress(progress);
  saveDailyState();
  log(`=== 完成 === 成功:${progress.stats.success} 失败:${progress.stats.failed} 跳过:${progress.stats.skipped}`);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
