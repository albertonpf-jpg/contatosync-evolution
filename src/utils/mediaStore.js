const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const MEDIA_ROOT = process.env.MEDIA_DIR
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'media')
    : path.join(__dirname, '../../uploads/media'));

const PUBLIC_BASE_PATH = '/media';

function ensureMediaRoot() {
  if (!fs.existsSync(MEDIA_ROOT)) {
    fs.mkdirSync(MEDIA_ROOT, { recursive: true });
  }
}

function sanitizeFileName(value) {
  return String(value || 'arquivo')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'arquivo';
}

function extensionFromMime(mimetype) {
  const cleanMime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/opus': '.ogg',
    'audio/webm': '.webm',
    'audio/wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'application/pdf': '.pdf'
  };
  return map[cleanMime] || '';
}

function createStoredFile(buffer, options = {}) {
  ensureMediaRoot();
  const clientId = sanitizeFileName(options.clientId || 'shared');
  const type = sanitizeFileName(options.messageType || 'file');
  const clientDir = path.join(MEDIA_ROOT, clientId);
  if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });

  const originalName = sanitizeFileName(options.originalName || '');
  const currentExt = path.extname(originalName);
  const ext = currentExt || extensionFromMime(options.mimetype || '') || '.bin';
  const id = uuidv4();
  const fileName = `${type}-${id}${ext}`;
  const filePath = path.join(clientDir, fileName);

  fs.writeFileSync(filePath, buffer);

  return {
    id,
    fileName,
    originalName: originalName || fileName,
    mimetype: String(options.mimetype || 'application/octet-stream').split(';')[0].trim(),
    size: buffer.length,
    path: filePath,
    publicPath: `${PUBLIC_BASE_PATH}/${encodeURIComponent(clientId)}/${encodeURIComponent(fileName)}`
  };
}

function mediaRoot() {
  ensureMediaRoot();
  return MEDIA_ROOT;
}

module.exports = {
  createStoredFile,
  extensionFromMime,
  mediaRoot,
  sanitizeFileName
};
