# Synology Photo Tagger

Automatically tag photos on Synology NAS using Qwen vision models, with optional Gemini support when explicitly enabled. JPEG files are written with embedded XMP/IPTC metadata so Synology Photos can index the tags directly. RAW files and non-JPEG images can still fall back to sidecar XMP.

## What Changed

- Default provider is `qwen`
- Default model is `qwen3-vl-flash`
- The script tracks API requests by day and can stop automatically at a daily cap
- Gemini support is optional and can be re-enabled with `PRIMARY_PROVIDER=gemini`
- The script can honor `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`, so only this process needs to go through your OpenWrt proxy
- When the daily cap is reached, the script can wait until the next day and continue from `progress.json`
- The script can send a daily-limit email through SMTP and optionally fall back to DSM notifications
- JPEG files are embedded in-place by default instead of relying only on sidecar files

## How It Works

1. Recursively scans the target photo directory
2. Sends each image to Qwen for Chinese keyword tagging
3. If you explicitly choose `PRIMARY_PROVIDER=gemini`, the script can use Gemini instead
4. Writes the final tags into JPEG metadata with `exiv2`
5. Saves progress continuously so reruns and next-day resumes continue where the previous run stopped
6. When the daily request cap is reached, pauses and resumes the next day

RAW files (`.rw2`, `.nef`, `.arw`, `.cr2`, `.cr3`, `.orf`, `.dng`) are supported. The script analyzes Synology-generated thumbnails in `@eaDir`.

## Requirements

- Node.js 18+
- `exiv2` installed on the NAS
- Qwen API key
- If you want email notifications, set SMTP environment variables or provide a DSM notification title key

## Setup

```bash
npm install
npm run check
```

## Usage

```bash
# Normal run
QWEN_API_KEY="<your_qwen_key>" PHOTO_DIR=/volume1/photo node tagger.js

# Dry run
QWEN_API_KEY="<your_qwen_key>" PHOTO_DIR=/volume1/photo node tagger.js --dry-run

# Test with a small batch first
QWEN_API_KEY="<your_qwen_key>" PHOTO_DIR=/volume1/photo node tagger.js --limit 10
```

### Run Only This Process Through OpenWrt

If you later switch back to Gemini and want Synology DDNS and external access to keep working, restore the NAS default gateway and DNS to your main router, then launch only `photo tagger` with proxy environment variables:

```bash
HTTPS_PROXY="http://192.168.1.200:7890" \
HTTP_PROXY="http://192.168.1.200:7890" \
NO_PROXY="127.0.0.1,localhost,192.168.1.108,192.168.1.109,192.168.1.200,dashscope.aliyuncs.com" \
PRIMARY_PROVIDER="gemini" \
GEMINI_API_KEYS="<your_keys>" \
QWEN_API_KEY="<your_qwen_key>" \
PHOTO_DIR=/volume1/photo \
node tagger.js
```

If your OpenWrt only exposes SOCKS5, use a matching `ALL_PROXY` value instead.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PRIMARY_PROVIDER` | `qwen` | Primary provider: `qwen` or `gemini` |
| `QWEN_API_KEY` | required by default | Qwen API key |
| `QWEN_API_ENDPOINT` | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | Qwen API endpoint |
| `QWEN_MODEL` | `qwen3-vl-flash` | Qwen model |
| `GEMINI_API_KEYS` | optional | One or more Gemini API keys, separated by commas, spaces, or newlines |
| `GEMINI_API_KEY` | fallback | Single Gemini API key when `GEMINI_API_KEYS` is not set |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Gemini model to use |
| `HTTP_PROXY` | empty | Optional per-process HTTP proxy |
| `HTTPS_PROXY` | empty | Optional per-process HTTPS proxy |
| `ALL_PROXY` | empty | Optional fallback proxy when `HTTP_PROXY` / `HTTPS_PROXY` are not set |
| `NO_PROXY` | empty | Comma-separated hosts that should bypass the proxy |
| `REQUESTS_PER_MINUTE` | `15` | Local pacing limit between requests |
| `DAILY_REQUEST_CAP` | `1500` | Script-level daily request cap |
| `DAILY_REQUEST_CAP_PER_KEY` | `0` | Optional per-key daily cap, mainly useful for testing key rotation |
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
[1/848] /IMG_6015.jpg ... ✓ [qwen:qwen3-vl-flash dashscope] 聊天, 群聊, 微信, 截图, 界面, 屏幕, 文字
[2/848] /IMG_6405.JPG ... ✓ [qwen:qwen3-vl-flash dashscope] 名片, 文字, 信息, 联系人, 邮箱, 电话
[3/848] /IMG_5794.JPG ... ✓ [qwen:qwen3-vl-flash dashscope] 户外, 建筑, 运动, 攀岩, 自然, 山景
```

## Notes

- Qwen is now the default path. If you want Gemini again, set `PRIMARY_PROVIDER=gemini`.
- When Gemini is enabled, the script can rotate across multiple Gemini keys in order.
- When Gemini is enabled and Qwen credentials are also configured, the script can still fall back to Qwen.
- Proxy settings apply only to this `node tagger.js` process and its outbound API requests; they do not change the NAS system gateway.
- SMTP is the reliable path for custom daily-progress emails. DSM 7 custom notifications need a valid notification title key and are treated as an optional fallback.
- `qwen3-vl-flash` is the configured default here because your current Gemini path on the NAS depends on proxy authentication and is no longer the primary route.
- Synology Photos indexing can lag slightly behind metadata writes; `synoindex -a <file>` can help force pickup during verification.
