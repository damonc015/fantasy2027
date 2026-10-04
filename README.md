# Fantasy 2027 Slow Auction

Private slow auction draft for a fantasy basketball league. Supabase is the whole backend, `web/` is a static React app, `scripts/` imports ESPN projections.

## Rules enforced by the database

- Each manager has a budget (default $20,000).
- A bid must be higher than the current high bid. Ties lose.
- Leading bids lock budget. Each manager must keep $1 per remaining empty roster spot.
- A manager cannot lead more players than `auction.roster_size`.
- No bids at or after `auction.closes_at`. Leading bids at that time are the winners.

All of this lives in `place_bid` in `supabase/migrations/`. It is the only way to write a bid.

## Setup

1. Create a Supabase project, then push the schema:
   ```sh
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
2. In the Supabase dashboard, disable public signups (Authentication, Sign In / Providers, "Allow new users to sign up"). Then create one login per manager. Managers sign in with a username and password, no email:
   ```sh
   set -a; source .env.local; set +a
   .venv/bin/python scripts/add_manager.py damon --name "Damon" --discord-id 123456789012345678
   ```
   The script generates a password (or takes `--password`) and appends the login to `accounts.md`, which is gitignored and holds plaintext passwords. There is no "forgot password" flow: reset a password in the dashboard (Authentication, Users).
3. In the SQL editor, add the auction and the Discord webhook:
   ```sql
   insert into auction (closes_at, roster_size) values ('2026-10-18 21:00-04', 13);

   select vault.create_secret('https://discord.com/api/webhooks/...', 'discord_webhook_url');
   ```
   `discord_user_id` is the numeric id (Discord developer mode, right click a user, Copy User ID). Without the vault secret, outbid notifications are skipped.
4. Import players. Create a throwaway ESPN league for the 2027 season with the scoring format you want projections for, and run this before that league drafts:
   ```sh
   python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
   ESPN_LEAGUE_ID=... ESPN_S2=... SWID=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
     .venv/bin/python scripts/import_players.py
   ```
   `ESPN_S2` and `SWID` are cookies from espn.com, needed for private leagues. Add the same five values as GitHub Actions secrets to run the import daily.
5. Run the web app (Node 22.12 or newer):
   ```sh
   cd web && cp .env.example .env.local   # fill in the project URL and anon key
   npm install && npm run dev
   ```
   Deploy `web/` to any static host with build command `npm run build` and output directory `dist`.

To run another round for unsold players, update `auction.closes_at` to a new deadline.

## Tests

```sh
npx supabase db start && npx supabase test db   # bid rules, needs Docker
.venv/bin/python -m pytest scripts               # ESPN mapping
```
