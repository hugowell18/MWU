/**
 * Backend server configuration - supports large file uploads
 * Example: Express.js + Multer
 */

import express, { Express } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { validateCsvFile } from '../utils/fileValidation';

const app: Express = express();

// ============ Configuration ============

// 1. File upload configuration
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Use memory storage (suitable for small files) or disk storage (suitable for large files)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Prevent filename collisions
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

// 2. File size and type limits
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
    files: 1, // upload only one file at a time
  },
  fileFilter: (req, file, cb) => {
    // Only allow CSV files
    if (file.mimetype !== 'text/csv' && !file.originalname.endsWith('.csv')) {
      return cb(new Error('Only CSV files are supported'));
    }
    cb(null, true);
  },
});

// 3. Middleware
app.use(express.json());
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({ error: 'File too large, maximum allowed is 50MB' });
    }
    return res.status(400).json({ error: err.message });
  }

  if (err) {
    return res.status(400).json({ error: err.message });
  }

  next();
});

// ============ Routes ============

/**
 * CSV upload endpoint
 * POST /api/upload/csv
 */
app.post('/api/upload/csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Re-validate file (optional)
    const file = req.file;
    const fileObj = new File([await fs.promises.readFile(file.path)], file.originalname);

    // If needed, adapt to the frontend validation function
    // const validation = validateCsvFile(fileObj);
    // if (!validation.valid) {
    //   return res.status(400).json({ error: validation.error });
    // }

    console.log(`✅ CSV upload succeeded: ${file.filename} (${file.size} bytes)`);

    // Process CSV content
    const csvContent = await fs.promises.readFile(file.path, 'utf-8');
    const rows = csvContent.split('\n').filter(row => row.trim());

    return res.status(200).json({
      success: true,
      message: 'File uploaded and processed successfully',
      fileInfo: {
        filename: file.filename,
        originalName: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        uploadedAt: new Date().toISOString(),
      },
      csvInfo: {
        totalRows: rows.length,
        headers: rows[0]?.split(',') || [],
      },
      filePath: `/uploads/${file.filename}`,
    });
  } catch (error) {
    console.error('❌ Upload error:', error);
    
    // Delete the uploaded file if present
    if (req.file) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (unlinkError) {
        console.error('Failed to delete file:', unlinkError);
      }
    }
    return res.status(500).json({ error: 'File processing failed' });
  }
});

/**
 * Stream upload - for large files
 * POST /api/upload/stream
 */
app.post('/api/upload/stream', (req, res) => {
  const filename = `stream-${Date.now()}.csv`;
  const filepath = path.join(uploadDir, filename);
  const writeStream = fs.createWriteStream(filepath);

  let totalSize = 0;
  const maxSize = 50 * 1024 * 1024; // 50MB

  // Listen to request data stream
  req.on('data', (chunk) => {
    totalSize += chunk.length;

    if (totalSize > maxSize) {
      req.pause();
      writeStream.destroy();
      fs.unlink(filepath, () => {});
      res.status(413).json({ error: 'File too large' });
    }
  });

  req.pipe(writeStream);

  writeStream.on('finish', () => {
    console.log(`✅ Stream upload succeeded: ${filename}`);
    res.json({
      success: true,
      filename,
      size: totalSize,
      path: `/uploads/${filename}`,
    });
  });

  writeStream.on('error', (error) => {
    console.error('❌ Stream write error:', error);
    res.status(500).json({ error: 'Upload failed' });
  });

  req.on('error', (error) => {
    console.error('❌ Request error:', error);
    writeStream.destroy();
    fs.unlink(filepath, () => {});
  });
});

/**
 * Chunked upload - for very large files
 * POST /api/upload/chunk
 */
app.post('/api/upload/chunk', upload.single('chunk'), (req, res) => {
  const { chunkIndex, totalChunks, fileId } = req.body;

  if (!req.file || !fileId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  console.log(`📦 Received chunk ${chunkIndex}/${totalChunks} (file: ${fileId})`);

  // If this is the last chunk, merge all chunks
  if (parseInt(chunkIndex) === parseInt(totalChunks) - 1) {
    console.log(`✅ All chunks uploaded, starting merge...`);
    // implement chunk merge logic
  }

  res.json({
    success: true,
    chunkIndex,
    message: 'Chunk upload successful',
  });
});

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// ============ Start server ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📁 Upload directory: ${uploadDir}`);
  console.log(`⚙️ File size limit: 50MB`);
});
