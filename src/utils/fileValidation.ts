/**
 * File validation utility functions
 */

interface FileValidationResult {
  valid: boolean;
  error?: string;
  sizeInMB?: number;
}

// Define allowed file types and size limits
const FILE_LIMITS = {
  csv: { maxSizeMB: 50, mimeTypes: ['text/csv', 'application/csv', 'text/plain'] },
  pdf: { maxSizeMB: 100, mimeTypes: ['application/pdf'] },
  video: { maxSizeMB: 500, mimeTypes: ['video/mp4', 'video/avi', 'video/quicktime'] },
  image: { maxSizeMB: 50, mimeTypes: ['image/jpeg', 'image/png', 'image/gif'] },
  document: { maxSizeMB: 100, mimeTypes: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
};

/**
 * Validate a CSV file.
 * @param file - the uploaded file
 * @returns validation result
 */
export function validateCsvFile(file: File): FileValidationResult {
  if (!file) {
    return { valid: false, error: 'Please select a file' };
  }

  // Check file extension
  if (!file.name.toLowerCase().endsWith('.csv')) {
    return { valid: false, error: 'Only CSV files are supported' };
  }

  // Check MIME type
  if (!FILE_LIMITS.csv.mimeTypes.includes(file.type)) {
    return { valid: false, error: 'Invalid file type. Please ensure the file is a valid CSV' };
  }

  // Check file size
  const sizeInMB = file.size / (1024 * 1024);
  if (sizeInMB > FILE_LIMITS.csv.maxSizeMB) {
    return {
      valid: false,
      error: `File too large. CSV must be under ${FILE_LIMITS.csv.maxSizeMB}MB, current size: ${sizeInMB.toFixed(2)}MB`,
      sizeInMB,
    };
  }

  // Check for empty file
  if (file.size === 0) {
    return { valid: false, error: 'File is empty. Please select a valid CSV file' };
  }

  return { valid: true, sizeInMB };
}

/**
 * Validate a generic file.
 * @param file - the uploaded file
 * @param fileType - file type ('csv' | 'pdf' | 'video' | 'image' | 'document')
 * @returns validation result
 */
export function validateFile(file: File, fileType: keyof typeof FILE_LIMITS): FileValidationResult {
  if (!file) {
    return { valid: false, error: 'Please select a file' };
  }

  const config = FILE_LIMITS[fileType];
  const sizeInMB = file.size / (1024 * 1024);

  // Check file size
  if (sizeInMB > config.maxSizeMB) {
    return {
      valid: false,
      error: `File too large. ${fileType.toUpperCase()} must be under ${config.maxSizeMB}MB, current size: ${sizeInMB.toFixed(2)}MB`,
      sizeInMB,
    };
  }

  // Check MIME type
  if (!config.mimeTypes.includes(file.type)) {
    return { valid: false, error: `Invalid file type. Only ${fileType.toUpperCase()} files are supported` };
  }

  if (file.size === 0) {
    return { valid: false, error: 'File is empty. Please select a valid file' };
  }

  return { valid: true, sizeInMB };
}

/**
 * Format file size to a human-readable string
 * @param bytes - file size in bytes
 * @returns formatted string
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Get file size in MB
 */
export function getFileSizeInMB(file: File): number {
  return file.size / (1024 * 1024);
}

/**
 * Get file type limits information
 */
export function getFileTypeLimits(fileType: keyof typeof FILE_LIMITS) {
  return FILE_LIMITS[fileType];
}
