# Panduan Hosting Produksi — Kinetik Studio

Paket proyek ini sudah siap di-hosting ke **VPS (Docker / PM2 + Nginx)** maupun **PaaS (Coolify, Dokploy, Railway, Render, Cloud Run)**.

---

## 1. Persiapan File `.env`

Salin `.env.example` menjadi `.env`, lalu isi kredensial Anda:

```bash
cp .env.example .env
```

Isi minimal yang diperlukan di `.env`:

```env
PORT=3000
APP_URL="https://domain-anda.com"
SESSION_SECRET="isi-dengan-string-acak-panjang-minimal-32-karakter"
DATA_DIR="./data"

# Midtrans (Sandbox atau Production)
MIDTRANS_SERVER_KEY="SB-Mid-server-xxxx"
MIDTRANS_CLIENT_KEY="SB-Mid-client-xxxx"
MIDTRANS_IS_PRODUCTION="false"

# Opsional: URL Tunnel ComfyUI jika memakai mode Direct Tunnel
COMFYUI_TUNNEL_URL=""
```

---

## 2. Opsi A — Hosting dengan Docker Compose (Disarankan untuk VPS / Coolify / Dokploy)

Pastikan Docker & Docker Compose terpasang, lalu jalankan:

```bash
docker compose up -d --build
```

- Database SQLite (`kinetik.db`), gambar referensi, dan video output MP4 tersimpan permanen di folder `./data`.
- Cek status server: `curl http://127.0.0.1:3000/healthz` → `{"ok":true}`.

---

## 3. Opsi B — Hosting Langsung di VPS Ubuntu/Debian (Node.js 22 + PM2)

```bash
# 1. Pastikan Node.js v22+ terpasang
node -v

# 2. Pasang dependensi & build frontend React
npm install
npm run build

# 3. Jalankan dengan PM2 (wajib 1 instance karena SQLite + WebSocket Hub)
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

---

## 4. Konfigurasi Reverse Proxy Nginx (Wajib untuk WebSocket & Upload Video MP4)

Pasang konfigurasi berikut pada Nginx agar WebSocket (`/ws/client`, `/ws/worker`) dan unggahan video hasil render berjalan lancar:

```nginx
server {
    listen 80;
    server_name domain-anda.com;

    # Izinkan upload gambar referensi & video MP4 hasil render hingga 300MB
    client_max_body_size 300M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Header wajib untuk WebSocket (/ws/client dan /ws/worker)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout panjang untuk koneksi WebSocket Bridge Agent
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Aktifkan HTTPS menggunakan Certbot (`sudo certbot --nginx -d domain-anda.com`) agar `wss://` dan Midtrans Webhook bekerja dengan aman.

---

## 5. Aktivasi Awal Setelah Online

1. Buka `https://domain-anda.com` dan **daftar akun pertama** (otomatis menjadi **Administrator**).
2. Di **Dashboard Midtrans → Settings → Configuration → Payment Notification URL**, masukkan:
   `https://domain-anda.com/api/payments/midtrans-webhook`
3. Buka menu **Admin → Koneksi ComfyUI**:
   - **Mode Bridge Agent WebSocket**: unduh `comfy-worker-agent.mjs` lalu jalankan `node comfy-worker-agent.mjs` di PC ComfyUI lokal (Node.js v22+).
   - **Mode URL Tunnel Langsung**: masukkan URL publik ComfyUI Anda lalu klik **Uji Koneksi ComfyUI**.
