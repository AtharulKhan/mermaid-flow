import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { storage } from "./config";

export async function uploadThumbnail(flowId, blob) {
  const storageRef = ref(storage, `thumbnails/${flowId}/thumbnail.png`);
  await uploadBytes(storageRef, blob, { contentType: "image/png" });
  return getDownloadURL(storageRef);
}

export async function deleteThumbnail(flowId) {
  const storageRef = ref(storage, `thumbnails/${flowId}/thumbnail.png`);
  try {
    await deleteObject(storageRef);
  } catch (e) {
    // Ignore if file doesn't exist
    if (e.code !== "storage/object-not-found") throw e;
  }
}

export async function uploadExport(flowId, blob, filename) {
  const storageRef = ref(storage, `exports/${flowId}/${filename}`);
  await uploadBytes(storageRef, blob, {
    contentType: blob.type || "application/octet-stream",
  });
  return getDownloadURL(storageRef);
}
