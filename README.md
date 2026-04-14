# Synology Photo Tagger

Automatically tag photos on Synology NAS using Qwen vision models. JPEG files are written with embedded XMP/IPTC metadata so Synology Photos can index the tags directly. RAW files and non-JPEG images can still fall back to sidecar XMP.

## What Changed

- Default model is `qwen-vl-plus`
- Screenshot, document, screen, and UI-like images can automatically trigger a second pass with `qwen-vl-max`
- JPEG files are embedded in-place by default instead of relying only on sidecar files
- Progress, chosen model, and fallback behavior are saved in `progress.json`

## How It Works

1. Recursively scans the target photo directory
2. Uses `qwen-vl-plus` for the first pass
3. If the first-pass tags suggest text, documents, screenshots, chat UI, or screens, runs a second pass with `qwen-vl-max`
4. Writes the final Chinese keyword tags into JPEG metadata with `exiv2`
5. Synology Photos can index the embedded tags for search

RAW files (`.rw2`, `.nef`, `.arw`, `.cr2`, `.cr3`, `.orf`, `.dng`) are supported. The script analyzes Synology-generated thumbnails in `@eaDir`.

## Requirements

- Node.js 18+
- `exiv2` installed on the NAS
- Alibaba Cloud DashScope / Bailian API key

## Setup

```bash
npm install
npm run check
```

## Usage

```bash
# Normal run
DASHSCOPE_API_KEY=your_key PHOTO_DIR=/volume1/photo node tagger.js

# Dry run
DASHSCOPE_API_KEY=your_key PHOTO_DIR=/volume1/photo node tagger.js --dry-run

# Test with a small batch first
DASHSCOPE_API_KEY=your_key PHOTO_DIR=/volume1/photo node tagger.js --limit 10
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DASHSCOPE_API_KEY` | required | DashScope / Bailian API key |
| `AI_MODEL` | `qwen-vl-plus` | First-pass model |
| `SECONDARY_AI_MODEL` | `qwen-vl-max` | Second-pass model for text / UI-like images |
| `ENABLE_SECONDARY_MODEL` | `true` | Enable the second-pass heuristic |
| `PHOTO_DIR` | `/volume1/homes/YOUR_USER/Photos` | Directory to scan |
| `PROGRESS_FILE` | `./progress.json` | Where to save progress |
| `LOG_FILE` | `./tagger.log` | Log file path |
| `EMBED_JPEG_METADATA` | `true` | Embed tags into JPEG files |
| `KEEP_JPEG_SIDECAR` | `false` | Keep `.xmp` sidecar after embedding |
| `VISION_MAX_EDGE` | `1600` | Resize ceiling before upload |
| `VISION_MAX_BYTES` | `900000` | Size ceiling before upload |
| `EXIV2_BIN` | `exiv2` | Path to `exiv2` |

## Output Example

```text
[1/848] /IMG_6015.jpg ... ✓ [qwen-vl-plus->qwen-vl-max] 聊天, 群聊, 微信, 截图, 界面, 屏幕, 文字
[2/848] /IMG_6405.JPG ... ✓ [qwen-vl-plus->qwen-vl-max] 名片, 文字, 信息, 联系人, 邮箱, 电话
[3/848] /IMG_5794.JPG ... ✓ [qwen-vl-plus] 户外, 建筑, 运动, 攀岩, 自然, 山景
```

## Notes

- If the provider returns content-policy errors for specific images, those files are recorded as failed and the rest of the run continues.
- Synology Photos indexing can lag slightly behind metadata writes; `synoindex -a <file>` can help force pickup during verification.
