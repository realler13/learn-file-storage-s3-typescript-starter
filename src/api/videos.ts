import { respondWithJSON } from "./json";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn([
    "ffprobe", "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", filePath,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    console.error("ffprobe failed:", stderr.trim());
    throw new BadRequestError("Could not read the uploaded video");
  }

  const stream = JSON.parse(stdout).streams?.[0];
  if (!(stream?.width > 0 && stream.height > 0)) {
    throw new BadRequestError("No video stream with valid dimensions");
  }
  const { width, height } = stream;
  if (Math.abs(height - width * 9 / 16) <= 1 && width > height) return "landscape";
  if (Math.abs(width - height * 9 / 16) <= 1 && height > width) return "portrait";
  return "other";
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = inputFilePath + ".processed";
  const proc = Bun.spawn([
    "ffmpeg", "-i", inputFilePath, "-movflags", "faststart",
    "-map_metadata", "0", "-codec", "copy", "-f", "mp4", outputFilePath,
  ], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    console.error("ffmpeg failed:", stderr.trim());
    throw new BadRequestError("Could not process the uploaded video");
  }
  return outputFilePath;
}

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to upload this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video must be a file");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video exceeds the maximum upload size");
  }
  if (file.type !== "video/mp4") {
    throw new BadRequestError("Video must be an MP4 file");
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "tubely-video-"));
  const tempPath = path.join(tempDir, "upload.mp4");
  try {
    await Bun.write(tempPath, file);
    const prefix = await getVideoAspectRatio(tempPath);
    const key = `${prefix}/${videoId}.mp4`;
    const processedPath = await processVideoForFastStart(tempPath);
    await cfg.s3Client.file(key).write(Bun.file(processedPath), {
      type: file.type,
    });

    video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
    updateVideo(cfg.db, video);

    return respondWithJSON(200, video);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
