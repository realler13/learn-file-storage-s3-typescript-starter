import { respondWithJSON } from "./json";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";

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
  const key = `${videoId}.mp4`;
  try {
    await Bun.write(tempPath, file);
    await cfg.s3Client.file(key).write(Bun.file(tempPath), {
      type: file.type,
    });

    video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
    updateVideo(cfg.db, video);

    return respondWithJSON(200, video);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
