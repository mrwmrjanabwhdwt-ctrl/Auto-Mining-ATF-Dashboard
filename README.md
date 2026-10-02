# ATF Bot Automation v2

Bot Node.js untuk berinteraksi dengan ATF Telegram Mini App menggunakan file session Telethon. Bot tidak lagi menyimpan `Telegram.WebApp.initData` di `query.txt`; setiap siklus meminta WebView baru dari Telegram dan memakai initData yang segar.

## Persyaratan

- Node.js 22.5 atau lebih baru.
- API ID dan API hash Telegram milik sendiri dari `https://my.telegram.org/apps`.
- File akun Telethon berformat SQLite (`*.session`) yang masih aktif.

## Instalasi

```powershell
npm install
Copy-Item .env.example .env
```

Isi `.env`:

```dotenv
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=api_hash_milik_anda
```

Jangan membagikan API hash, file session, atau `wallets-accounts.json`. File wallet berisi mnemonic dan private key plaintext yang memberi akses penuh ke seluruh wallet.

## Wallet TON per akun

Setelah login, bot memeriksa `wallet_address` dan `wallet_verified` dari server ATF. Jika akun belum memiliki wallet, bot:

1. membuat wallet TON v4r2 mainnet;
2. langsung menulis address, mnemonic, dan private key ke `wallets-accounts.json`;
3. meminta payload TON Proof resmi dari ATF;
4. menandatangani proof untuk domain WebApp ATF;
5. mengirimkannya ke endpoint `sync_wallet`;
6. baru meminta security question dan menjalankan mining setelah wallet terverifikasi.

Jika server membalas `busy` atau `cached/dedup` sementara wallet belum terverifikasi, proses utama mencoba sekali lagi setelah `wallet_busy_retry_seconds` (default 15 detik) dengan TON Proof baru. Jika masih busy, akun langsung dialihkan ke worker wallet dan proses utama lanjut ke akun berikutnya. Maksimal `wallet_worker_concurrency` (default 10) akun busy diproses paralel; sisanya masuk antrean FIFO. Setiap worker retry tiap 15 detik sampai wallet berhasil, bot dihentikan, atau muncul error permanen. Satu file session hanya boleh memiliki satu worker aktif/antre sehingga siklus berikutnya tidak membuat proses duplikat.

Metadata wallet, mnemonic 24 kata, dan private key disimpan langsung sebagai plaintext per Telegram ID di `wallets-accounts.json`. Penyimpanan dilakukan sebelum request verifikasi, sehingga respons `busy` atau akun deferred tidak menghilangkan wallet yang baru dibuat. File ini diabaikan Git dan tidak pernah dicetak ke log.

Wallet yang dibuat adalah alamat wallet sungguhan tetapi belum dideploy ke blockchain sampai digunakan untuk transaksi on-chain. Simpan `wallets-accounts.json` di lokasi aman. Siapa pun yang memperoleh file tersebut dapat menguasai seluruh wallet di dalamnya. Record format lama dengan `encrypted_secrets` dimigrasikan otomatis ke plaintext saat bot pertama kali dibuka; `WALLET_KEYSTORE_PASSWORD` lama hanya diperlukan untuk migrasi tersebut.

## Folder session

Taruh semua file akun pada folder `session/`:

```text
session/
├── akun1.session
├── akun2.session
└── akun3.session
```

Bot memindai folder tersebut setiap siklus. File baru ditemukan otomatis dan nama file digunakan sebagai label akun. Database session dibuka read-only; auth key hanya dipindahkan sementara ke memori untuk meminta WebView.

Struktur kode aplikasi berada di `src/`, pengujian berada di `test/`, dan hanya entry point `index.js` yang tetap di root proyek.

## Referral akun baru

Pengaturan berikut menjalankan alur yang setara dengan membuka deep link Telegram dan menekan Start:

```json
"referral_code": "610911604"
```

Untuk setiap file session yang belum pernah diproses dengan kode tersebut, bot memanggil Telegram `messages.StartBot`, membuka WebView dengan start parameter yang sama, lalu mengirim `ref_code` saat login ATF. Keberhasilan disimpan sebagai hash di `.state/referrals.json`, sehingga StartBot tidak dikirim ulang setiap siklus. Opsi 2 hanya menangani referral; pembuatan dan penyimpanan wallet tetap dilakukan oleh opsi 1. Akun lama biasanya tidak dapat mengganti inviter yang sudah tersimpan di server.

Jika akun baru meminta Cloudflare Turnstile, opsi 2 mengambil `site_key` dari endpoint resmi ATF, meminta token ke [MultiBot](https://multibot.cloud/en/api/), memverifikasinya ke ATF, lalu mengulang login referral secara otomatis. Isi API key di `.env`:

```dotenv
MULTIBOT_API_KEY=api_key_anda
```

Secara default proxy akun tidak dikirim ke MultiBot. Jika token harus diselesaikan dari IP proxy yang sama, aktifkan `MULTIBOT_USE_ACCOUNT_PROXY=1`; opsi ini akan mengirim alamat dan kredensial proxy akun ke layanan MultiBot.

Saat memilih opsi 2 di menu interaktif, bot sekarang meminta pilihan solver: MultiBot atau solver lokal. Source solver lokal dari arsip yang disediakan berada di `local-solver/` dan hanya bind ke `127.0.0.1:8000`.

Untuk menjalankan solver lokal di Windows, install Python 3 terlebih dahulu, lalu dari root proyek:

```powershell
py -3 -m venv local-solver\.venv
local-solver\.venv\Scripts\python.exe -m pip install -r local-solver\requirements.txt
local-solver\.venv\Scripts\python.exe -m camoufox fetch
cd local-solver
.venv\Scripts\python.exe api_server.py --yes
```

Biarkan terminal solver lokal tetap berjalan, buka terminal lain, jalankan bot, pilih opsi 2, lalu pilih `[2] Solver lokal`. Untuk mode non-interaktif gunakan:

```dotenv
TURNSTILE_SOLVER=local
LOCAL_TURNSTILE_SOLVER_URL=http://127.0.0.1:8000
```

## Override per akun

Opsional: salin `account-overrides.example.json` menjadi `account-overrides.json`.

```json
{
  "akun1.session": {
    "enabled": true,
    "proxy": "http://username:password@127.0.0.1:8080",
    "ready_task_ids": ["telegram_join"]
  }
}
```

- `enabled`: mengaktifkan/menonaktifkan session.
- `proxy`: proxy HTTP(S) khusus request ATF. Koneksi MTProto Telegram tetap langsung.
- `ready_task_ids`: task satu-kali yang sudah benar-benar diselesaikan manual dan boleh dicoba claim oleh bot.

File override, proxy, `.env`, cache, state, dan seluruh session diabaikan Git.

## Task dinamis

ATF tidak menyediakan endpoint daftar task. Frontend menyimpan `tasksConfig` sebagai JavaScript inline pada `index.html`. Bot mengunduh halaman itu, mem-parse AST dengan Acorn tanpa `eval`, dan hanya mengambil ID, judul, reward, link, cooldown, minimum waktu, dan status manual review.

Jika frontend tidak dapat dimuat, bot memakai cache terakhir. Jika cache juga tidak ada, claim task dinonaktifkan untuk siklus tersebut—tidak ada fallback hard-coded.

Mode task pada `config.json`:

- `off`: tidak membaca atau memproses task.
- `report`: hanya menampilkan task yang tersedia.
- `claim_ready`: bot mendaftarkan klik link melalui `start_task`, memulai semua task yang eligible, menunggu `minSeconds` secara paralel, lalu claim saat siap. ID pada `ready_task_ids` langsung masuk antrean claim tanpa start ulang.

Sesudah login awal selesai secara berurutan, setiap akun memiliki task worker independen. Status onboarding disimpan per session, bukan sebagai satu flag global: session baru yang ditemukan kemudian tetap wajib melewati login lengkap serta tahap wallet sebelum masuk jalur mining-only dan mendapat task worker. Worker tidur sampai cooldown akun itu berakhir, membaca state server lagi, menjalankan start/claim task yang sudah siap, lalu menyimpan jadwal berikutnya dari respons terbaru. Jika task sudah `Ready` tetapi claim/start gagal, retry dibatasi oleh `task_ready_retry_seconds` (default 60 detik) agar tidak terjadi tight loop. `loop_interval_hours` tidak lagi mengatur task; interval ini khusus siklus claim mining.

## Menjalankan

```powershell
npm start
```

Saat `npm start` dijalankan dari terminal, tersedia menu:

```text
[1] Jalankan BOT
[2] Daftarkan akun dengan kode referral
[3] Ganti wallet TON
[4] Cek Stats akun
[5] Withdraw ATF
[0] Keluar
```

Opsi `[1] Jalankan BOT` membuka dashboard Textual bertema navy-violet-coral. Worker Node tetap menjalankan seluruh otomasi; dashboard menangkap log live dan menyajikan username Telegram, level, mined ATF, ATF holding, pending reward, wallet, mining, task claim, countdown claim task berikutnya, referral sukses/total, status claim referral, Team Wallet, koneksi, serta ringkasan siklus. Opsi menu lainnya tetap memakai tampilan terminal bawaan. Jika Python berada di lokasi khusus, isi environment variable `ATF_PYTHON` dengan path lengkap menuju `python.exe`.

Siapkan dashboard sekali:

```powershell
python -m pip install -r requirements-textual.txt
```

Setelah itu jalankan `npm start` dan pilih `[1]`, atau langsung gunakan `npm run dashboard`. Item Footer dapat diklik dengan mouse atau dipanggil lewat keyboard: `q` graceful stop dan keluar, `p` pause/resume worker, `r` refresh statistik terbaru seluruh akun secara paralel, `c` membersihkan panel log, `PgUp/PgDn` menggulir log, serta `g/Shift+G` menuju awal/akhir log. Dashboard juga melakukan refresh state otomatis sesuai `dashboard_refresh_interval_minutes` (default 10 menit). Operasi untuk akun berbeda dapat berjalan paralel, tetapi akses session akun yang sama tetap diantrikan agar tidak saling bertabrakan. Scroll mouse dan scrollbar juga bekerja saat pointer/fokus berada di panel log. `npm run start:run` tetap menjalankan bot dengan log terminal biasa tanpa Textual.

Opsi `[3] Ganti wallet TON` memindai seluruh session dan langsung melewati akun yang sudah memiliki mnemonic/private key valid di `wallets-accounts.json`. Akun verified tanpa secret lokal tidak dapat dibedakan secara teknis antara wallet bot lama yang backup-nya hilang dan wallet external asli. Karena itu bot menampilkan username serta alamat wallet tersamarkan dan meminta konfirmasi `y` per akun; Enter/`n` berarti skip dan `q` membatalkan sisa pemindaian. Setelah disetujui, wallet baru beserta mnemonic disimpan terlebih dahulu, lalu wallet ATF dipindahkan secara atomik melalui `sync_wallet` dan TON Proof. Aset on-chain pada wallet lama tidak dipindahkan. Respons busy disimpan sebagai `replacement_pending`; setelah seluruh akun selesai dipindai, maksimal 5 retry worker mengulang tiap `wallet_busy_retry_seconds` sampai berhasil atau bot dihentikan. Replacement yang terputus dapat dilanjutkan dengan menjalankan opsi 3 lagi. Mode ini juga tersedia melalui `npm run replace-wallets` dari terminal interaktif.

Opsi `[4] Cek Stats akun` membuka dashboard read-only khusus audit akun. Dashboard mengambil login terbaru, memanggil `sync_wallet`, lalu membaca `get_withdraw_history` dengan maksimal `stats_worker_concurrency` worker (dibatasi maksimum 5). Field yang ditampilkan adalah username, wallet address, ATF holding, mined balance, banned, risk score, qualified DEX buy, pending withdraw, status withdrawal terbaru (`NONE`, `PENDING`, `APPROVED`, `KYC/VERIFY`, `FAILED`, atau `UNAVAILABLE`), serta `FRAUD MASK` dari `masked_auto_fraud`. Status KYC dan fraud mask merupakan sinyal terpisah. Respons `busy` tetap digunakan ketika server menyertakan objek `user`. Tekan `r` untuk mengecek ulang atau `q` untuk keluar. Dashboard ini juga dapat dibuka langsung dengan `npm run stats`.

Opsi `[5] Withdraw ATF` berjalan sequential dan meminta satu konfirmasi sebelum memulai batch karena fee server adalah 70 ATF per request. Setiap akun login memakai session baru, membaca `mined_balance` serta `pending_reward`, meng-claim pending reward jika ada, lalu login ulang untuk memperoleh mined balance terbaru. Akun dengan saldo di bawah 500 ATF atau wallet belum verified langsung di-skip. Untuk akun eligible, seluruh mined balance (dibulatkan turun ke 4 desimal) dikirim sebagai amount withdrawal. CAPTCHA gambar diselesaikan melalui 2Captcha `ImageToTextTask`; isi `TWOCAPTCHA_API_KEY` di `.env`. Sebelum submit bot memakai jitter resmi frontend 1,2-2 detik. Jika jawaban ditolak atau solver gagal, bot meminta challenge baru dan retry hingga batas terkecil antara `withdraw_captcha_max_attempts` (maksimum 3) dan `attempts_left` dari server. Respons `retry_after_seconds`, `withdraw_locked`, atau percobaan server yang habis menghentikan retry akun tersebut agar tidak menambah lock. Setelah submit, bot membaca history dan melaporkan status `pending`, `approved`, `KYC`, atau `failed`; `masked_auto_fraud` mengikuti frontend dan tetap ditampilkan sebagai `pending`. Bot kemudian lanjut ke akun berikutnya. Dapat dijalankan langsung dengan `npm run withdraw` dari terminal interaktif.

Jika `proxy.txt`/`proxies.txt` berisi proxy, opsi withdraw membuat pool unik untuk satu batch. Setiap proxy hanya boleh diambil sekali sejak opsi 5 dimulai, termasuk proxy yang gagal, sehingga tidak pernah dipindahkan ke akun lain pada batch yang sama. Network error pada login, claim, refresh saldo, pengambilan CAPTCHA, submit, atau pembacaan history langsung merotasi koneksi ke proxy sehat berikutnya yang belum pernah dipakai. Jalur withdraw memakai satu network attempt per proxy; tidak ada fallback ke IP direct ketika pool tersedia. `request_id` claim dan submit withdraw dipertahankan saat rotasi agar retry tidak membuat aksi ganda. Jika proxy unik habis, akun terkait gagal dan bot lanjut ke akun selanjutnya; sediakan sedikitnya satu proxy per akun plus cadangan untuk retry.

Untuk scheduler atau proses non-interaktif, gunakan `npm run start:run`. Pendaftaran referral tanpa menu dapat dijalankan dengan `npm run register-referral`.

Pemeriksaan dan test:

```powershell
npm run check
npm test
```

Tekan `Ctrl+C` untuk graceful shutdown. Bot melakukan cleanup koneksi dan tidak memulai akun berikutnya setelah sinyal shutdown.

## Keamanan dan retry

- Host API dan WebApp dibatasi oleh `allowed_hosts` serta wajib HTTPS.
- Redirect HTTP tidak diikuti otomatis.
- HTTP 401/403 tidak di-retry.
- HTTP 429 dan 5xx memakai exponential backoff dengan jitter.
- Request ID tidak berubah saat retry agar aksi dapat diperlakukan idempotent oleh server.
- Saat mining perlu security question, bot menghitung soal aritmetika sederhana secara otomatis; format yang tidak dikenali memakai input terminal manual sebagai fallback.
- Session token, initData, hash, dan password proxy disensor dari log.
- Device ID stabil per Telegram ID disimpan di `.state/device-ids.json`.
- `config.json`, folder session, proxy, dan override akun dibaca ulang setiap siklus.
- Ringkasan akun membedakan `success`, `partial`, dan `failed`.
- Proxy yang gagal pada login ATF sebanyak batas konfigurasi dikarantina sementara. Bot tidak fallback diam-diam ke IP langsung.

Respons bisnis seperti cooldown atau `already claimed` tidak diperlakukan sebagai network retry.
