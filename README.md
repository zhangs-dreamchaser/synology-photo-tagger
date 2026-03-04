# Synology Photo Tagger

Automatically tag photos on Synology NAS using Google Gemini AI. Generates Chinese keyword tags and writes them as XMP sidecar files, which Synology Photos indexes for search.

## How it works

1. Scans your photo directory recursively
2. Sends each photo to Gemini 2.5 Flash for analysis
3. Gets back 5–10 Chinese keywords (scene, subject, activity, style)
4. Writes a `.xmp` sidecar file next to the photo
5. Synology Photos picks up the tags automatically — search by "海边", "人物", "旅行", etc.

RAW files (`.rw2`, `.nef`, `.arw`, etc.) are supported — the script uses Synology's pre-generated thumbnails in `@eaDir` for analysis.

Progress is saved to `progress.json` so the script can resume if interrupted.

## Requirements

- Node.js 18+
- Google Gemini API key (free tier: 30 requests/min) — get one at [aistudio.google.com](https://aistudio.google.com)

## Setup

```bash
npm install
```

## Usage

```bash
# Run normally
GEMINI_API_KEY=your_key PHOTO_DIR=/volume1/photos node tagger.js

# Dry run — analyze but don't write files
GEMINI_API_KEY=your_key PHOTO_DIR=/volume1/photos node tagger.js --dry-run

# Test with 10 photos first
GEMINI_API_KEY=your_key PHOTO_DIR=/volume1/photos node tagger.js --limit 10
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | required | Your Gemini API key |
| `PHOTO_DIR` | `/volume1/homes/YOUR_USER/Photos` | Directory to scan |
| `PROGRESS_FILE` | `./progress.json` | Where to save progress |
| `LOG_FILE` | `./tagger.log` | Log file path |

## Auto-run on new uploads (cron)

Add to `/etc/crontab` on your Synology:

```
0  3  *  *  *  root  GEMINI_API_KEY=your_key PHOTO_DIR=/volume1/photos node /path/to/tagger.js >> /path/to/output.log 2>&1
```

Runs every night at 3 AM, skips already-processed photos.

## Output example

```
[1/13040] /photos/trip/IMG_001.JPG ... ✓ 海边, 礁石, 海浪, 自然, 户外, 风景
[2/13040] /photos/trip/IMG_002.JPG ... ✓ 人物, 海边, 旅行, 自然, 阴天
[3/13040] /photos/RAW/P1033707.RW2 ... ✓ 人物, 摄影师, 户外, 自然
```
