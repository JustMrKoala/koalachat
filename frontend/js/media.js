const Media = {
  MAX_IMAGE_BYTES: 280000,
  MAX_AUDIO_BYTES: 480000,
  MAX_FILE_BYTES: 512000,
  MAX_AUDIO_MS: 60000,

  async compressImage(file) {
    const bitmap = await createImageBitmap(file);
    const maxDim = 1280;
    let w = bitmap.width;
    let h = bitmap.height;
    if (w > maxDim || h > maxDim) {
      if (w >= h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    let quality = 0.82;
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    while (blob && blob.size > Media.MAX_IMAGE_BYTES && quality > 0.4) {
      quality -= 0.1;
      blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    }
    if (!blob) throw new Error("Image encode failed");
    if (blob.size > Media.MAX_IMAGE_BYTES) throw new Error("Image too large");
    return blob;
  },

  async prepareFile(file) {
    if (!file || file.size > Media.MAX_FILE_BYTES) throw new Error("File too large");
    return file;
  },

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const base64 = typeof result === "string" ? result.split(",")[1] : "";
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  },

  pickRecorderMime() {
    const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    for (const t of types) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  },

  createRecorder(stream) {
    const mime = Media.pickRecorderMime();
    return mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  },
};