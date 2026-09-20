# RANGE — Smart Wallet Scout

MVP dashboard untuk memantau smart wallet pada Meteora DLMM di Solana, membaca pool yang sedang aktif, mendeteksi fresh token entry, dan menyiapkan alur mirror yang non-custodial.

## Yang sudah ada

- Dashboard responsive bergaya dark terminal.
- Leaderboard wallet dengan metrik ROI, PnL, drawdown, dan smart score.
- Pool list dari Meteora DLMM Data API melalui Netlify Function `/api/pools`.
- Helius server-side integration untuk RPC, balance, activity, dan Enhanced Transactions.
- **Fresh smart-wallet entries / New Token Radar**: mengambil aktivitas terbaru program DLMM via Helius, metadata mint via DAS, mencocokkan pool Meteora, lalu menampilkan wallet, action, age, TVL, fee APR, dan risk flags.
- Tombol sync, export watchlist, filter periode, sorting, live activity feed, dan modal review mirror.
- `copy-plan` endpoint untuk validasi parameter dan mengambil snapshot pool. Endpoint ini tidak menyimpan private key dan belum mengirim transaksi.
- Netlify redirects untuk semua endpoint API.

## Jalankan lokal

Untuk preview visual sederhana:

```bash
python3 -m http.server 4173
```

Buka `http://localhost:4173`.

Untuk mengetes Netlify Functions dan redirect `/api/*`:

```bash
npm install
npm run dev
```

## Deploy ke Netlify

1. Push folder ini ke GitHub.
2. Import repository di Netlify.
3. Build command boleh dikosongkan; publish directory adalah `.`.
4. Tambahkan environment variables berikut di Netlify — jangan taruh secret di `index.html`:

```env
HELIUS_API_KEY=your-helius-api-key

# Optional OpenAI-compatible reasoning layer. Server-side only.
OPENAI_API_KEY=your-ai-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
```

Opsional:

```env
WATCH_WALLETS=wallet_address_1,wallet_address_2
LEADERBOARD_SOURCE_URL=https://your-indexer.example.com/leaderboard.json
NON_COPYABLE_WALLETS=wallet_address_that_can_be_tracked_but_not_copied
```

5. Deploy dan lakukan redeploy setelah environment variables tersimpan.

## Endpoint yang tersedia

- `/api/pools` — pool list terbaru dari Meteora.
- `/api/leaderboard` — leaderboard dari `WATCH_WALLETS` atau `LEADERBOARD_SOURCE_URL`.
- `/api/helius-health` — cek Helius RPC dan finalized slot.
- `/api/helius-activity` — aktivitas terbaru program DLMM dari Helius.
- `/api/wallet-profile?wallet=...` — portfolio/PnL Meteora + SOL balance Helius.
- `/api/new-token-radar?hours=24&limit=20` — fresh token entry dari smart wallet.
- `/api/wallet-network?wallet=...` — relationship graph berbasis transfer/interaksi on-chain.
- `/api/fresh-wallets?days=7&min_roi=20&limit=6` — wallet yang baru terlihat aktif di DLMM dan punya PnL positif melewati threshold.
- `/api/agent-screen` — agent screening pool, fresh wallet, fresh token, risk flag, dan rekomendasi deployment.
- `/api/pool-risk?poolAddress=...` — heuristic blocklist untuk pool/token mencurigakan dan sample wallet-loss.
- `/api/trending-entries?hours=6&limit=12` — mencocokkan pool trending Meteora dengan entry smart wallet yang terdeteksi Helius.
- `/api/copy-plan` — validasi dan review copy plan tanpa private key.

Endpoint resmi Meteora yang dipakai untuk data pool adalah `https://dlmm.datapi.meteora.ag/pools`. Helius dipakai untuk RPC mainnet, Enhanced Transactions, DAS metadata, dan aktivitas program DLMM.

## Catatan penting untuk versi production

Fresh Token Radar saat ini membaca window transaksi terbaru saat endpoint dipanggil. Untuk daftar global yang benar-benar selalu uptodate dan histori PnL yang konsisten, gunakan worker/indexer persisten:

1. Subscribe transaksi Meteora DLMM melalui Helius enhanced transactions/webhook atau Yellowstone gRPC.
2. Simpan event `initialize_position`, `add_liquidity`, `remove_liquidity`, `claim_fee`, `claim_reward`, dan `swap` ke database durable.
3. Hitung net realized PnL setelah fee, token price, IL estimate, gas, dan drawdown.
4. Publish JSON leaderboard ke `LEADERBOARD_SOURCE_URL` atau ganti function dengan Supabase/Netlify Blobs.
5. Gunakan Helius webhook untuk alert near-real-time; scheduled function cocok untuk refresh metadata, bukan listener permanen.

New Token Radar sengaja tidak langsung mengeksekusi transaksi. Untuk token sangat baru, default yang aman adalah review manual karena risiko likuiditas tipis, mint/freeze authority aktif, price impact, rug pull, dan posisi cepat out-of-range.

Pool-risk guardrail otomatis memberi skor dan dapat memblokir pool dari rekomendasi jika Meteora menandai blacklisted, TVL terlalu tipis, APR tidak normal dibanding TVL, volume/TVL anomali, authority token aktif, atau sample posisi wallet yang dipantau banyak negatif. Ini adalah heuristic blocklist, bukan bukti pasti rug pull. Agar analisis “banyak wallet loss” bekerja, isi `WATCH_WALLETS` dengan wallet yang ingin dijadikan sample; tanpa sample tersebut sistem tidak akan mengarang statistik loss.

Alur eksekusi yang aman tetap non-custodial: browser membangun unsigned transaction memakai Meteora DLMM SDK, wallet user menandatangani via Phantom/Backpack, lalu transaksi dikirim setelah review. Jangan pernah meminta seed phrase/private key ke server. Tidak ada jaminan profit; performa wallet sebelumnya dapat berubah.
