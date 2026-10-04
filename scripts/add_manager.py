"""Create a manager: a username/password login plus its managers row."""

import argparse
import os
import re
import secrets
from datetime import date
from pathlib import Path

# Supabase Auth needs an email. Nobody sees this address and nothing is ever sent to it.
# Must match LOGIN_DOMAIN in web/src/App.tsx.
LOGIN_DOMAIN = "fantasy2027.local"
USERNAME = re.compile(r"[a-z0-9_.-]{2,30}")
# Gitignored. Holds plaintext passwords so they can be handed to each manager.
ACCOUNTS_FILE = Path(__file__).resolve().parent.parent / "accounts.md"


def to_email(username):
    username = username.strip().lower()
    if not USERNAME.fullmatch(username):
        raise ValueError("Username must be 2 to 30 characters: letters, digits, _ . -")
    return f"{username}@{LOGIN_DOMAIN}"


def record_account(path, username, name, password):
    path = Path(path)
    if not path.exists():
        path.write_text("| Username | Display name | Password | Created |\n|---|---|---|---|\n")
        path.chmod(0o600)
    with path.open("a") as file:
        file.write(f"| {username} | {name} | {password} | {date.today()} |\n")


def main():
    from supabase import create_client

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("username")
    parser.add_argument("--name", help="display name, defaults to the username")
    parser.add_argument("--password", help="defaults to a generated one")
    parser.add_argument("--discord-id", help="numeric Discord user id for outbid mentions")
    args = parser.parse_args()

    try:
        email = to_email(args.username)
    except ValueError as error:
        raise SystemExit(str(error))
    username = email.split("@")[0]
    name = args.name or username
    password = args.password or secrets.token_urlsafe(9)

    supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    user = supabase.auth.admin.create_user({"email": email, "password": password, "email_confirm": True}).user
    try:
        supabase.table("managers").insert(
            {"id": user.id, "name": name, "discord_user_id": args.discord_id}
        ).execute()
    except Exception:
        supabase.auth.admin.delete_user(user.id)
        raise
    record_account(ACCOUNTS_FILE, username, name, password)
    print(f"Created manager '{username}'. Password saved in {ACCOUNTS_FILE.name}")


if __name__ == "__main__":
    main()
