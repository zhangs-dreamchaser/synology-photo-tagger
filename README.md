# Synology Photo Tagger

Automatically tag photos on Synology NAS using Gemini vision models. JPEG files are written with embedded XMP/IPTC metadata so Synology Photos can index the tags directly. RAW files and non-JPEG images can still fall back to sidecar XMP.

## What Changed

- Default model is `gemini-2.0-flash`
- The script tracks API requests by day and can stop automatically at a daily cap
- When the daily cap or Gemini quota is reached, the script can wait until the next day and continue from `progress.json`
- The script can send a daily-limit email through SMTP and optionally fall back to DSM notifications
- JPEG files are embedded in-place by default instead of relying only on sidecar files

## How It Works

1. Recursively scans the target photo directory
2. Sends each image to Gemini for Chinese keyword tagging
3. Writes the final tags into JPEG metadata with `exiv2`
4. Saves progress continuously so reruns and next-day resumes continue where the previous run stopped
5. When the daily request cap is reached, pauses and resumes the next day

RAW files (`.rw2`, `.nef`, `.arw`, `.cr2`, `.cr3`, `.orf`, `.dng`) are supported. The script analyzes Synology-generated thumbnails in `@eaDir`.

## Requirements

- Node.js 18+
- `exiv2` installed on the NAS
- Gemini API key
- If you want email notifications, set SMTP environment variables or provide a DSM notification title key

## Setup

```bash
npm install
npm run check
```

## Usage

```bash
# Normal run
GEMINI_API_KEY=your_key PHOTO_DIR=/volume1/photo node tagger.js

# Dry run
GEMINI_API_KEY=your_key PHOTO_DIR=/volume1/photo node tagger.js --dry-run

# Test with a small batch first
GEMINI_API_KEY=your_key PHOTO_DIR=/volume1/photo node tagger.js --limit 10
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | required | Gemini API key |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini model to use |
| `REQUESTS_PER_MINUTE` | `15` | Local pacing limit between requests |
| `DAILY_REQUEST_CAP` | `1500` | Script-level daily request cap |
| `WAIT_FOR_NEXT_DAY` | `true` | Sleep until the next day and continue automatically |
| `NOTIFY_ON_DAILY_LIMIT` | `true` | Send an email or DSM notification when the daily cap or provider quota is reached |
| `ALERT_EMAIL_TO` | empty | Email recipient for daily-limit notifications |
| `ALERT_EMAIL_FROM` | `SMTP_USER` | Sender address |
| `SMTP_HOST` | empty | SMTP host |
| `SMTP_PORT` | `465` | SMTP port |
| `SMTP_SECURE` | `true` | Use TLS SMTP |
| `SMTP_USER` | empty | SMTP username |
| `SMTP_PASS` | empty | SMTP password or app password |
| `NOTIFY_TARGET` | empty | Optional DSM username or group, such as `admin` or `@administrators` |
| `NOTIFY_BIN` | `/usr/syno/bin/synodsmnotify` | DSM notification command |
| `DSM_NOTIFY_TITLE_KEY` | empty | Required when using DSM notifications instead of SMTP |
| `TIME_ZONE` | `Asia/Shanghai` | Time zone for daily counters and notification labels |
| `PHOTO_DIR` | `/volume1/homes/YOUR_USER/Photos` | Directory to scan |
| `PROGRESS_FILE` | `./progress.json` | Where to save progress |
| `DAILY_STATE_FILE` | derived from `PROGRESS_FILE` | Daily request counter state file |
| `LOG_FILE` | `./tagger.log` | Log file path |
| `EMBED_JPEG_METADATA` | `true` | Embed tags into JPEG files |
| `KEEP_JPEG_SIDECAR` | `false` | Keep `.xmp` sidecar after embedding |
| `VISION_MAX_EDGE` | `1600` | Resize ceiling before upload |
| `VISION_MAX_BYTES` | `900000` | Size ceiling before upload |
| `EXIV2_BIN` | `exiv2` | Path to `exiv2` |

## Output Example

```text
[1/848] /IMG_6015.jpg ... ✓ [gemini-2.0-flash] 聊天, 群聊, 微信, 截图, 界面, 屏幕, 文字
[2/848] /IMG_6405.JPG ... ✓ [gemini-2.0-flash] 名片, 文字, 信息, 联系人, 邮箱, 电话
[3/848] /IMG_5794.JPG ... ✓ [gemini-2.0-flash] 户外, 建筑, 运动, 攀岩, 自然, 山景
```

## Notes

- If Gemini returns quota exhaustion before the script-level cap is reached, the script also pauses and waits for the next day.
- SMTP is the reliable path for custom daily-progress emails. DSM 7 custom notifications need a valid notification title key and are treated as an optional fallback.
- `gemini-2.0-flash` is the configured default here because you explicitly requested it. Check current Google AI Studio limits for your project before relying on the `1500` cap.
- Synology Photos indexing can lag slightly behind metadata writes; `synoindex -a <file>` can help force pickup during verification.
