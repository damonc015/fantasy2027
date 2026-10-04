from types import SimpleNamespace

from import_players import to_row


def make_player(**overrides):
    base = dict(
        playerId=3032977,
        name="Giannis Antetokounmpo",
        proTeam="MIL",
        eligibleSlots=["PF", "C", "F", "UT", "BE", "IR"],
        injuryStatus="ACTIVE",
        stats={
            "2027_projected": {
                "applied_total": 3900.0,
                "applied_avg": 55.71,
                "avg": {"PTS": 30.1, "REB": 11.8},
                "total": {"PTS": 2107.0, "REB": 826.0},
            },
            "2026_total": {"applied_total": 1.0, "applied_avg": 1.0, "avg": {"PTS": 1.0}, "total": {"PTS": 1.0}},
        },
    )
    return SimpleNamespace(**{**base, **overrides})


def test_maps_player_to_row():
    assert to_row(make_player(), 2027) == {
        "id": 3032977,
        "name": "Giannis Antetokounmpo",
        "team": "MIL",
        "positions": ["PF", "C"],
        "injury_status": "ACTIVE",
        "projections": {
            "fantasy_total": 3900.0,
            "fantasy_avg": 55.71,
            "avg": {"PTS": 30.1, "REB": 11.8},
            "total": {"PTS": 2107.0, "REB": 826.0},
        },
    }


def test_missing_projection_and_injury_status():
    row = to_row(make_player(stats={}, injuryStatus=[]), 2027)
    assert row["injury_status"] is None
    assert row["projections"] == {"fantasy_total": 0, "fantasy_avg": 0, "avg": {}, "total": {}}
