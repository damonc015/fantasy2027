"""Pull projected player stats from ESPN and upsert them into the Supabase players table."""

import os

SEASON = 2027
POSITIONS = {"PG", "SG", "SF", "PF", "C"}


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


if __name__ == "__main__":
    main()
