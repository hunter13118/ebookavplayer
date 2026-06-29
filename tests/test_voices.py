"""Per-character voice assignment (pure)."""
from server.audio.edge_voice_catalog import NATURAL_MALE
from server.audio.voices import assign_voices, narrator_voice


def _chars(n_male):
    base = [
        {"id": "elara", "gender": "female", "age": "young", "importance": "primary"},
        {"id": "garrick", "gender": "male", "age": "adult", "importance": "primary"},
        {"id": "old_tom", "gender": "male", "age": "old", "importance": "secondary"},
        {"id": "kid", "gender": "male", "age": "child", "importance": "secondary"},
    ]
    base += [{"id": f"m{i}", "gender": "male", "age": "adult",
              "importance": "background"} for i in range(n_male)]
    return base


def test_primaries_get_distinct_base_voices():
    a = assign_voices(_chars(0))
    assert a["elara"]["voice"] != a["garrick"]["voice"]


def test_child_pitched_up_old_pitched_down():
    a = assign_voices(_chars(0))
    kid_hz = int(a["kid"]["pitch"].rstrip("Hz").replace("+", ""))
    old_hz = int(a["old_tom"]["pitch"].rstrip("Hz").replace("+", ""))
    assert kid_hz > old_hz


def test_collision_shift_on_pool_wrap():
    a = assign_voices(_chars(len(NATURAL_MALE) + 1))
    shifted = [v for k, v in a.items() if k.startswith("m") and v["pitch"] != "+0Hz"]
    assert shifted, "expected at least one collision pitch shift"


def test_narrator_voice():
    assert "Neural" in narrator_voice("male")
    assert narrator_voice("female") != narrator_voice("male")


def test_female_characters_get_female_voices():
    a = assign_voices(_chars(0))
    assert "Jenny" in a["elara"]["voice"] or "Aria" in a["elara"]["voice"] or "Ava" in a["elara"]["voice"] or "Emma" in a["elara"]["voice"]
