export interface Attachment {
  id: string;
  file: File;
  preview: string;
  mediaType: string;
}

export const ACCEPTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
] as const;

const ACCEPTED_IMAGE_TYPES = new Set<string>(ACCEPTED_IMAGE_MIME_TYPES);
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

export interface AttachmentValidationResult {
  attachments: Attachment[];
  errors: string[];
}

export function createAttachment(file: File): Attachment {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    preview: URL.createObjectURL(file),
    mediaType: file.type || "application/octet-stream"
  };
}

export function createValidImageAttachments(
  files: FileList | File[],
  existingAttachments: Attachment[]
): AttachmentValidationResult {
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  let totalBytes = existingAttachments.reduce(
    (sum, attachment) => sum + attachment.file.size,
    0
  );

  for (const file of Array.from(files)) {
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      errors.push(
        `${file.name || "File"} is not a supported image type. Use PNG, JPEG, WebP, or GIF.`
      );
      continue;
    }

    if (
      existingAttachments.length + attachments.length >=
      MAX_IMAGE_ATTACHMENTS
    ) {
      errors.push(
        `Only ${MAX_IMAGE_ATTACHMENTS} images can be attached per message.`
      );
      continue;
    }

    if (file.size > MAX_IMAGE_BYTES) {
      errors.push(
        `${file.name || "Image"} is too large. Images must be ${formatBytes(MAX_IMAGE_BYTES)} or smaller.`
      );
      continue;
    }

    if (totalBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
      errors.push(
        `Image attachments can total up to ${formatBytes(MAX_TOTAL_IMAGE_BYTES)} per message.`
      );
      continue;
    }

    totalBytes += file.size;
    attachments.push(createAttachment(file));
  }

  return { attachments, errors: dedupe(errors) };
}

export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function dedupe(values: string[]) {
  return Array.from(new Set(values));
}

function formatBytes(bytes: number) {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}
