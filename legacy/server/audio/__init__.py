from .edge_tts import synthesize_edge_mp3, synthesize_edge_mp3_sync, list_edge_voices
from .edge_voice_catalog import NATURAL_FEMALE, NATURAL_MALE, pool_for_gender
from .voices import assign_voices, narrator_voice

# Back-compat alias
VOICE_POOL = {"male": NATURAL_MALE, "female": NATURAL_FEMALE, "neutral": NATURAL_MALE[:2]}
