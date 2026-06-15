# VPS Deployment Guide — Supporting 100 Concurrent Users

## 📋 Minimum VPS Requirements

```
Recommended configuration:
- CPU: 4 cores (e.g. AWS t3.medium)
- Memory: 8 GB
- Storage: 100+ GB SSD
- Bandwidth: unlimited or 1000+ Mbps
```

## 🔧 Deployment Architecture

```
User requests
    ↓
CDN / Cloudflare
    ↓
Nginx reverse proxy (load balancing)
    ↓
Node.js app (PM2 clustered processes)
    ↓
Supabase PostgreSQL
    ↓
Redis cache (optional)
```

## 📦 Deployment Steps

### 1. Environment Setup

```bash
# SSH into the VPS
ssh root@your_vps_ip

# Update system packages
apt update && apt upgrade -y

# Install Node.js (v18+)
curl -sL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt install -y nodejs

# Install PM2 (process manager)
npm install -g pm2

# Install Nginx (reverse proxy)
apt install -y nginx

# Install Git
apt install -y git
```

### 2. Application Deployment

```bash
# Clone the repo
cd /var/www
git clone https://github.com/yourusername/Ldtwebdemo.git
cd Ldtwebdemo

# Install dependencies
npm install

# Build production bundle
npm run build

# Start the app with PM2
pm2 start "npm run preview" --name "ldtwebdemo"
pm2 startup
pm2 save
```

### 3. Nginx Configuration

Create `/etc/nginx/sites-available/ldtwebdemo`:

```nginx
upstream nodejs_app {
    # multiple Node.js instances (load balancing)
    server 127.0.0.1:5173;
    server 127.0.0.1:5174;
    server 127.0.0.1:5175;
}

server {
    listen 80;
    listen [::]:80;
    server_name yourdomain.com www.yourdomain.com;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css text/javascript 
               application/json application/javascript;
    gzip_min_length 1000;

    # Request size limit
    client_max_body_size 100M;  # CSV upload limit

    # Static file caching
    location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Reverse proxy to Node.js
    location / {
        proxy_pass http://nodejs_app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        
        # Timeout settings (for large file uploads)
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        
        # Forward client IP
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Special handling for upload endpoint
    location /api/upload {
        proxy_pass http://nodejs_app;
        client_max_body_size 500M;  # allow uploads up to 500MB
        proxy_read_timeout 600s;
    }

    # SSL redirection (production)
    # listen 443 ssl http2;
    # ssl_certificate /path/to/cert.crt;
    # ssl_certificate_key /path/to/key.key;
}
```

Enable the site and restart Nginx:

```bash
ln -s /etc/nginx/sites-available/ldtwebdemo /etc/nginx/sites-enabled/
nginx -t  # test config
systemctl restart nginx
```

### 4. SSL Certificates (HTTPS)

```bash
# Use Let's Encrypt
apt install -y certbot python3-certbot-nginx
certbot certonly --nginx -d yourdomain.com -d www.yourdomain.com

# Enable automatic renewal
systemctl enable certbot.timer
```

### 5. Database optimizations

In the Supabase console:

```sql
-- Create important indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_results_student_id ON results(student_id);
CREATE INDEX idx_uploads_created_at ON uploads(created_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE results ENABLE ROW LEVEL SECURITY;

-- Example policy
CREATE POLICY "users_can_view_own_results" ON results
  FOR SELECT USING (auth.uid() = user_id OR auth.jwt() ->> 'role' = 'admin');
```

### 6. Performance monitoring

```bash
# Monitor the Node processes
pm2 monit

# View logs
pm2 logs ldtwebdemo

# System monitoring
htop
```

## 📊 Expected performance

| Configuration | Concurrent users | Avg response time | CPU usage |
|------|--------|----------|---------|
| 1 core 2G RAM | 10-20 | 500ms | 80-100% |
| 2 cores 4G RAM | 30-50 | 300ms | 60-80% |
| **4 cores 8G RAM** | **100+** | **<200ms** | **40-60%** |

## ⚠️ CSV upload optimizations

### Frontend
```typescript
// Chunk large files before upload
const chunkSize = 1024 * 1024; // 1MB chunks
for (let i = 0; i < file.size; i += chunkSize) {
  const chunk = file.slice(i, i + chunkSize);
  await uploadChunk(chunk, i / chunkSize);
}
```

### Backend
```javascript
// Use streaming to avoid high memory usage
app.post('/api/upload', (req, res) => {
  const stream = req.pipe(fs.createWriteStream('./uploads/file.csv'));
  stream.on('finish', () => res.json({ success: true }));
});
```

## 🚀 Scaling options (for 1000+ users)

1. **Load balancing**: use AWS ELB / Cloudflare Load Balancer
2. **Database**: migrate from Supabase to a self-managed PostgreSQL cluster
3. **Object storage**: use AWS S3 / Cloudflare R2
4. **Cache**: deploy Redis cluster
5. **CDN**: use Cloudflare / AWS CloudFront

## 💰 Cost comparison

| Option | Monthly cost | Supported users |
|------|-------|--------|
| Recknerd VPS (2 cores, 4G) | $10-20 | ~50 users |
| Recknerd VPS (4 cores, 8G) | $30-50 | 100+ users |
| AWS EC2 t3.medium | $25-35 | ~100 users |
| **Supabase Pro** | $25+ | auto-scaling (higher limits) |

---

## 📝 Summary

✅ **For 100 concurrent users, recommended:**
- **VPS configuration**: 4 cores, 8 GB RAM (approx $40/month)
- **Supabase**: use Pro plan
- **Upload limit**: CSV up to 50 MB
- **Deployment**: Nginx + PM2 + CDN

❌ **Avoid**:
- Single-core VPS (will struggle)
- Directly exposing Node.js on port 80 without a proxy
- Storing large volumes of files on the VPS (use S3/R2 instead)
