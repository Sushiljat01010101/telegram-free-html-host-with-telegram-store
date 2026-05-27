# 🚀 Telegram Free HTML Host — with Telegram Storage

Ek Telegram bot jo users ko **HTML, ZIP, JS, CSS files** host karne deta hai.
Files **Telegram channel** mein store hoti hain (unlimited storage) aur metadata **Supabase DB** mein — koi Supabase Storage bucket nahi chahiye!

---

## ✨ Features

- 📤 **File Upload** — HTML, ZIP, JS, CSS support
- 🗄️ **Unlimited Storage** — Files Telegram channel mein store hoti hain
- 🔗 **Public Links** — Har file ke liye instant hosting link
- 👥 **Referral System** — Refer karo, extra storage slots pao
- 👑 **Premium Users** — Admin se premium access
- 📢 **Broadcast** — Sab users ko message bhejo
- 🔔 **Notifications** — Users on/off kar sakte hain
- 🛡️ **Ban/Unban** — Admin ban system
- ♻️ **Zero Data Loss** — Bot restart pe koi data loss nahi

---

## 🏗️ Architecture

```
User uploads file
      ↓
Bot sends file_id → Telegram Storage Channel (unlimited)
      ↓
Metadata saved → Supabase DB (files table)
      ↓
User gets link → /api/view/:userId/:fileName
      ↓
Server fetches from Telegram API → serves to browser
```

---

## 📁 Project Structure

```
├── bot.cjs                  # Main entry point — Telegram bot + Express server
├── render.yaml              # Render deployment config (infrastructure-as-code)
├── build.mjs                # esbuild bundler config (TypeScript server build)
├── package.json             # Dependencies & scripts
├── tsconfig.json            # TypeScript config
├── supabase-schema.sql      # Run this in Supabase SQL Editor
├── .env.example             # Environment variables template
└── src/
    ├── app.ts               # Express app setup (TypeScript version)
    ├── index.ts             # Server entry point (TypeScript version)
    ├── lib/
    │   └── logger.ts        # Pino logger
    └── routes/
        ├── health.ts        # /api/healthz endpoint
        ├── index.ts         # Route registration
        └── view.ts          # /api/view/:userId/:fileName
```

> **Note:** `bot.cjs` is the main production file. It runs **both** the Telegram bot and the Express web server (including `/api/view` file serving) on a single process — perfect for Render's free tier (one service, one PORT).

---

## 🚀 Render pe Deploy Karna (Step-by-Step)

### Step 1 — GitHub pe Push karo

Pehle apna code GitHub repo me push karo:

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

---

### Step 2 — Supabase Setup

1. [supabase.com](https://supabase.com) pe free account banao
2. **New Project** create karo
3. Left sidebar → **SQL Editor** → **New Query** click karo
4. `supabase-schema.sql` file ka sara content paste karo aur **Run** karo
5. Yeh tables ban jayengi: `users`, `files`, `daily_stats`, `bot_config`

**Keys lene ke liye:**
- Left sidebar → **Settings** → **API**
- `Project URL` copy karo → yeh `SUPABASE_URL` hai
- `service_role` key copy karo → yeh `SUPABASE_SERVICE_KEY` hai

---

### Step 3 — Telegram Setup

#### 3a. Bot banao (@BotFather se)
1. Telegram me `@BotFather` open karo
2. `/newbot` send karo
3. Bot ka naam aur username do
4. **Bot Token** copy karo → yeh `TELEGRAM_BOT_TOKEN` hai

#### 3b. Storage Channel banao
1. Telegram me ek **Private Channel** banao (naam kuch bhi rakho)
2. Apne bot ko channel ka **Administrator** banao ("Post Messages" permission de)
3. Channel ka ID pane ke liye:
   - `@userinfobot` ko channel me add karo
   - Ya channel ka koi message forward karo `@userinfobot` ko
   - ID format hoga: `-100xxxxxxxxxx`
4. Yeh ID `TELEGRAM_STORAGE_CHANNEL_ID` hai

#### 3c. Apna Telegram ID pao
1. `@userinfobot` ko Telegram me open karo
2. `/start` bhejo — tumhara **User ID** aayega
3. Yeh `ADMIN_ID` hai

---

### Step 4 — Render pe Deploy

1. [render.com](https://render.com) pe free account banao
2. Dashboard me **New +** → **Web Service** click karo
3. **Connect a repository** → apna GitHub repo select karo
4. Yeh settings lagao:

| Setting | Value |
|---|---|
| **Name** | `telegram-html-host` (ya kuch bhi) |
| **Region** | Singapore (ya apne pass wala) |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node bot.cjs` |
| **Instance Type** | `Free` |

5. **Environment Variables** section me niche scroll karo aur yeh sab add karo:

| Key | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather se mila token |
| `TELEGRAM_STORAGE_CHANNEL_ID` | `-100xxxxxxxxxx` format |
| `ADMIN_ID` | Tumhara Telegram user ID |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Service role key |

6. **Create Web Service** click karo
7. Deploy hone ke baad tumhe milega ek URL jaise: `https://telegram-html-host-xxxx.onrender.com`

---

### Step 5 — Verify karo

Deploy hone ke baad:
1. Browser me `https://YOUR-APP.onrender.com` kholo → Status page dikhna chahiye ✅
2. Telegram me apna bot open karo → `/start` bhejo → Bot respond kare ✅
3. Ek HTML file upload karo → Link milna chahiye ✅
4. Link kholo browser me → HTML render hona chahiye ✅

---

## ⚠️ Render Free Tier — Important Notes

| Issue | Solution |
|---|---|
| **Service sone lagti hai** (15 min inactivity pe) | UptimeRobot se free ping lagao |
| **Cold start delay** | Pehli request pe 30-60 sec lag sakti hai |
| **750 hrs/month limit** | Free tier me ek service ke liye kaafi hai |

### UptimeRobot se Bot ko Jagte Rakhna (Free)

1. [uptimerobot.com](https://uptimerobot.com) pe free account banao
2. **Add New Monitor** click karo
3. Monitor Type: **HTTP(s)**
4. URL: `https://YOUR-APP.onrender.com/`
5. Monitoring Interval: **5 minutes**
6. Save karo

Ab tumhara bot 24/7 jaagta rahega!

---

## 🗃️ Database Tables

| Table | Purpose |
|---|---|
| `users` | User data, stats, premium status |
| `files` | File metadata (telegram_file_id, message_id) |
| `daily_stats` | Daily active user tracking |
| `bot_config` | Admin-configurable settings |

---

## ⚙️ Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ Yes | BotFather se mila token |
| `TELEGRAM_STORAGE_CHANNEL_ID` | ✅ Yes | Private channel ID (`-100...`) |
| `ADMIN_ID` | ✅ Yes | Tumhara Telegram user ID |
| `SUPABASE_URL` | ✅ Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✅ Yes | Supabase service role key |
| `PORT` | Auto | Render khud set karta hai — mat dalo |
| `RENDER_EXTERNAL_URL` | Auto | Render khud set karta hai — file links ke liye use hota hai |

---

## 🔒 Why Telegram Storage?

| | Supabase Storage | Telegram Storage |
|---|---|---|
| Free limit | 1 GB | Unlimited |
| HTML serving | `text/plain` (broken) | Correct Content-Type via proxy |
| Data on restart | Safe | Safe (stored in DB) |

---

## 🛠️ Local Development

```bash
# Dependencies install karo
npm install

# .env file banao
cp .env.example .env
# .env me apni values bhar do

# Bot run karo (Express + Bot dono saath)
npm start
```

Bot `http://localhost:3000` pe available hoga.

---

## 👑 Admin Commands

Bot me yeh commands use kar sakte ho (sirf Admin ke liye):

| Command | Description |
|---|---|
| `/viewusers` | Sab users dekho |
| `/viewbanned` | Banned users dekho |
| `/clearbans` | Sab bans clear karo |
| `/help` | Admin help |

Admin panel buttons se aur bhi features hain: Broadcast, Premium, Ban/Unban, etc.

---

## 📜 License

MIT — free to use and modify.
