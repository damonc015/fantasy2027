"""Pull projected player stats from ESPN and upsert them into the Supabase players table."""

import os

SEASON = 2027
POSITIONS = {"PG", "SG", "SF", "PF", "C"}
STAT_LABELS = {
    "PTS": "Points",
    "REB": "Rebounds",
    "AST": "Assists",
    "STL": "Steals",
    "BLK": "Blocks",
    "TO": "Turnovers",
    "FGM": "Field goals made",
    "FGA": "Field goals attempted",
    "FGMI": "Field goals missed",
    "FTM": "Free throws made",
    "FTA": "Free throws attempted",
    "FTMI": "Free throws missed",
    "3PM": "Three pointers made",
    "3PA": "Three pointers attempted",
    "3PMI": "Three pointers missed",
    "OREB": "Offensive rebounds",
    "DREB": "Defensive rebounds",
    "DD": "Double doubles",
    "TD": "Triple doubles",
}


def to_row(player, year):
    projected = player.stats.get(f"{year}_projected", {})
    return {
        "id": player.playerId,
        "name": player.name,
        "team": player.proTeam,
        "positions": [slot for slot in player.eligibleSlots if slot in POSITIONS],
        "injury_status": player.injuryStatus if isinstance(player.injuryStatus, str) else None,
        "projections": {
            "fantasy_total": projected.get("applied_total", 0),
            "fantasy_avg": projected.get("applied_avg", 0),
            "avg": projected.get("avg") or {},
            "total": projected.get("total") or {},
        },
    }


def to_scoring(scoring_items):
    from espn_api.basketball.constant import STATS_MAP

    rows = []
    for item in scoring_items:
        stat = STATS_MAP.get(str(item["statId"])) or str(item["statId"])
        rows.append({"stat": stat, "label": STAT_LABELS.get(stat, stat), "points": item["points"]})
    return sorted(rows, key=lambda row: -row["points"])


def main():
    from espn_api.basketball import League
    from supabase import create_client

    league = League(
        league_id=int(os.environ["ESPN_LEAGUE_ID"]),
        year=SEASON,
        espn_s2=os.environ.get("ESPN_S2"),
        swid=os.environ.get("SWID"),
    )
    # Run before the ESPN league drafts, so the whole pool is still in free agents.
    rows = [to_row(player, SEASON) for player in league.free_agents(size=1000)]
    if not rows:
        raise SystemExit("ESPN returned no players")

    supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    supabase.table("players").upsert(rows).execute()
    print(f"Upserted {len(rows)} players")

    # Shown in the app's rules dialog, so it always matches the ESPN league the projections came from.
    scoring = to_scoring(league.settings._raw_scoring_settings.get("scoringItems", []))
    supabase.table("auction").update({"scoring": scoring}).eq("id", True).execute()
    print(f"Saved {len(scoring)} scoring rules")


if __name__ == "__main__":
    main()
