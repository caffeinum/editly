# Editly gl.readPixels Buffer Issue on Node 24 + ffmpeg 8

## Environment

- Node.js: v24.5.0 (LTS Krypton)
- ffmpeg: 8.0.1
- macOS: Darwin 25.3.0 (arm64)
- gl: 9.0.0-rc.9

## Problem

Editly produces corrupt/truncated video output due to a rawvideo buffer size mismatch between what gl.readPixels returns and what ffmpeg expects.

## Error

```
[rawvideo @ 0x...] Invalid buffer size, packet size 2440800 < expected frame_size 3686400
[vist#0:0/rawvideo @ 0x...] [dec:rawvideo @ 0x...] Error submitting packet to decoder: Invalid argument
```

## Reproduction

```bash
# Using globally installed editly from this fork
/Users/aleks/.npm-global/bin/editly "title:Hello World" --out output/test.mp4 --width 1280 --height 720 --clip-duration 3
```

## Result

Output video is truncated:

- Expected duration: 3 seconds
- Actual duration: 0.12 seconds
- Video appears as corrupted blue/gray screen

## Test videos

```
/Users/aleks/Github/varghq/sdk/output/editly-global-test.mp4
/Users/aleks/Github/varghq/sdk/output/editly-global-test2.mp4
/Users/aleks/Github/varghq/sdk/output/sora-landscape.mp4  (working input video)
/Users/aleks/Github/varghq/sdk/output/sora-vertical.mp4   (working input video)
```

## Analysis

The issue is in the gl canvas → rawvideo → ffmpeg pipeline:

1. Editly creates a gl canvas at 1280x720
2. gl.readPixels should return 1280 × 720 × 4 = 3,686,400 bytes (RGBA)
3. But only 2,440,800 bytes are returned (66% of expected)
4. ffmpeg receives incomplete frames and errors out

The buffer size math:

- Expected: 1280 × 720 × 4 = 3,686,400 bytes
- Actual: 2,440,800 bytes
- 2,440,800 / 4 / 1280 = 476.7 rows (not a whole number)

This suggests gl.readPixels is reading incomplete frame data.

## ffmpeg works fine directly

```bash
# This works perfectly:
ffmpeg -y -i output/sora-landscape.mp4 -i output/sora-vertical.mp4 \
  -filter_complex "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v0];[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v1];[v0][v1]concat=n=2:v=1:a=0[out]" \
  -map "[out]" -c:v libx264 -preset fast output/ffmpeg-direct-test.mp4

# Result: 8 seconds, 1280x720 - perfect output
```

So the issue is specifically with editly's gl → rawvideo pipeline, not ffmpeg 8 itself.

## Root Cause Hypothesis

The gl 9.0.0-rc.9 package may have a bug in readPixels on Node 24 / macOS arm64 that returns incomplete frame data.

## Workarounds Needed

1. Fix gl 9.0.0-rc.9 readPixels issue, OR
2. Find alternative to gl for headless canvas rendering, OR
3. Wait for gl package to release stable version with fix
