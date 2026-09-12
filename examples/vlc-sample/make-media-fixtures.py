#!/usr/bin/env python3
"""Generate owned deterministic media for real VLC playback and seek verification."""
import hashlib
import json
import subprocess
import wave
from pathlib import Path

import imageio_ffmpeg

sample = Path(__file__).resolve().parent
out = sample / "build/media"
out.mkdir()
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
font = Path("/System/Library/Fonts/Menlo.ttc")
if not font.is_file():
    raise SystemExit("The frozen fixture font is unavailable: " + str(font))
video = out / "Bridge Video Fixture.mp4"
audio = out / "Bridge Audio Fixture.wav"


def encode(args):
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", *args], check=True, timeout=180)


encode(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=12:duration=180", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=180",
        "-vf", f"drawtext=fontfile={font}:text='BRIDGE VIDEO %{{pts\\:hms}}':x=18:y=18:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.85",
        "-af", "volume=0.015", "-c:v", "libx264", "-threads", "1", "-preset", "fast", "-crf", "24", "-g", "12", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k", "-fflags", "+bitexact", "-metadata", "title=Bridge Video Fixture", "-metadata", "artist=AI App Bridge synthetic fixture",
        "-metadata", "creation_time=1970-01-01T00:00:00Z", "-movflags", "+faststart", str(video)])
encode(["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=16000:duration=90", "-af", "volume=0.015", "-c:a", "pcm_s16le", "-ac", "1",
        "-fflags", "+bitexact", "-metadata", "title=Bridge Audio Fixture", str(audio)])
frames, seconds = imageio_ffmpeg.count_frames_and_secs(str(video))
assert frames == 2160 and abs(seconds - 180) < 0.01, (frames, seconds)
with wave.open(str(audio)) as f:
    assert f.getnframes() == 1440000 and f.getframerate() == 16000 and f.getnchannels() == 1
manifest = {
    "schemaVersion": "vlc-media-fixture/v1", "content": "Synthetic test pattern, visible media clock and quiet sine tones; no third-party media",
    "ffmpegVersion": imageio_ffmpeg.get_ffmpeg_version(), "ffmpegSha256": hashlib.sha256(Path(ffmpeg).read_bytes()).hexdigest(),
    "generatorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "fontSha256": hashlib.sha256(font.read_bytes()).hexdigest(),
    "files": [{"name": f.name, "bytes": f.stat().st_size, "sha256": hashlib.sha256(f.read_bytes()).hexdigest(), "durationMs": duration}
              for f, duration in [(video, 180000), (audio, 90000)]],
    "phoneDirectory": "/sdcard/Movies/BridgeVLCFixture", "emptyDirectory": "/sdcard/Movies/BridgeVLCEmpty",
}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest, indent=2))
