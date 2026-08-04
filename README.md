# The Free Agents — League Website + Admin Console

A rebuilt, easy-to-update website for **The Free Agents** fantasy football league.
It comes in two halves:

- **The public site** your league sees — a Teams page (with each team's roster and
  championship trophies) and a Rules / Constitution page, styled in a fun retro
  comic-book look to match your banner.
- **A password-protected admin console** where you (the commissioner) edit
  everything through simple forms. Changes go live on the site instantly — no
  code, no re-uploading files.

Everything is stored in a small self-contained database file, so there is no
external service to sign up for.

---

## What you can edit from the admin console

- **Teams** — add/remove teams, set the owner, tagline, and championship years
  (each year shows as a 🏆 trophy).
- **Rosters** — for each team, add players under the four sections
  (Contract Players, NCAA Contracts, Taxi Squad, NCAA Players) and list each
  player's year-by-year salary.
- **Rules & Constitution** — edit the full rules page using simple formatting.
- **Settings** — site title, subtitle, footer, upload your banner image, and
  change your admin password.

---

## Quick start (run it on your own computer first)

You'll need **Node.js version 22.5 or newer** installed (free from
<https://nodejs.org> — pick the "LTS" or newer). Then, in a terminal:

```bash
cd thefreeagents-site

# 1. Install the building blocks
npm install

# 2. Create your settings file, then open ".env" and set a username/password
cp .env.example .env

# 3. Create the database + your admin login + starter content
npm run seed

# 4. Start the site
npm start
```

Now open:

- **Public site:** <http://localhost:3000>
- **Admin console:** <http://localhost:3000/admin>
  (log in with the `ADMIN_USER` / `ADMIN_PASS` you set in `.env`)

> The starter data includes all ten team names from your current site and one
> fully filled-in sample roster (Sustained Excellence) so you can see how
> everything looks. Edit or replace it from the admin console.

---

## The `.env` settings file

Copy `.env.example` to `.env` and adjust:

| Setting          | What it's for                                                        |
|------------------|----------------------------------------------------------------------|
| `PORT`           | The port the site runs on. Most hosts set this for you.              |
| `SESSION_SECRET` | A long random string that secures logins. **Change this.**          |
| `ADMIN_USER`     | The username for your first admin login.                             |
| `ADMIN_PASS`     | The password for that login (you can change it later in Settings).  |
| `DATA_DIR`       | *(Optional)* Folder where the database is stored. Handy for hosts   |
|                  | that give you a persistent disk — point this at it.                 |

You only need `ADMIN_USER` / `ADMIN_PASS` the first time you run `npm run seed`.
After that, change your password from the **Settings** page in the console.

---

## Putting it online

Because it saves data automatically, the site needs a host that can run a small
Node.js app (plain static hosting like your old NetObjects setup can't do that).
Good low-cost / free-tier options: **Render**, **Railway**, or **Fly.io**.

General steps (using Render as an example):

1. Put this folder in a GitHub repository.
2. On Render, create a **New Web Service** and point it at that repo.
3. Set **Build command** to `npm install && npm run seed`
   and **Start command** to `npm start`.
4. Add your environment variables (`SESSION_SECRET`, `ADMIN_USER`, `ADMIN_PASS`)
   in Render's dashboard.
5. To keep your data between deploys, add a **persistent disk** and set
   `DATA_DIR` to its mount path (e.g. `/data`). *Important:* after the first
   successful deploy, change the Build command to just `npm install` so it does
   not re-seed and overwrite your data.
6. Point your domain **thefreeagents.org** at the service (Render gives you the
   DNS records to add at your domain registrar).

If you'd like, I can walk you through the hosting step-by-step and tailor these
instructions to whichever host you pick.

---

## A couple of notes

- **Player images:** your old site used lots of individual player cutouts. The
  new design shows clean player cards with names + salaries by default, and you
  can optionally upload a banner image per team. If you want per-player images
  too, I can add that — just ask.
- **Backups:** your whole site's content is the single file in the `data`
  folder (`freeagents.db`). Copy it somewhere safe now and then and you'll never
  lose anything.
- **Not deleted by accident:** empty player rows are ignored when you save, so
  you can leave blanks while editing.

Questions or want changes to the look or features? Just say the word.
