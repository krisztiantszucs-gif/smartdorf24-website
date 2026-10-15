import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Still image -> 10s H.264 yuv420p MP4 at source resolution (even dims).
export function imageToStillMp4(imgBuf, seconds = 10) {
  const dir = mkdtempSync(join(tmpdir(), "sd24v-"));
  const inp = join(dir, "in.img"), out = join(dir, "out.mp4");
  writeFileSync(inp, imgBuf);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-i", inp, "-t", String(seconds),
    "-r", "25", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-tune", "stillimage", "-crf", "23",
    "-movflags", "+faststart", "-an", out]);
  return readFileSync(out);
}
