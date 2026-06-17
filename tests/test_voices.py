"""Per-character voice assignment (pure)."""
from server.audio.voices import assign_voices, narrator_voice, VOICE_POOL


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
    assert a["kid"]["pitch"].startswith("+")
    assert a["old_tom"]["pitch"].startswith("-")


def test_collision_shift_on_pool_wrap():
    # enough males to wrap the male pool -> later ones get a pitch shift
    a = assign_voices(_chars(len(VOICE_POOL["male"]) + 1))
    shifted = [v for k, v in a.items() if k.startswith("m") and v["pitch"] != "+0Hz"]
    assert shifted, "expected at least one collision pitch shift"


def test_narrator_voice():
    assert "Neural" in narrator_voice("male")
    assert narrator_voice("female") != narrator_voice("male")
