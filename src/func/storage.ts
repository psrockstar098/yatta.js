import { createStorage } from "../types/storage";

declare module "../types/storage" {
  interface StorageRegister {
    disks: "local" | "s3";
  }
}

export const storage = createStorage({
  default: "local",
  disks: {
    local: {
      driver: "local",
      baseDir: "./storage/uploads",
      publicUrl: "/storage/files",
    },
    s3: {
      driver: "s3",
      bucket: process.env.S3_BUCKET || "my-bucket",
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  },
});
