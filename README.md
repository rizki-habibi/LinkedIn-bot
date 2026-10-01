# LinkedIn Bot — AI Story Autopublisher

AI content automation worker for Railway + Supabase + GitHub.

## Tujuan

Worker berjalan terus di Railway dan setiap 1 jam:
1. Mengambil project cerita aktif dari Supabase.
2. Menghasilkan satu episode cerita baru dengan AI.
3. Menyimpan episode dan status publish ke Supabase.
4. Menerbitkan episode ke LinkedIn melalui API resmi jika kredensial LinkedIn tersedia.
5. Mencatat hasil, error, dan external post ID.

Contoh project:
**Kisah Cinta Tak Terlupakan** — novel berseri. Setiap jam satu episode baru, tetapi karakter, timeline, dan alur tetap dijaga oleh memory/story bible di database.

## Arsitektur

GitHub → Railway Worker → Supabase PostgreSQL
                              ├─ projects
                              ├─ story_memory
                              ├─ content_queue
                              ├─ publish_logs
                              └─ worker_runs

Railway harus menjalankan service worker sebagai proses always-on. GitHub menjadi source/deployment trigger; Supabase menyimpan state sehingga restart Railway tidak menghilangkan antrean.

## Environment

Salin `.env.example` menjadi environment variables di Railway.

Required:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- AI_API_KEY

LinkedIn:
- LINKEDIN_ACCESS_TOKEN
- LINKEDIN_AUTHOR_URN
- LINKEDIN_VERSION (opsional, default 202610)

AI:
- AI_BASE_URL (opsional; OpenAI-compatible endpoint)
- AI_MODEL (default: gpt-5.6-mini)

Scheduler:
- POST_INTERVAL_MINUTES=60
- TIMEZONE=Asia/Jakarta
- DRY_RUN=true untuk pengujian awal

## Penting tentang LinkedIn

Publishing memakai API resmi LinkedIn, bukan scraping atau simulasi browser. Untuk posting atas nama member, aplikasi membutuhkan izin `w_member_social` dan OAuth access token. LinkedIn saat ini mendokumentasikan Posts API sebagai pengganti UGC Posts API.

Jangan masukkan access token atau service-role key ke GitHub.

## Menjalankan lokal

```bash
npm install
npm start
```

Untuk pengujian tanpa posting:

```
DRY_RUN=true
```

## Railway

Deploy repository ini sebagai service worker:
- Build: `npm ci`
- Start: `npm start`
- Restart policy: On Failure / Always sesuai konfigurasi Railway
- Jangan gunakan cron GitHub Actions sebagai mesin utama 24/7.

## Story engine

Story project menyimpan:
- premise
- genre
- tone
- characters
- locations
- unresolved threads
- last episode summary
- style rules

AI hanya membuat episode berikutnya dari state tersebut. Ini mencegah cerita kehilangan kontinuitas ketika worker restart.

## Lisensi

Kode proyek ini adalah milik repository ini. Komponen/API pihak ketiga tetap mengikuti lisensinya masing-masing.
