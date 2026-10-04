import pytest

from add_manager import to_email


def test_lowercases_and_trims():
    assert to_email("  Damon ") == "damon@fantasy2027.local"


@pytest.mark.parametrize("username", ["", "a", "two words", "me@gmail.com", "x" * 31])
def test_rejects_invalid_usernames(username):
    with pytest.raises(ValueError):
        to_email(username)


def test_records_account_with_header_once(tmp_path):
    from add_manager import record_account

    path = tmp_path / "accounts.md"
    record_account(path, "damon", "Damon", "pw1")
    record_account(path, "sam", "Sam", "pw2")
    lines = path.read_text().splitlines()
    assert lines[0] == "| Username | Display name | Password | Created |"
    assert len(lines) == 4
    assert lines[2].startswith("| damon | Damon | pw1 | ")
    assert lines[3].startswith("| sam | Sam | pw2 | ")
