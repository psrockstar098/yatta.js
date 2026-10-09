// yatta/func/storage.ts
//
// Local disk by default. Point `s3` at R2/S3 for object-scale deployments;
// local disk does not sync across machines.
import { createStorage } from "yatta.js/storage";

declare module "yatta.js/storage" {
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
