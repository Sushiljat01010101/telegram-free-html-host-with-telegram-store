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
  ├── bot.cjs                  # Main Telegram bot (Telegraf)
  ├── build.mjs                # esbuild bundler config
  ├── package.json             # Dependencies
  ├── tsconfig.json            # TypeScript config
  ├── supabase-schema.sql      # Run this in Supabase SQL Editor
  ├── .env.example             # Environment variables template
  └── src/
      ├── app.ts               # Express app setup
      ├── index.ts             # Server entry point
      ├── lib/
      │   └── logger.ts        # Pino logger
      └── routes/
          ├── health.ts        # /api/healthz endpoint
          ├── index.ts         # Route registration
          └── view.ts          # /api/view/:userId/:fileName
  ```

  ---

  ## ⚙️ Setup

  ### 1. Prerequisites
  - Node.js 18+, pnpm
  - Telegram Bot (from @BotFather)
  - Supabase project (free tier works)
  - Private Telegram Channel for storage (bot must be admin)

  ### 2. Supabase Setup
  Run `supabase-schema.sql` in your **Supabase SQL Editor**.
  Creates: `users`, `daily_stats`, `bot_config`, `files` tables.
  **No storage bucket needed.**

  ### 3. Telegram Storage Channel
  1. Create a private Telegram channel
  2. Add your bot as Administrator with "Post Messages" permission
  3. Get the channel ID (use @userinfobot) — format: `-100xxxxxxxxxx`

  ### 4. Environment Variables
  Copy `.env.example` to `.env` and fill in your values.

  ### 5. Install and Run

  ```bash
  npm install -g pnpm
  pnpm install
  node bot.cjs
  ```

  ---

  ## 🗃️ Database Tables

  | Table | Purpose |
  |---|---|
  | `users` | User data, stats, premium status |
  | `files` | File metadata (telegram_file_id, message_id) |
  | `daily_stats` | Daily active user tracking |
  | `bot_config` | Admin-configurable settings |

  ---

  ## 🔒 Why Telegram Storage?

  | | Supabase Storage | Telegram Storage |
  |---|---|---|
  | Free limit | 1 GB | Unlimited |
  | HTML serving | text/plain (broken) | Correct Content-Type via proxy |
  | Data on restart | Safe | Safe (stored in DB) |

  ---

  ## 📜 License
  MIT — free to use and modify.